// =====================================================================
// Cube Tickets — slash-command edition
// =====================================================================
// All user-facing commands are slash commands. Prefix `!` is gone.
// Commands are registered globally on startup; `/deadlines` is also
// installed as a User Install command so it works in DMs / group DMs.
// State lives entirely in Discord (channel topics, permission
// overwrites) so the bot can be restarted at any time without losing
// context — no DB, no Worker, no file persistence.
// =====================================================================

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  AttachmentBuilder,
  SlashCommandBuilder,
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const chrono = require('chrono-node');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// =====================================================================
// CONSTANTS
// =====================================================================

const FOUNDER_ROLE_ID = '1095002049713807390';
const STAFF_ROLE_ID = '1459610315863101735';
// RTG (game-audit team). Every member with this role is auto-added
// to a /audit ticket when one is created.
const RTG_ROLE_ID = '1192095351876894740';

const TALK_CATEGORY_NAME = 'TALK';
const TICKET_CATEGORY_NAME = 'TICKETS';
const AUDIT_CATEGORY_NAME = 'AUDITS';

// Priority dot emojis prefixed onto the channel name based on how
// many days are left until the deadline. Ordered most-to-least urgent.
const PRIORITY_DOTS = ['🔴', '🟡', '🟢'];

const TICKET_PERMS = {
  allow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ],
};
const BOT_PERMS = {
  allow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageChannels,
  ],
};

// =====================================================================
// IN-MEMORY STATE — rebuilt from channel topics on startup
// =====================================================================

// channelId -> deadline timestamp (ms)
const dueByMap = new Map();
// channelId -> setTimeout handle for the per-channel exact-expiry
// trigger. Cleared when the deadline is reset, the channel is
// deleted, or the timeout fires.
const dueByTimers = new Map();

// =====================================================================
// HELPERS
// =====================================================================

function safeUsernameSlug(member) {
  return member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function isTalkChannel(channel) {
  if (!channel) return false;
  if (channel.name && channel.name.includes('talk-')) return true;
  if (
    channel.parent &&
    channel.parent.name &&
    channel.parent.name.toUpperCase() === TALK_CATEGORY_NAME
  ) {
    return true;
  }
  return false;
}

function isOrderChannel(channel) {
  if (!channel) return false;
  if (channel.name && channel.name.includes('ticket-')) return true;
  if (
    channel.parent &&
    channel.parent.name &&
    channel.parent.name.toUpperCase() === TICKET_CATEGORY_NAME
  ) {
    return true;
  }
  return false;
}

function isAuditChannel(channel) {
  if (!channel) return false;
  if (channel.name && channel.name.includes('audit-')) return true;
  if (
    channel.parent &&
    channel.parent.name &&
    channel.parent.name.toUpperCase() === AUDIT_CATEGORY_NAME
  ) {
    return true;
  }
  return false;
}

function isAnyTicketChannel(channel) {
  return (
    isTalkChannel(channel) ||
    isOrderChannel(channel) ||
    isAuditChannel(channel)
  );
}

function canManage(member) {
  if (!member) return false;
  if (member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  if (!member.roles || !member.roles.cache) return false;
  if (member.roles.cache.has(FOUNDER_ROLE_ID)) return true;
  if (member.roles.cache.has(STAFF_ROLE_ID)) return true;
  return false;
}

// Recover the original ticket owner from a channel's permission
// overwrites. The talk/ticket channel pins exactly one Member-type
// override that isn't the bot — that's the client.
function findTicketOwner(channel, botId) {
  const override = channel.permissionOverwrites.cache.find(
    (po) => po.type === OverwriteType.Member && po.id !== botId,
  );
  return override ? override.id : null;
}

// Strip every leading priority dot from a channel name (so we can
// re-prefix it with the current one without doubling up).
function stripPriorityDots(name) {
  let out = name;
  for (const dot of PRIORITY_DOTS) {
    while (out.startsWith(dot)) out = out.slice(dot.length);
  }
  return out;
}

// Decide which priority dot a deadline gets right now.
//   ≤1 day  →  🔴  (high — last day or less)
//   1-3 days → 🟡  (medium — covers "2 days" and the 2-3 day band)
//   ≥3 days →  🟢  (normal)
// Returns null when the deadline has already passed.
function priorityDotForDeadline(deadlineMs) {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return null;
  const days = remaining / (24 * 60 * 60 * 1000);
  if (days <= 1.0) return '🔴';
  if (days < 3.0) return '🟡';
  return '🟢';
}

// Read up to 5 User options off an interaction and return them as
// a deduplicated array. Slash commands don't support User arrays,
// so /redirect /addticket /removeticket /ticket each declare
// designer1/designer2/... as separate optional User options. This
// helper collapses them back into a single list.
function collectUserOptions(interaction, baseName, max = 5) {
  const users = [];
  for (let i = 1; i <= max; i++) {
    const u = interaction.options.getUser(baseName + i);
    if (!u) continue;
    if (users.find((x) => x.id === u.id)) continue;
    users.push(u);
  }
  return users;
}

// Natural-language deadline parser. Tries Portuguese chrono first
// (handles "amanhã", "hoje", "próxima segunda"), falls back to
// English/casual chrono (handles "tomorrow", "2 days", "1 week 3
// days", "12h", "may 3", "2026-05-03", etc.), and finally a small
// PT-BR shorthand regex for the cases chrono.pt doesn't cover yet
// ("2 dias", "3 horas", "1 semana", "30 min").
function parseDeadline(input) {
  if (!input) return null;
  const text = input.trim();
  if (!text) return null;

  // Step 1: Portuguese chrono
  try {
    const ptParsed = chrono.pt.parseDate(text, new Date(), {
      forwardDate: true,
    });
    if (ptParsed) return ptParsed;
  } catch (e) {}

  // Step 2: English / casual chrono
  try {
    const enParsed = chrono.casual.parseDate(text, new Date(), {
      forwardDate: true,
    });
    if (enParsed) return enParsed;
  } catch (e) {}

  // Step 3: PT-BR shorthand fallback ("2 dias", "3 horas", etc.)
  const m = text
    .toLowerCase()
    .match(/^(\d+)\s*(minutos?|mins?|m|horas?|h|dias?|d|semanas?|sem|w|meses?|mes)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const u = m[2];
    let ms = 0;
    if (/^min/.test(u) || u === 'm') ms = n * 60 * 1000;
    else if (/^hora/.test(u) || u === 'h') ms = n * 60 * 60 * 1000;
    else if (/^dia/.test(u) || u === 'd') ms = n * 24 * 60 * 60 * 1000;
    else if (/^sem/.test(u) || u === 'w') ms = n * 7 * 24 * 60 * 60 * 1000;
    else if (/^mes/.test(u) || /^mese/.test(u)) {
      ms = n * 30 * 24 * 60 * 60 * 1000;
    }
    if (ms > 0) return new Date(Date.now() + ms);
  }

  return null;
}

// (formatRemaining was dropped — Discord's <t:X:R> relative
// timestamp handles the human label natively in the user's locale,
// and we kept getting drift between our floor-division "2 days"
// and Discord's rounded "3 days" view of the same moment.)

// =====================================================================
// DUEBY — channel topic schema, scheduling, daily reminder
// =====================================================================
// We persist the deadline in channel.topic as `dueby:<unix-ms>`. The
// bot scans every TICKETS channel on startup, rebuilds dueByMap from
// those topics, and re-schedules the per-channel expiry timeouts.

async function setChannelDueby(channel, deadlineMs) {
  // Preserve any other tags in the topic (none today, but future-
  // proof) by replacing or appending the dueby key only.
  const currentTopic = channel.topic || '';
  const stripped = currentTopic.replace(/dueby:\d+\s*/g, '').trim();
  const newTopic = ('dueby:' + deadlineMs + (stripped ? ' ' + stripped : '')).slice(0, 1024);
  try {
    await channel.setTopic(newTopic);
  } catch (e) {
    console.error('setChannelDueby topic error:', e);
  }
  dueByMap.set(channel.id, deadlineMs);
  scheduleDueByExpiry(channel.id, deadlineMs);
  await applyPriorityDot(channel, deadlineMs);
}

async function clearChannelDueby(channel) {
  const currentTopic = channel.topic || '';
  const stripped = currentTopic.replace(/dueby:\d+\s*/g, '').trim();
  try {
    await channel.setTopic(stripped);
  } catch (e) {
    console.error('clearChannelDueby topic error:', e);
  }
  dueByMap.delete(channel.id);
  if (dueByTimers.has(channel.id)) {
    clearTimeout(dueByTimers.get(channel.id));
    dueByTimers.delete(channel.id);
  }
  await removePriorityDot(channel);
}

function readDueByFromTopic(channel) {
  if (!channel || !channel.topic) return null;
  const m = channel.topic.match(/dueby:(\d+)/);
  if (!m) return null;
  const ts = parseInt(m[1], 10);
  if (isNaN(ts)) return null;
  return ts;
}

// Schedule (or replace) the per-channel setTimeout that fires at the
// EXACT moment a deadline expires. When it fires, the dot is pulled
// off the channel name immediately — we don't wait for the next 6am.
function scheduleDueByExpiry(channelId, deadlineMs) {
  if (dueByTimers.has(channelId)) {
    clearTimeout(dueByTimers.get(channelId));
    dueByTimers.delete(channelId);
  }
  const ms = deadlineMs - Date.now();
  if (ms <= 0) {
    handleDueByExpiry(channelId).catch((e) =>
      console.error('handleDueByExpiry error:', e),
    );
    return;
  }
  // setTimeout's max delay is ~24.8 days; for anything past that
  // chain a re-schedule when the inner timeout fires.
  const MAX = 2 ** 31 - 1;
  if (ms > MAX) {
    const t = setTimeout(() => {
      dueByTimers.delete(channelId);
      scheduleDueByExpiry(channelId, deadlineMs);
    }, MAX);
    dueByTimers.set(channelId, t);
    return;
  }
  const t = setTimeout(() => {
    dueByTimers.delete(channelId);
    handleDueByExpiry(channelId).catch((e) =>
      console.error('handleDueByExpiry error:', e),
    );
  }, ms);
  dueByTimers.set(channelId, t);
}

async function handleDueByExpiry(channelId) {
  dueByMap.delete(channelId);
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  await removePriorityDot(channel);
  // Strip dueby tag from topic but keep anything else.
  const stripped = (channel.topic || '').replace(/dueby:\d+\s*/g, '').trim();
  try {
    if (stripped !== channel.topic) await channel.setTopic(stripped);
  } catch (e) {
    /* topic edit may fail if perms changed; non-fatal */
  }
}

async function applyPriorityDot(channel, deadlineMs) {
  if (!channel) return;
  const dot = priorityDotForDeadline(deadlineMs);
  const stripped = stripPriorityDots(channel.name);
  const target = dot ? dot + stripped : stripped;
  if (target !== channel.name) {
    try {
      await channel.setName(target);
    } catch (e) {
      // Discord rate-limits channel renames hard (2 per 10 min).
      // Failures here are loud but recoverable on the next 6am pass.
      console.error('applyPriorityDot rename failed:', e?.message);
    }
  }
}

async function removePriorityDot(channel) {
  if (!channel) return;
  const stripped = stripPriorityDots(channel.name);
  if (stripped !== channel.name) {
    try {
      await channel.setName(stripped);
    } catch (e) {
      console.error('removePriorityDot rename failed:', e?.message);
    }
  }
}

async function rebuildDueByQueue() {
  for (const [, guild] of client.guilds.cache) {
    const channels = guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText && isOrderChannel(c),
    );
    for (const ch of channels.values()) {
      const ts = readDueByFromTopic(ch);
      if (ts == null) continue;
      if (ts <= Date.now()) {
        // Already expired — clean it up.
        await handleDueByExpiry(ch.id);
        continue;
      }
      dueByMap.set(ch.id, ts);
      scheduleDueByExpiry(ch.id, ts);
    }
  }
  console.log(
    'Rebuilt dueByMap with ' + dueByMap.size + ' active deadline(s).',
  );
}

// =====================================================================
// 6 AM DAILY REMINDER
// =====================================================================

async function dailyDueByCheck() {
  console.log('Daily 6am dueby check firing...');
  for (const [channelId, deadlineMs] of dueByMap.entries()) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      dueByMap.delete(channelId);
      continue;
    }
    if (deadlineMs <= Date.now()) {
      await handleDueByExpiry(channelId);
      continue;
    }

    // Re-apply the dot (in case Discord renamed the channel during
    // a manual edit — keeps every active ticket in sync).
    await applyPriorityDot(channel, deadlineMs);

    // Identify designers in the ticket: every Member-type override
    // that isn't the bot or the ticket owner. Founder/Staff are
    // ROLE-type overrides, so they don't show up here — they're
    // pinged via their roles separately if needed.
    const ownerId = findTicketOwner(channel, client.user.id);
    const designerIds = channel.permissionOverwrites.cache
      .filter(
        (po) =>
          po.type === OverwriteType.Member &&
          po.id !== client.user.id &&
          po.id !== ownerId,
      )
      .map((po) => po.id);

    if (designerIds.length === 0) continue; // no one to ping

    const dot = priorityDotForDeadline(deadlineMs) || '⚪';
    const color =
      dot === '🔴' ? 0xef4444 : dot === '🟡' ? 0xf59e0b : 0x22c55e;

    const designerMentions = designerIds.map((id) => '<@' + id + '>').join(' ');
    const ownerMention = ownerId ? '<@' + ownerId + '>' : '(unknown)';
    const tsSec = Math.floor(deadlineMs / 1000);

    const embed = new EmbedBuilder()
      .setTitle(dot + ' Deadline reminder')
      .setDescription(
        'Deadline for this project: <t:' + tsSec + ':R>\n\n' +
          'Client: ' + ownerMention + '\n' +
          'Designer(s): ' + designerMentions + '\n' +
          'Full date: <t:' + tsSec + ':F>',
      )
      .setColor(color);

    try {
      await channel.send({ content: designerMentions, embeds: [embed] });
    } catch (e) {
      console.error('dailyDueByCheck send error:', e?.message);
    }
  }
}

function scheduleNext6am() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next.getTime() - now.getTime();
  console.log(
    'Next dueby reminder at ' + next.toISOString() + ' (' + ms + 'ms)',
  );
  setTimeout(async () => {
    try {
      await dailyDueByCheck();
    } catch (e) {
      console.error('dailyDueByCheck error:', e);
    }
    setInterval(() => {
      dailyDueByCheck().catch((e) =>
        console.error('dailyDueByCheck interval error:', e),
      );
    }, 24 * 60 * 60 * 1000);
  }, ms);
}

// =====================================================================
// CHANNEL DELETE — cleanup
// =====================================================================

client.on(Events.ChannelDelete, (channel) => {
  if (dueByMap.has(channel.id)) dueByMap.delete(channel.id);
  if (dueByTimers.has(channel.id)) {
    clearTimeout(dueByTimers.get(channel.id));
    dueByTimers.delete(channel.id);
  }
});

// =====================================================================
// SLASH COMMAND DEFINITIONS
// =====================================================================

const slashCommands = [
  new SlashCommandBuilder()
    .setName('ordermsg')
    .setDescription('Post the order banner with the Open-a-Ticket button')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription(
      'Manually open a TICKETS-category project ticket for a user',
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Client the ticket is for')
        .setRequired(true),
    )
    .addUserOption((opt) =>
      opt.setName('designer1').setDescription('Designer #1').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('designer2').setDescription('Designer #2').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('designer3').setDescription('Designer #3').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('designer4').setDescription('Designer #4').setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close the current ticket (talk OR order)')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('redirect')
    .setDescription(
      'Inside a talk: spin up a TICKETS-category channel for this client + chosen designer(s)',
    )
    .addUserOption((opt) =>
      opt.setName('designer1').setDescription('Designer #1').setRequired(true),
    )
    .addUserOption((opt) =>
      opt.setName('designer2').setDescription('Designer #2').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('designer3').setDescription('Designer #3').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('designer4').setDescription('Designer #4').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('designer5').setDescription('Designer #5').setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('addticket')
    .setDescription('Add user(s) to the current ticket')
    .addUserOption((opt) =>
      opt.setName('user1').setDescription('User #1').setRequired(true),
    )
    .addUserOption((opt) =>
      opt.setName('user2').setDescription('User #2').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('user3').setDescription('User #3').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('user4').setDescription('User #4').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('user5').setDescription('User #5').setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('removeticket')
    .setDescription("Remove user(s) from the current ticket")
    .addUserOption((opt) =>
      opt.setName('user1').setDescription('User #1').setRequired(true),
    )
    .addUserOption((opt) =>
      opt.setName('user2').setDescription('User #2').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('user3').setDescription('User #3').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('user4').setDescription('User #4').setRequired(false),
    )
    .addUserOption((opt) =>
      opt.setName('user5').setDescription('User #5').setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('dueby')
    .setDescription(
      'Set / show / clear the deadline for the current ticket',
    )
    .addStringOption((opt) =>
      opt
        .setName('when')
        .setDescription(
          'Natural-language duration (e.g. "2 days", "tomorrow", "may 3"), or "clear"',
        )
        .setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('attach')
    .setDescription(
      'Attach a file to the ticket (your interaction stays private)',
    )
    .addAttachmentOption((opt) =>
      opt
        .setName('file')
        .setDescription('File to attach')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('note')
        .setDescription('Optional note to include with the file')
        .setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('audit')
    .setDescription(
      'Open a game-audit ticket for a user (RTG team auto-added)',
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('User the audit is for')
        .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('sample')
    .setDescription("Show a designer's sample work — works in DMs too")
    .addStringOption((opt) =>
      opt
        .setName('designer')
        .setDescription('Pick a designer')
        .setRequired(true)
        .addChoices(
          { name: 'S0da', value: 's0da' },
          { name: 'Will', value: 'willian' },
          { name: 'Nosher', value: 'nosher' },
          { name: 'Trispil', value: 'trispil' },
        ),
    )
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall,
    )
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('deadlines')
    .setDescription(
      "Show your active deadlines (or someone else's) — works in DMs too",
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('User to check (defaults to you)')
        .setRequired(false),
    )
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall,
    )
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands')
    .toJSON(),
];

async function registerSlashCommands() {
  try {
    // If DEV_GUILD_ID is set, register the commands as GUILD
    // commands on that single guild — guild commands propagate
    // instantly (no Discord cache delay), so iteration during
    // development doesn't cost up to an hour each push.
    // If unset, register GLOBALLY (proper for production).
    const devGuildId = process.env.DEV_GUILD_ID;
    if (devGuildId) {
      const guild = await client.guilds.fetch(devGuildId).catch(() => null);
      if (guild) {
        await guild.commands.set(slashCommands);
        console.log(
          'Registered ' +
            slashCommands.length +
            ' slash commands on guild "' +
            guild.name +
            '" (instant; DEV_GUILD_ID set).',
        );
        return;
      }
      console.warn(
        'DEV_GUILD_ID set but guild fetch failed — falling through to global registration.',
      );
    }
    await client.application.commands.set(slashCommands);
    console.log(
      'Registered ' +
        slashCommands.length +
        ' slash commands globally (may take up to 1 hour to propagate).',
    );
  } catch (e) {
    console.error('Failed to register slash commands:', e);
  }
}

// =====================================================================
// READY
// =====================================================================

client.once('ready', async () => {
  console.log('Bot online as ' + client.user.tag);
  client.user.setActivity('Cube Graphics Orders', { type: 3 });

  await registerSlashCommands();
  await rebuildDueByQueue();
  scheduleNext6am();
});

// =====================================================================
// INTERACTION HANDLER
// =====================================================================

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    try {
      await handleSlashCommand(interaction);
    } catch (e) {
      console.error('Slash command error:', e);
      const reply = {
        content: '❌ Something broke. Check the logs.',
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'open_ticket') {
      await handleOpenTicketButton(interaction);
    } else if (interaction.customId === 'close_ticket') {
      await handleCloseTicketButton(interaction);
    }
  }
});

async function handleSlashCommand(interaction) {
  const name = interaction.commandName;
  switch (name) {
    case 'ordermsg':
      return cmdOrderMsg(interaction);
    case 'ticket':
      return cmdTicket(interaction);
    case 'close':
      return cmdClose(interaction);
    case 'redirect':
      return cmdRedirect(interaction);
    case 'addticket':
      return cmdAddTicket(interaction);
    case 'removeticket':
      return cmdRemoveTicket(interaction);
    case 'dueby':
      return cmdDueBy(interaction);
    case 'attach':
      return cmdAttach(interaction);
    case 'audit':
      return cmdAudit(interaction);
    case 'sample':
      return cmdSample(interaction);
    case 'deadlines':
      return cmdDeadlines(interaction);
    case 'help':
      return cmdHelp(interaction);
    default:
      return interaction.reply({
        content: 'Unknown command.',
        flags: MessageFlags.Ephemeral,
      });
  }
}

// =====================================================================
// COMMAND IMPLEMENTATIONS
// =====================================================================

async function cmdOrderMsg(interaction) {
  if (
    !interaction.member ||
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply({
      content: 'Only admins can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply({
    content: '✅ Posting the order banner...',
    flags: MessageFlags.Ephemeral,
  });

  let bannerFile = null;
  try {
    if (fs.existsSync('./ORDER_NOW_-_BANNER.png')) {
      bannerFile = new AttachmentBuilder('./ORDER_NOW_-_BANNER.png', {
        name: 'banner.png',
      });
    }
  } catch (e) {
    /* embed renders fine without the banner */
  }

  const orderEmbed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setDescription(
      '<:Blue_Ticket:1415843891894026271> **READY TO BOOST YOUR GAME?** <:Blue_Ticket:1415843891894026271>\n\n' +
        '<:j_dot:1415844475120386230> Open a ticket and our team will craft **stunning thumbnails and icons** that beat the algorithm.\n\n' +
        '<:j_dot:1415844475120386230> Hand-crafted by vetted artists. qPTR-tested. Shipped fast.\n\n' +
        '[cubegraphics.org](http://cubegraphics.org)',
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_ticket')
      .setLabel('🎫 Open a Ticket')
      .setStyle(ButtonStyle.Primary),
  );

  if (bannerFile) orderEmbed.setImage('attachment://banner.png');

  const sendOptions = { embeds: [orderEmbed], components: [row] };
  if (bannerFile) sendOptions.files = [bannerFile];

  await interaction.channel.send(sendOptions);
}

async function cmdTicket(interaction) {
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: 'Only founders, staff, or admins can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const target = interaction.options.getUser('user');
  const member = await interaction.guild.members
    .fetch(target.id)
    .catch(() => null);
  if (!member) {
    return interaction.reply({
      content: 'User is not in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Optional designer slots (designer1-designer4) — admin can pre-
  // assign designers if they already know who's working it. Empty
  // list is fine; founder/staff get the welcome ping in that case.
  const designerUsers = collectUserOptions(interaction, 'designer', 4);
  const designerMembers = [];
  for (const u of designerUsers) {
    if (u.id === member.id || u.id === client.user.id) continue;
    const m = await interaction.guild.members.fetch(u.id).catch(() => null);
    if (m) designerMembers.push(m);
  }

  const channel = await createOrderTicket(
    interaction.guild,
    member,
    designerMembers,
  );
  if (channel) {
    return interaction.editReply({
      content:
        '✅ Project ticket created for ' +
        member.displayName +
        ': <#' +
        channel.id +
        '>' +
        (designerMembers.length
          ? ' (' + designerMembers.length + ' designer(s) attached)'
          : ''),
    });
  }
  return interaction.editReply({
    content: '❌ Could not create the ticket.',
  });
}

async function cmdClose(interaction) {
  if (!isAnyTicketChannel(interaction.channel)) {
    return interaction.reply({
      content: 'This command only works inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Ticket Closing')
        .setDescription('This ticket will be deleted in 5 seconds.')
        .setColor(0xef4444),
    ],
  });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

async function cmdRedirect(interaction) {
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: 'Only founders, staff, or admins can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!isTalkChannel(interaction.channel)) {
    return interaction.reply({
      content: 'This command only works inside a talk channel.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const designerUsers = collectUserOptions(interaction, 'designer', 5);
  if (designerUsers.length === 0) {
    return interaction.reply({
      content: 'Pick at least one designer.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const ownerId = findTicketOwner(interaction.channel, client.user.id);
  if (!ownerId) {
    return interaction.reply({
      content: "Could not find this talk channel's client.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let clientMember;
  try {
    clientMember = await interaction.guild.members.fetch(ownerId);
  } catch (e) {
    return interaction.editReply({
      content: 'The original client is no longer in the server.',
    });
  }

  const designerMembers = [];
  for (const u of designerUsers) {
    if (u.id === clientMember.id || u.id === client.user.id) continue;
    const m = await interaction.guild.members.fetch(u.id).catch(() => null);
    if (m) designerMembers.push(m);
  }
  if (designerMembers.length === 0) {
    return interaction.editReply({
      content:
        'None of the picked designers were valid (they must be in this server, and not the client or the bot).',
    });
  }

  const newTicket = await createOrderTicket(
    interaction.guild,
    clientMember,
    designerMembers,
  );

  if (newTicket) {
    const designerMentions = designerMembers
      .map((d) => '<@' + d.id + '>')
      .join(' ');
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Redirected to project ticket')
          .setDescription(
            'New project ticket: <#' +
              newTicket.id +
              '>\n\nDesigner(s): ' +
              designerMentions +
              '\n\nThis talk channel stays open for further discussion. Use `/close` here when you no longer need it.',
          )
          .setColor(0x22c55e),
      ],
    });
    return interaction.editReply({
      content: '✅ Redirected: <#' + newTicket.id + '>',
    });
  }
  return interaction.editReply({
    content: '❌ Could not create the project ticket.',
  });
}

async function cmdAddTicket(interaction) {
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: 'Only founders, staff, or admins can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!isAnyTicketChannel(interaction.channel)) {
    return interaction.reply({
      content: 'This command only works inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const users = collectUserOptions(interaction, 'user', 5);
  if (users.length === 0) {
    return interaction.reply({
      content: 'Pick at least one user.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const added = [];
  for (const u of users) {
    try {
      await interaction.channel.permissionOverwrites.edit(u.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
      added.push('<@' + u.id + '>');
    } catch (e) {
      console.error('addticket failed for', u.id, e?.message);
    }
  }
  if (added.length === 0) {
    return interaction.editReply({
      content: "Could not add anyone — check the bot's permissions.",
    });
  }
  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('Added to ticket')
        .setDescription('✅ ' + added.join(', ') + ' added to this channel.')
        .setColor(0x22c55e),
    ],
  });
  await interaction.editReply({
    content: '✅ Added ' + added.length + ' user(s).',
  });
}

async function cmdRemoveTicket(interaction) {
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: 'Only founders, staff, or admins can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!isAnyTicketChannel(interaction.channel)) {
    return interaction.reply({
      content: 'This command only works inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const users = collectUserOptions(interaction, 'user', 5);
  if (users.length === 0) {
    return interaction.reply({
      content: 'Pick at least one user.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ownerId = findTicketOwner(interaction.channel, client.user.id);
  const removed = [];
  const skipped = [];

  for (const u of users) {
    if (u.id === client.user.id) {
      skipped.push('<@' + u.id + '> (bot)');
      continue;
    }
    if (u.id === ownerId) {
      skipped.push('<@' + u.id + '> (ticket owner)');
      continue;
    }
    const m = await interaction.guild.members.fetch(u.id).catch(() => null);
    if (m && m.roles.cache.has(FOUNDER_ROLE_ID)) {
      skipped.push('<@' + u.id + '> (founder)');
      continue;
    }
    if (m && m.roles.cache.has(STAFF_ROLE_ID)) {
      skipped.push('<@' + u.id + '> (staff)');
      continue;
    }
    try {
      await interaction.channel.permissionOverwrites.delete(u.id);
      removed.push('<@' + u.id + '>');
    } catch (e) {
      console.error('removeticket failed for', u.id, e?.message);
    }
  }

  const lines = [];
  if (removed.length > 0) lines.push('✅ Removed: ' + removed.join(', '));
  if (skipped.length > 0) lines.push('⚠️ Skipped: ' + skipped.join(', '));
  if (lines.length === 0) {
    return interaction.editReply({ content: 'Nothing to do.' });
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('Removed from ticket')
        .setDescription(lines.join('\n'))
        .setColor(0xef4444),
    ],
  });
  await interaction.editReply({
    content: '✅ Done. Removed ' + removed.length + ', skipped ' + skipped.length + '.',
  });
}

async function cmdDueBy(interaction) {
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: 'Only founders, staff, or admins can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!isOrderChannel(interaction.channel)) {
    return interaction.reply({
      content:
        'This command only works inside a TICKETS-category channel.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const raw = interaction.options.getString('when');

  // No argument → show current deadline (or "no deadline set").
  if (!raw || raw.trim() === '') {
    // Read from in-memory map first; if the bot restarted recently
    // and the rebuild missed this channel, fall back to the topic
    // and patch the map on the fly.
    let ts = dueByMap.get(interaction.channel.id);
    if (!ts) {
      ts = readDueByFromTopic(interaction.channel);
      if (ts && ts > Date.now()) {
        dueByMap.set(interaction.channel.id, ts);
        scheduleDueByExpiry(interaction.channel.id, ts);
      }
    }
    if (!ts || ts <= Date.now()) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('No deadline set')
            .setDescription(
              'This ticket has no active deadline.\n\nUse `/dueby when:<duration>` to set one (e.g. `2 days`, `tomorrow`, `may 3`).',
            )
            .setColor(0x6b7280),
        ],
      });
    }
    const dot = priorityDotForDeadline(ts) || '⚪';
    const color =
      dot === '🔴' ? 0xef4444 : dot === '🟡' ? 0xf59e0b : 0x22c55e;
    const tsSec = Math.floor(ts / 1000);
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(dot + ' Active deadline')
          .setDescription(
            'Deadline: <t:' + tsSec + ':F>\n' +
              'Time remaining: <t:' + tsSec + ':R>',
          )
          .setColor(color),
      ],
    });
  }

  const trimmed = raw.trim().toLowerCase();
  if (
    trimmed === 'clear' ||
    trimmed === 'cancel' ||
    trimmed === 'remove' ||
    trimmed === 'off' ||
    trimmed === 'none'
  ) {
    // Be idempotent: even if dueByMap doesn't have an entry (bot
    // just restarted, deadline lived only in the channel topic, etc),
    // clearChannelDueby still strips the topic + dot. Read from
    // either source so the response stays accurate.
    const hadInMap = dueByMap.has(interaction.channel.id);
    const hadInTopic = readDueByFromTopic(interaction.channel) != null;
    if (!hadInMap && !hadInTopic) {
      return interaction.reply({
        content: 'There is no deadline set on this ticket.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await clearChannelDueby(interaction.channel);
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Deadline cleared')
          .setDescription('No more reminders for this ticket.')
          .setColor(0x22c55e),
      ],
    });
  }

  // Try Portuguese first, then English, then a PT-BR shorthand
  // regex for the cases chrono.pt still misses.
  const parsed = parseDeadline(raw);
  if (!parsed) {
    return interaction.reply({
      content:
        'Could not parse `' +
        raw +
        '`. Examples that work: `2 days`, `2 dias`, `1 week 3 days`, `12h`, `tomorrow`, `amanhã`, `may 3`, `2026-05-03`.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const ts = parsed.getTime();
  if (ts <= Date.now()) {
    return interaction.reply({
      content:
        "That moment is already in the past. Try a future date.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Note whether we're replacing an existing deadline so the
  // response embed can reflect "updated" vs "set". setChannelDueby
  // already overrides cleanly — strips the old `dueby:` tag from
  // the topic, replaces dueByMap entry, clears + re-schedules the
  // expiry timeout, and re-applies the priority dot.
  const wasSet =
    dueByMap.has(interaction.channel.id) ||
    readDueByFromTopic(interaction.channel) != null;

  await setChannelDueby(interaction.channel, ts);

  const dot = priorityDotForDeadline(ts) || '⚪';
  const color =
    dot === '🔴' ? 0xef4444 : dot === '🟡' ? 0xf59e0b : 0x22c55e;
  const tsSec = Math.floor(ts / 1000);

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(dot + (wasSet ? ' Deadline updated' : ' Deadline set'))
        .setDescription(
          'New deadline: <t:' + tsSec + ':F>\n' +
            'Time remaining: <t:' + tsSec + ':R>\n\n' +
            'Designers in this ticket get a reminder every day at 6 AM until the deadline expires.',
        )
        .setColor(color),
    ],
  });
}

// Discord's hard upload ceiling for non-Nitro / non-boosted servers
// is 25 MB. Bot uploads from the user's URL, so the bot account's
// own ceiling applies — checking the size up front gives the user a
// clear error instead of letting the channel.send() fail loudly.
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

async function cmdAttach(interaction) {
  if (!isAnyTicketChannel(interaction.channel)) {
    return interaction.reply({
      content: 'This command only works inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const file = interaction.options.getAttachment('file');
  const note = interaction.options.getString('note');

  if (!file) {
    return interaction.reply({
      content: 'No file received.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (file.size > ATTACH_MAX_BYTES) {
    return interaction.reply({
      content:
        '❌ File is too big to re-post (' +
        formatBytes(file.size) +
        '). Max is ' +
        formatBytes(ATTACH_MAX_BYTES) +
        '. Compress it or share a link instead.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const embed = new EmbedBuilder()
    .setTitle('📎 New attachment')
    .setDescription(
      'Posted by <@' +
        interaction.user.id +
        '>' +
        (note ? '\n\n> ' + note : ''),
    )
    .addFields({
      name: 'File',
      value: '`' + file.name + '` — ' + formatBytes(file.size),
      inline: false,
    })
    .setColor(0x3b82f6)
    .setTimestamp();

  try {
    await interaction.channel.send({
      embeds: [embed],
      files: [{ attachment: file.url, name: file.name }],
    });
    await interaction.editReply({ content: '✅ File posted.' });
  } catch (e) {
    console.error('cmdAttach send failed:', e?.message);
    await interaction.editReply({
      content:
        '❌ Could not post the file. ' +
        (e?.code === 40005 || /size/i.test(e?.message || '')
          ? 'Discord rejected it as too large.'
          : 'Try again, or share a link instead.'),
    });
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function cmdAudit(interaction) {
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: 'Only founders, staff, or admins can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const target = interaction.options.getUser('user');
  const member = await interaction.guild.members
    .fetch(target.id)
    .catch(() => null);
  if (!member) {
    return interaction.reply({
      content: 'User is not in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = await createAuditTicket(interaction.guild, member);
  if (channel) {
    return interaction.editReply({
      content:
        '✅ Audit ticket created for ' +
        member.displayName +
        ': <#' +
        channel.id +
        '>',
    });
  }
  return interaction.editReply({
    content: '❌ Could not create the audit ticket.',
  });
}

// Designer slug → display label. Slug must match the folder name
// inside ./samples — both are lowercase. Display label is what
// users see in the slash command choice picker and the embed title.
const DESIGNER_LABELS = {
  s0da: 'S0da',
  willian: 'Will',
  nosher: 'Nosher',
  trispil: 'Trispil',
};

async function cmdSample(interaction) {
  const slug = interaction.options.getString('designer');
  const label = DESIGNER_LABELS[slug] || slug;
  const dir = path.join(__dirname, 'samples', slug);

  await interaction.deferReply();

  let files;
  try {
    if (!fs.existsSync(dir)) {
      return interaction.editReply({
        content: '❌ No samples folder found for ' + label + '.',
      });
    }
    files = fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .sort()
      .map((f) => ({
        attachment: path.join(dir, f),
        name: f,
      }));
  } catch (e) {
    console.error('cmdSample readdir failed:', e?.message);
    return interaction.editReply({
      content: '❌ Could not read ' + label + "'s samples folder.",
    });
  }

  if (files.length === 0) {
    return interaction.editReply({
      content: "❌ No image files in " + label + "'s folder.",
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🎨  ' + label + ' — Sample work')
    .setDescription(
      'Recent thumbnails from **' +
        label +
        '**. ' +
        files.length +
        ' piece' +
        (files.length === 1 ? '' : 's') +
        ' attached.',
    )
    .setColor(0x3b82f6)
    .setTimestamp();

  try {
    await interaction.editReply({
      embeds: [embed],
      files,
    });
  } catch (e) {
    console.error('cmdSample editReply failed:', e?.message);
    await interaction.editReply({
      content: '❌ Could not upload the samples. Try again in a bit.',
    });
  }
}

async function cmdDeadlines(interaction) {
  // Works in DMs / group DMs (User Install context). When not in a
  // guild, interaction.guild is null and we have to scan every guild
  // the bot is in to gather the user's tickets.
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const targetId = targetUser.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rows = [];
  for (const [, guild] of client.guilds.cache) {
    const ticketsCategory = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildCategory &&
        c.name.toUpperCase() === TICKET_CATEGORY_NAME,
    );
    if (!ticketsCategory) continue;

    const channels = guild.channels.cache.filter(
      (c) =>
        c.parentId === ticketsCategory.id &&
        c.type === ChannelType.GuildText,
    );

    for (const ch of channels.values()) {
      // Only count tickets the target is on (Member-type override).
      const userOverride = ch.permissionOverwrites.cache.get(targetId);
      if (!userOverride) continue;

      const ts = readDueByFromTopic(ch);
      if (ts == null || ts <= Date.now()) continue;

      rows.push({
        channelId: ch.id,
        channelName: stripPriorityDots(ch.name),
        guildName: guild.name,
        deadline: ts,
      });
    }
  }

  rows.sort((a, b) => a.deadline - b.deadline);

  if (rows.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📅 No active deadlines')
          .setDescription(
            (targetUser.id === interaction.user.id
              ? 'You have'
              : '<@' + targetUser.id + '> has') +
              ' no active deadlines right now.',
          )
          .setColor(0x6b7280),
      ],
    });
  }

  const lines = rows.map((r) => {
    const dot = priorityDotForDeadline(r.deadline) || '⚪';
    const tsSec = Math.floor(r.deadline / 1000);
    return (
      dot +
      ' **' +
      r.channelName +
      '** — <t:' + tsSec + ':R>\n' +
      '<#' + r.channelId + '> · *' + r.guildName + '*'
    );
  });

  const embed = new EmbedBuilder()
    .setTitle(
      '📅 Active deadlines for ' +
        (targetUser.id === interaction.user.id
          ? 'you'
          : targetUser.username),
    )
    .setDescription(lines.join('\n\n'))
    .setColor(0x3b82f6)
    .setFooter({ text: rows.length + ' ticket(s) · most urgent first' });

  await interaction.editReply({ embeds: [embed] });
}

async function cmdHelp(interaction) {
  const helpEmbed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('<:Blue_Ticket:1415843891894026271>  Cube Tickets — Commands')
    .setDescription(
      '**Everyone**\n' +
        '<:j_dot:1415844475120386230> `/help` — Show this list\n' +
        '<:j_dot:1415844475120386230> `/close` — Close the current ticket (talk OR order)\n' +
        '<:j_dot:1415844475120386230> `/attach` — Drop a file in the ticket via a clean embed\n' +
        '<:j_dot:1415844475120386230> `/sample` — Show a designer\'s sample work · S0da / Will / Nosher / Trispil · works in DMs too\n' +
        '<:j_dot:1415844475120386230> `/deadlines` — Show your (or someone else\'s) active deadlines · works in DMs too\n\n' +
        '**Founder / Staff / Admin**\n' +
        '<:j_dot:1415844475120386230> `/ordermsg` — Post the order banner with the Open-a-Ticket button (admin only)\n' +
        '<:j_dot:1415844475120386230> `/ticket user: [designer1: ...]` — Manually open a TICKETS-category project ticket (up to 4 designers optional)\n' +
        '<:j_dot:1415844475120386230> `/audit user:` — Open an AUDITS ticket · auto-adds the RTG team\n' +
        '<:j_dot:1415844475120386230> `/redirect designer1: [designer2: ...]` — Spin up a TICKETS channel from a talk (up to 5 designers)\n' +
        '<:j_dot:1415844475120386230> `/addticket user1: [user2: ...]` — Add up to 5 users to the current ticket\n' +
        '<:j_dot:1415844475120386230> `/removeticket user1: [user2: ...]` — Revoke up to 5 users from the current ticket\n' +
        '<:j_dot:1415844475120386230> `/dueby when:` — Set / show / clear the deadline (e.g. `2 days`, `tomorrow`, `clear`)',
    )
    .setFooter({ text: 'Tip: /sample and /deadlines also work in DMs and group DMs.' })
    .setTimestamp();
  return interaction.reply({ embeds: [helpEmbed] });
}

// =====================================================================
// BUTTON HANDLERS
// =====================================================================

async function handleOpenTicketButton(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const member = interaction.member;
    const guild = interaction.guild;
    const slug = safeUsernameSlug(member);

    const existing = guild.channels.cache.find(
      (ch) =>
        (stripPriorityDots(ch.name) === 'talk-' + slug ||
          stripPriorityDots(ch.name) === 'ticket-' + slug) &&
        ch.parentId,
    );

    if (existing) {
      return interaction.editReply({
        content: '🎫 You already have an open ticket: <#' + existing.id + '>',
      });
    }

    const newTalk = await createTalkTicket(guild, member);
    if (newTalk) {
      return interaction.editReply({
        content: '🎫 Your ticket has been created: <#' + newTalk.id + '>',
      });
    }
    return interaction.editReply({
      content: '🎫 Your ticket is being created! Check the talk category.',
    });
  } catch (e) {
    console.error('Ticket button error:', e);
    interaction.editReply({
      content: '❌ Error creating ticket. Please try again.',
    });
  }
}

async function handleCloseTicketButton(interaction) {
  if (!isAnyTicketChannel(interaction.channel)) {
    return interaction.reply({
      content: "This isn't a ticket channel.",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Ticket Closing')
        .setDescription('Deleting in 5 seconds.')
        .setColor(0xef4444),
    ],
  });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// =====================================================================
// CHANNEL CREATION
// =====================================================================

async function createTalkTicket(guild, member) {
  try {
    let category = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildCategory &&
        c.name.toUpperCase() === TALK_CATEGORY_NAME,
    );
    if (!category) {
      category = await guild.channels.create({
        name: TALK_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }

    const safeName = 'talk-' + safeUsernameSlug(member);
    const existing = guild.channels.cache.find(
      (c) => stripPriorityDots(c.name) === safeName,
    );
    if (existing) return existing;

    const ticketChannel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: member.id, ...TICKET_PERMS },
        { id: FOUNDER_ROLE_ID, ...TICKET_PERMS },
        { id: STAFF_ROLE_ID, ...TICKET_PERMS },
        { id: client.user.id, ...BOT_PERMS },
      ],
    });

    const welcomeEmbed = new EmbedBuilder()
      .setTitle('Talk — ' + member.displayName)
      .setDescription(
        'Hey <@' +
          member.id +
          '>! Welcome to your private chat with the **Cube Graphics** team.\n\n' +
          'A founder or staff member will be with you shortly to discuss your project.\n\n' +
          "Use `/close` to close this ticket once we're done.",
      )
      .setColor(0x3b82f6)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒'),
    );

    await ticketChannel.send({
      content:
        '<@' +
        member.id +
        '> <@&' +
        FOUNDER_ROLE_ID +
        '> <@&' +
        STAFF_ROLE_ID +
        '>',
      embeds: [welcomeEmbed],
      components: [row],
      allowedMentions: { parse: ['users', 'roles'] },
    });

    return ticketChannel;
  } catch (error) {
    console.error('Error creating talk ticket:', error);
  }
}

async function createAuditTicket(guild, member) {
  try {
    let category = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildCategory &&
        c.name.toUpperCase() === AUDIT_CATEGORY_NAME,
    );
    if (!category) {
      category = await guild.channels.create({
        name: AUDIT_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }

    const safeName = 'audit-' + safeUsernameSlug(member);
    const existing = guild.channels.cache.find(
      (c) => stripPriorityDots(c.name) === safeName,
    );
    if (existing) return existing;

    // RTG members get access via the ROLE overwrite — anyone with
    // the RTG role automatically sees this channel, anyone who
    // gains the role later auto-gains access, anyone who loses it
    // auto-loses. Adding individual member overwrites would give
    // us stale access maps and would also confuse findTicketOwner
    // (which assumes exactly one Member-type overwrite per ticket).
    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, ...TICKET_PERMS },
      { id: FOUNDER_ROLE_ID, ...TICKET_PERMS },
      { id: STAFF_ROLE_ID, ...TICKET_PERMS },
      { id: RTG_ROLE_ID, ...TICKET_PERMS },
      { id: client.user.id, ...BOT_PERMS },
    ];

    const auditChannel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites,
    });

    const welcomeEmbed = new EmbedBuilder()
      .setTitle('Game Audit — ' + member.displayName)
      .setDescription(
        'Hey <@' +
          member.id +
          '>! This is your **game-audit** ticket.\n\n' +
          'The RTG team (<@&' +
          RTG_ROLE_ID +
          '>) has been pulled in to walk through your game and surface what is killing retention, store presence, icons, and discoverability.\n\n' +
          'Use `/close` to close this ticket once the audit is complete.',
      )
      .setColor(0x8b5cf6)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒'),
    );

    // Pinging the role notifies every RTG member that meets the
    // server's notification settings — same effect as individually
    // mentioning them, no fetch needed.
    await auditChannel.send({
      content:
        '<@' + member.id + '> <@&' + RTG_ROLE_ID + '>',
      embeds: [welcomeEmbed],
      components: [row],
      allowedMentions: {
        parse: ['users', 'roles'],
      },
    });

    return auditChannel;
  } catch (error) {
    console.error('Error creating audit ticket:', error);
  }
}

async function createOrderTicket(guild, clientMember, designerMembers) {
  try {
    let category = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildCategory &&
        c.name.toUpperCase() === TICKET_CATEGORY_NAME,
    );
    if (!category) {
      category = await guild.channels.create({
        name: TICKET_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }

    const safeName = 'ticket-' + safeUsernameSlug(clientMember);
    const existing = guild.channels.cache.find(
      (c) => stripPriorityDots(c.name) === safeName,
    );
    if (existing) return existing;

    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: clientMember.id, ...TICKET_PERMS },
      { id: FOUNDER_ROLE_ID, ...TICKET_PERMS },
      { id: STAFF_ROLE_ID, ...TICKET_PERMS },
      { id: client.user.id, ...BOT_PERMS },
    ];
    for (const designer of designerMembers) {
      overwrites.push({ id: designer.id, ...TICKET_PERMS });
    }

    const ticketChannel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites,
    });

    const designerMentions = designerMembers
      .map((d) => '<@' + d.id + '>')
      .join(' ');
    const hasDesigners = designerMembers.length > 0;

    const welcomeEmbed = new EmbedBuilder()
      .setTitle('Ticket — ' + clientMember.displayName)
      .setDescription(
        'Hey <@' +
          clientMember.id +
          '>! This is your project ticket.\n\n' +
          (hasDesigners
            ? 'Working with: ' + designerMentions + '\n\n'
            : 'A designer will be assigned shortly.\n\n') +
          'Use `/close` to close this ticket once the order is delivered.',
      )
      .setColor(0x3b82f6)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒'),
    );

    // Ping the client always, plus the designers if any.
    // Without designers, ping founder/staff so they see they need
    // to assign someone.
    const pings = ['<@' + clientMember.id + '>'];
    if (hasDesigners) {
      pings.push(designerMentions);
    } else {
      pings.push(
        '<@&' + FOUNDER_ROLE_ID + '>',
        '<@&' + STAFF_ROLE_ID + '>',
      );
    }

    await ticketChannel.send({
      content: pings.join(' '),
      embeds: [welcomeEmbed],
      components: [row],
      allowedMentions: { parse: ['users', 'roles'] },
    });

    return ticketChannel;
  } catch (error) {
    console.error('Error creating order ticket:', error);
  }
}

// =====================================================================
// LOGIN
// =====================================================================

client.login(process.env.BOT_TOKEN);
