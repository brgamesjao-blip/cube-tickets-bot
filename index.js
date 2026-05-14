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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  Events,
  AttachmentBuilder,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
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

// Designer payment ledger lives in this private text channel. The
// bot creates it on first use (founder/staff/bot only) and writes
// one message per /done, plus a PAYOUT message per /payments paid.
// The channel doubles as durable storage: on startup the bot reads
// its history and replays every transaction into the in-memory map.
const PAYMENTS_CHANNEL_NAME = 'payments-log';

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

// Designer payment ledger.
// Map<designerId, { robux: number, usd: number, entries: Entry[] }>
// where Entry = { type: 'delivery'|'payout', currency, amount, ticket, ts }
// Rebuilt on startup from the #payments-log channel; mutated by
// /done (delivery entries) and /payments paid (payout entries).
const paymentsLedger = new Map();

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

// In DM/UserInstall context interaction.member is null, so the
// usual canManage() check can't see role state. These helpers walk
// every guild the bot is in and look up the user as a member there
// — if the user has FOUNDER_ROLE_ID in ANY guild, they're treated
// as a founder for cross-context commands like /payments paid.
async function isFounderUser(userId) {
  for (const [, guild] of client.guilds.cache) {
    const m = await guild.members.fetch(userId).catch(() => null);
    if (m && m.roles.cache.has(FOUNDER_ROLE_ID)) return true;
  }
  return false;
}
async function getFounderGuild(userId) {
  for (const [, guild] of client.guilds.cache) {
    const m = await guild.members.fetch(userId).catch(() => null);
    if (m && m.roles.cache.has(FOUNDER_ROLE_ID)) return guild;
  }
  return null;
}
async function isManagerUser(userId) {
  for (const [, guild] of client.guilds.cache) {
    const m = await guild.members.fetch(userId).catch(() => null);
    if (!m) continue;
    if (m.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (m.roles.cache.has(FOUNDER_ROLE_ID)) return true;
    if (m.roles.cache.has(STAFF_ROLE_ID)) return true;
  }
  return false;
}

// Recover the original ticket owner. The channel topic pins it
// explicitly as `owner:<userId>` (set at ticket-creation time),
// which is the source of truth. Fall back to the first non-bot
// Member override only for legacy channels created before the
// topic-tagging change — note that this fallback is ambiguous when
// designers are attached as Member overrides, so the topic tag is
// what makes the lookup deterministic.
function findTicketOwner(channel, botId) {
  if (channel?.topic) {
    const m = channel.topic.match(/owner:(\d+)/);
    if (m) return m[1];
  }
  const override = channel?.permissionOverwrites?.cache?.find(
    (po) => po.type === OverwriteType.Member && po.id !== botId,
  );
  return override ? override.id : null;
}

// Stamp the ticket owner into the channel topic. Preserves any
// pre-existing tags on the topic (e.g. dueby:...). Fire-and-forget
// because Discord rate-limits topic edits and we don't want to
// stall ticket creation on it.
function setChannelOwner(channel, ownerId) {
  const existing = (channel.topic || '').replace(/owner:\d+\s*/g, '').trim();
  const newTopic = (
    'owner:' + ownerId + (existing ? ' ' + existing : '')
  ).slice(0, 1024);
  return channel
    .setTopic(newTopic)
    .catch((e) =>
      console.error('background setChannelOwner failed:', e?.message),
    );
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

// IMPORTANT: BOTH setTopic AND setName are background-only here.
// discord.js queues rate-limited REST calls indefinitely, so an
// awaited setTopic can hang the slash-command interaction past
// Discord's 15-minute follow-up window — user sees "thinking…"
// forever. Instead: mutate the in-memory state synchronously,
// reply right away, and let the channel-edit calls retry on their
// own. They're idempotent enough that a failed call gets corrected
// on the next 6am pass.
async function setChannelDueby(channel, deadlineMs) {
  const currentTopic = channel.topic || '';
  const stripped = currentTopic.replace(/dueby:\d+\s*/g, '').trim();
  const newTopic = ('dueby:' + deadlineMs + (stripped ? ' ' + stripped : '')).slice(0, 1024);

  dueByMap.set(channel.id, deadlineMs);
  scheduleDueByExpiry(channel.id, deadlineMs);

  // Both setTopic and setName are fire-and-forget: discord.js
  // queues rate-limited calls indefinitely (no internal timeout),
  // so awaiting them can pin the interaction's deferred reply for
  // many minutes. The in-memory dueByMap is the runtime source of
  // truth; /deadlines and /dueby (no arg) read from the map first
  // and only fall back to the topic for restart recovery.
  channel.setTopic(newTopic).catch((e) =>
    console.error('background setTopic (set) failed:', e?.message),
  );
  applyPriorityDot(channel, deadlineMs).catch((e) =>
    console.error('background rename (set) failed:', e?.message),
  );
}

async function clearChannelDueby(channel) {
  const currentTopic = channel.topic || '';
  const stripped = currentTopic.replace(/dueby:\d+\s*/g, '').trim();

  dueByMap.delete(channel.id);
  if (dueByTimers.has(channel.id)) {
    clearTimeout(dueByTimers.get(channel.id));
    dueByTimers.delete(channel.id);
  }

  channel.setTopic(stripped).catch((e) =>
    console.error('background setTopic (clear) failed:', e?.message),
  );
  removePriorityDot(channel).catch((e) =>
    console.error('background rename (clear) failed:', e?.message),
  );
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

// =====================================================================
// PAYMENTS LEDGER — Discord channel as durable storage
// =====================================================================
// Schema: each transaction is a single message in #payments-log
// containing a fenced JSON code block. Two transaction types:
//   { type:"delivery", designer, designerName, client, clientName,
//     ticket, ticketName, currency:"USD"|"ROBUX", amount, timestamp }
//   { type:"payout", designer, designerName, robux, usd, timestamp }
// On startup we walk the channel history once and replay every entry
// into paymentsLedger; afterward all writes go to the channel and to
// the map so they stay in sync.

function getOrCreateLedgerEntry(designerId) {
  let row = paymentsLedger.get(designerId);
  if (!row) {
    row = { robux: 0, usd: 0, entries: [] };
    paymentsLedger.set(designerId, row);
  }
  return row;
}

function applyTransactionToLedger(tx) {
  const row = getOrCreateLedgerEntry(tx.designer);
  if (tx.type === 'delivery') {
    if (tx.currency === 'ROBUX') row.robux += tx.amount;
    else if (tx.currency === 'USD') row.usd += tx.amount;
    row.entries.push(tx);
  } else if (tx.type === 'payout') {
    row.robux = Math.max(0, row.robux - (tx.robux || 0));
    row.usd = Math.max(0, row.usd - (tx.usd || 0));
    row.entries.push(tx);
  }
}

async function findPaymentsChannel(guild) {
  return (
    guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        c.name === PAYMENTS_CHANNEL_NAME,
    ) || null
  );
}

async function ensurePaymentsChannel(guild) {
  let channel = await findPaymentsChannel(guild);
  if (channel) return channel;
  channel = await guild.channels.create({
    name: PAYMENTS_CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic:
      'Cube Tickets payments ledger. Bot-managed — do not edit messages here. Each entry is a delivery or payout transaction.',
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: FOUNDER_ROLE_ID, ...TICKET_PERMS },
      { id: STAFF_ROLE_ID, ...TICKET_PERMS },
      { id: client.user.id, ...BOT_PERMS },
    ],
  });
  return channel;
}

// Append a transaction record to #payments-log AND update the
// in-memory ledger so /payments stays consistent immediately.
//
// On the wire: pretty embed for humans + the canonical JSON tucked
// into the message content as a SPOILER (`||tx:{...}||`). Spoilers
// render as a black "click to reveal" pill in Discord, so the JSON
// is hidden by default but still parseable on rebuild. No more
// "tx:..." text leaking into the visible footer.
async function logTransaction(guild, tx) {
  const channel = await ensurePaymentsChannel(guild);
  const embed = buildTransactionEmbed(tx);
  await channel.send({
    content: '||tx:' + JSON.stringify(tx) + '||',
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
  applyTransactionToLedger(tx);
}

function buildTransactionEmbed(tx) {
  const embed = new EmbedBuilder().setTimestamp(tx.timestamp || Date.now());

  if (tx.type === 'delivery') {
    const amountStr =
      tx.currency === 'ROBUX' ? formatRobux(tx.amount) : formatUSD(tx.amount);
    embed
      .setColor(0x22c55e)
      .setAuthor({ name: '💼 Delivery logged' })
      .setDescription(
        '<@' +
          tx.designer +
          '> delivered **' +
          amountStr +
          '** of work on `' +
          (tx.ticketName || tx.ticket) +
          '`' +
          (tx.client && tx.client !== 'unknown'
            ? ' for <@' + tx.client + '>'
            : ''),
      )
      .addFields(
        {
          name: 'Designer',
          value: '<@' + tx.designer + '>',
          inline: true,
        },
        {
          name: 'Client',
          value:
            tx.client && tx.client !== 'unknown'
              ? '<@' + tx.client + '>'
              : '*unknown*',
          inline: true,
        },
        {
          name: 'Amount',
          value: amountStr,
          inline: true,
        },
      );
  } else if (tx.type === 'payout') {
    const parts = [];
    if (tx.robux > 0) parts.push(formatRobux(tx.robux));
    if (tx.usd > 0) parts.push(formatUSD(tx.usd));
    embed
      .setColor(0xf59e0b)
      .setAuthor({ name: '💸 Payout' })
      .setDescription(
        'Settled **' +
          (parts.join(' + ') || '0') +
          '** to <@' +
          tx.designer +
          '>.',
      )
      .addFields(
        {
          name: 'Designer',
          value: '<@' + tx.designer + '>',
          inline: true,
        },
        {
          name: 'Robux',
          value: tx.robux > 0 ? formatRobux(tx.robux) : '—',
          inline: true,
        },
        {
          name: 'USD',
          value: tx.usd > 0 ? formatUSD(tx.usd) : '—',
          inline: true,
        },
      );
  }
  return embed;
}

// Read the entire history of #payments-log on startup and rebuild
// paymentsLedger from scratch. Discord gives us 100 messages per
// fetch; loop with `before` until we exhaust the history.
async function rebuildPaymentsLedger() {
  paymentsLedger.clear();
  for (const [, guild] of client.guilds.cache) {
    const channel = await findPaymentsChannel(guild);
    if (!channel) continue;
    let before;
    const txList = [];
    while (true) {
      const fetched = await channel.messages
        .fetch({ limit: 100, before })
        .catch((e) => {
          console.error('rebuildPaymentsLedger fetch failed:', e?.message);
          return null;
        });
      if (!fetched || fetched.size === 0) break;
      for (const msg of fetched.values()) {
        // Newest format: JSON stashed inside a spoiler in the
        // message content (`||tx:{...}||`).
        const spoiler = msg.content.match(/\|\|tx:([\s\S]+?)\|\|/);
        if (spoiler) {
          try {
            txList.push(JSON.parse(spoiler[1]));
            continue;
          } catch (e) {
            console.error('Bad JSON in spoiler:', e?.message);
          }
        }
        // Legacy 1: JSON in embed footer ("tx:{...}").
        if (msg.embeds.length > 0) {
          const footer = msg.embeds[0]?.footer?.text || '';
          if (footer.startsWith('tx:')) {
            try {
              txList.push(JSON.parse(footer.slice(3)));
              continue;
            } catch (e) {
              console.error('Bad JSON in embed footer:', e?.message);
            }
          }
        }
        // Legacy 2: fenced ```json code block in the content.
        const m = msg.content.match(/```json\s*([\s\S]+?)\s*```/);
        if (!m) continue;
        try {
          txList.push(JSON.parse(m[1]));
        } catch (e) {
          console.error('Bad JSON in payments-log:', e?.message);
        }
      }
      before = fetched.last().id;
      if (fetched.size < 100) break;
    }
    // Replay in chronological order so payouts subtract correctly
    // from later balances.
    txList.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    for (const tx of txList) applyTransactionToLedger(tx);
  }
  console.log(
    'Rebuilt paymentsLedger with ' +
      paymentsLedger.size +
      ' designer balance(s).',
  );
}

function formatRobux(n) {
  return Math.round(n).toLocaleString('en-US') + ' Robux';
}
function formatUSD(n) {
  return '$' + (Math.round(n * 100) / 100).toFixed(2) + ' USD';
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

    // Re-apply the dot — keeps every active ticket in sync if a
    // Discord rename or manual edit drifted the colour.
    await applyPriorityDot(channel, deadlineMs);

    // Identify designers in the ticket: every Member-type override
    // that isn't the bot or the ticket owner. Founder/Staff are
    // ROLE-type overrides, so they don't show up here.
    const ownerId = findTicketOwner(channel, client.user.id);
    const designerIds = channel.permissionOverwrites.cache
      .filter(
        (po) =>
          po.type === OverwriteType.Member &&
          po.id !== client.user.id &&
          po.id !== ownerId,
      )
      .map((po) => po.id);

    if (designerIds.length === 0) continue; // no one to remind

    const dot = priorityDotForDeadline(deadlineMs) || '⚪';
    const color =
      dot === '🔴' ? 0xef4444 : dot === '🟡' ? 0xf59e0b : 0x22c55e;
    const tsSec = Math.floor(deadlineMs / 1000);
    const ticketName = stripPriorityDots(channel.name);

    const embed = new EmbedBuilder()
      .setTitle(dot + ' Deadline reminder')
      .setDescription(
        'Project: **' + ticketName + '**\n' +
          'Deadline: <t:' + tsSec + ':R>\n' +
          'Full date: <t:' + tsSec + ':F>\n\n' +
          'Channel: <#' + channelId + '>',
      )
      .setColor(color);

    // DM each designer directly. Skips the channel post entirely so
    // the client doesn't get pinged on the deadline reminder — keeps
    // designer workload private + avoids the old client/designer
    // confusion in the channel embed.
    for (const designerId of designerIds) {
      try {
        const user = await client.users.fetch(designerId).catch(() => null);
        if (!user) continue;
        await user.send({ embeds: [embed] });
      } catch (e) {
        console.error(
          'dailyDueByCheck DM failed for ' + designerId + ':',
          e?.message,
        );
      }
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
    .setName('done')
    .setDescription(
      'Log a delivery for the current ticket — opens a price panel',
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('payments')
    .setDescription("Show pending payments, or settle them (founder)")
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('Show pending payments — defaults to your own')
        .addStringOption((opt) =>
          opt
            .setName('scope')
            .setDescription(
              'Pick "All" to see every designer (founder/staff/admin only)',
            )
            .setRequired(false)
            .addChoices({ name: 'All', value: 'all' }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('paid')
        .setDescription(
          'Settle pending payments — founder only · pick a designer + amount',
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
    .setName('load')
    .setDescription(
      "Show how many active deadlines a user is on (defaults to you)",
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('User to check (defaults to you)')
        .setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('reminder')
    .setDescription(
      'Send a placeholder deadline reminder DM to a user (for testing)',
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('User to DM')
        .setRequired(true),
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
          { name: 'Soul', value: 'soul' },
          { name: 'Art', value: 'art' },
          { name: 'Pontin', value: 'pontin' },
          { name: 'Zack', value: 'zack' },
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
    // Discord caches global slash commands client-side, so schema
    // changes show "Este comando está desatualizado" until the cache
    // refreshes (up to ~1 hour). Guild commands propagate INSTANTLY.
    //
    // Strategy:
    //   1) Register the FULL command set on every guild the bot is in
    //      (instant updates — eliminates the "outdated" error).
    //   2) Register ONLY user-install commands globally — those need
    //      to be global so they keep working in DMs / cross-guild.
    //   3) Discord prefers guild commands over global when both exist
    //      with the same name, so guild users always get the latest
    //      schema even for user-install commands.
    const isUserInstall = (cmd) =>
      Array.isArray(cmd.integration_types) &&
      cmd.integration_types.includes(1); // 1 = UserInstall
    const userInstallCmds = slashCommands.filter(isUserInstall);
    // Per-guild gets EVERYTHING EXCEPT user-install commands. The
    // user-install ones are registered globally so they work in DMs;
    // mixing both registrations for the same command name causes
    // Discord to surface the command twice in the picker.
    const guildOnlyCmds = slashCommands.filter((c) => !isUserInstall(c));

    // 1) Per-guild registration (instant).
    const results = await Promise.allSettled(
      [...client.guilds.cache.values()].map((g) =>
        g.commands
          .set(guildOnlyCmds)
          .then(() => ({ guild: g.name, ok: true }))
          .catch((e) => ({ guild: g.name, ok: false, err: e?.message })),
      ),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) {
        console.log(
          'Registered ' +
            guildOnlyCmds.length +
            ' guild-only commands on guild "' +
            r.value.guild +
            '" (instant).',
        );
      } else {
        const v = r.status === 'fulfilled' ? r.value : { err: r.reason };
        console.error(
          'Guild registration failed for "' +
            (v.guild || '?') +
            '":',
          v.err,
        );
      }
    }

    // 2) Global registration — only user-install commands, so DMs /
    //    cross-guild contexts keep working. Other commands stay
    //    guild-only.
    await client.application.commands.set(userInstallCmds);
    console.log(
      'Registered ' +
        userInstallCmds.length +
        ' user-install commands globally (DM-capable).',
    );
  } catch (e) {
    console.error('Failed to register slash commands:', e);
  }
}

// Re-register on every new guild join — guarantees commands appear
// instantly when the bot is added to a server. Only the guild-only
// subset; user-install commands stay global so DMs keep working.
client.on('guildCreate', async (guild) => {
  try {
    const guildOnlyCmds = slashCommands.filter(
      (c) =>
        !(
          Array.isArray(c.integration_types) &&
          c.integration_types.includes(1)
        ),
    );
    await guild.commands.set(guildOnlyCmds);
    console.log(
      'Registered ' +
        guildOnlyCmds.length +
        ' guild-only commands on new guild "' +
        guild.name +
        '" (guildCreate).',
    );
  } catch (e) {
    console.error('guildCreate registration failed:', e?.message);
  }
});

// =====================================================================
// READY
// =====================================================================

client.once('ready', async () => {
  console.log('Bot online as ' + client.user.tag);
  client.user.setActivity('Cube Graphics Orders', { type: 3 });

  await registerSlashCommands();
  await rebuildDueByQueue();
  await rebuildPaymentsLedger();
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

  // Component / modal handlers run inside a try/catch so any
  // unhandled throw surfaces a friendly ephemeral message instead
  // of letting Discord show "Esta interação falhou".
  const safe = async (fn) => {
    try {
      await fn();
    } catch (e) {
      console.error('Interaction handler error:', e);
      const errMsg = {
        content:
          '❌ Something broke handling that interaction. Check the logs.',
        flags: MessageFlags.Ephemeral,
      };
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errMsg);
        } else {
          await interaction.reply(errMsg);
        }
      } catch (_) {
        /* nothing else we can do */
      }
    }
  };

  if (interaction.isButton()) {
    if (interaction.customId === 'open_ticket') {
      await safe(() => handleOpenTicketButton(interaction));
    } else if (interaction.customId === 'close_ticket') {
      await safe(() => handleCloseTicketButton(interaction));
    } else if (interaction.customId.startsWith('done:')) {
      await safe(() => handleDoneButton(interaction));
    } else if (interaction.customId.startsWith('payments:')) {
      await safe(() => handlePaymentsButton(interaction));
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('done:submit:')) {
      await safe(() => handleDoneModalSubmit(interaction));
    } else if (interaction.customId.startsWith('payments:paid_modal:')) {
      await safe(() => handlePaymentsModalSubmit(interaction));
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'payments:paid_pick') {
      await safe(() => handlePaymentsSelect(interaction));
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
    case 'done':
      return cmdDone(interaction);
    case 'payments':
      return cmdPayments(interaction);
    case 'load':
      return cmdLoad(interaction);
    case 'reminder':
      return cmdReminder(interaction);
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
    // clearChannelDueby still strips the topic + dot.
    const hadInMap = dueByMap.has(interaction.channel.id);
    const hadInTopic = readDueByFromTopic(interaction.channel) != null;
    if (!hadInMap && !hadInTopic) {
      return interaction.reply({
        content: 'There is no deadline set on this ticket.',
        flags: MessageFlags.Ephemeral,
      });
    }
    // Defer up front — clearChannelDueby calls setTopic + setName,
    // and Discord's channel-rename rate limit (2 per 10 min) can
    // stall the second call by minutes. Without a defer, the 3s
    // interaction window blows up and the user sees "App didn't
    // respond" even though the work succeeds in the background.
    await interaction.deferReply();
    await clearChannelDueby(interaction.channel);
    return interaction.editReply({
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

  // Defer up front — setChannelDueby calls setTopic + setName, and
  // the channel-rename rate limit (2 per 10 min) can blow past the
  // 3s interaction window otherwise.
  await interaction.deferReply();

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

  return interaction.editReply({
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

// Walk every guild + every TICKETS-category channel and pull the
// tickets where the given user is on the access list (Member-type
// overwrite) AND a dueby:<ms> tag is present in the topic AND the
// deadline is still in the future. Returns rows sorted urgency-
// first. Shared by /deadlines and /load.
function collectUserTicketsWithDeadlines(userId) {
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
      const userOverride = ch.permissionOverwrites.cache.get(userId);
      if (!userOverride) continue;
      // Prefer dueByMap (in-memory source of truth this process)
      // over the topic. The topic is the durable backup that
      // restart-recovery rebuilds the map from, but during runtime
      // a failed setTopic could leave the topic stale while the
      // map is correct. Reading from the map first means /deadlines
      // never reports a value the user thought they overwrote.
      const ts = dueByMap.get(ch.id) ?? readDueByFromTopic(ch);
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
  return rows;
}

// /load [user:] — workload check. Counts the chosen user's TICKETS-
// category deadlines, breaks them down by priority, and lists each
// one with the Discord native relative timestamp. Tickets without
// a deadline are NOT counted (per spec — that's the whole point;
// load only matters where there's a clock running).
async function cmdLoad(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  await interaction.deferReply();

  const rows = collectUserTicketsWithDeadlines(target.id);

  const isSelf = target.id === interaction.user.id;
  const ownerLabel = isSelf
    ? 'your'
    : '<@' + target.id + ">'s";

  if (rows.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📊 Deadline load')
          .setDescription(
            'No tickets with active deadlines under ' +
              ownerLabel +
              ' name right now.',
          )
          .setColor(0x6b7280),
      ],
    });
  }

  // Tally the priority bands so the header gives an at-a-glance read.
  let red = 0;
  let yellow = 0;
  let green = 0;
  for (const r of rows) {
    const dot = priorityDotForDeadline(r.deadline);
    if (dot === '🔴') red++;
    else if (dot === '🟡') yellow++;
    else if (dot === '🟢') green++;
  }

  const lines = rows.map((r) => {
    const dot = priorityDotForDeadline(r.deadline) || '⚪';
    const tsSec = Math.floor(r.deadline / 1000);
    return (
      dot +
      ' **' +
      r.channelName +
      '** — <t:' +
      tsSec +
      ':R>\n' +
      '<#' +
      r.channelId +
      '> · *' +
      r.guildName +
      '*'
    );
  });

  const embed = new EmbedBuilder()
    .setTitle('📊 Deadline load — ' + (isSelf ? 'you' : target.username))
    .setDescription(
      '**' +
        rows.length +
        ' active deadline' +
        (rows.length === 1 ? '' : 's') +
        '** · 🔴 ' +
        red +
        ' · 🟡 ' +
        yellow +
        ' · 🟢 ' +
        green +
        '\n\n' +
        lines.join('\n\n'),
    )
    .setColor(red > 0 ? 0xef4444 : yellow > 0 ? 0xf59e0b : 0x22c55e)
    .setFooter({ text: 'Most urgent first · tickets without a deadline are skipped' });

  return interaction.editReply({ embeds: [embed] });
}

// =====================================================================
// /done — designer logs a delivery for the current ticket
// =====================================================================
// Flow:
//   1. Designer types /done in a TICKETS channel.
//   2. Bot replies with an ephemeral panel: 🔵 Robux | 💵 USD | ❌
//   3. Designer clicks a currency button — bot opens a modal with
//      a single number input.
//   4. Modal submit — bot validates, builds a `delivery` transaction
//      (with the channel's owner attached as the client), appends it
//      to #payments-log AND mutates paymentsLedger, then confirms
//      back in the original ephemeral panel.
//
// Custom-id schema (must round-trip across handlers):
//   done:cancel
//   done:pick:<currency>:<ticketChannelId>
//   done:submit:<currency>:<ticketChannelId>

async function cmdDone(interaction) {
  if (!isOrderChannel(interaction.channel)) {
    return interaction.reply({
      content:
        'This command only works inside a TICKETS-category channel.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const ticketChannelId = interaction.channel.id;
  const ticketChannelName = stripPriorityDots(interaction.channel.name);

  const embed = new EmbedBuilder()
    .setTitle('💼 Log a Delivery')
    .setDescription(
      'Logging a delivery for **' +
        ticketChannelName +
        '**.\n\nPick the currency you got paid in, then enter the amount.',
    )
    .setColor(0x3b82f6);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('done:pick:ROBUX:' + ticketChannelId)
      .setLabel('Robux')
      .setEmoji('🔵')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('done:pick:USD:' + ticketChannelId)
      .setLabel('USD')
      .setEmoji('💵')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('done:cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDoneButton(interaction) {
  const id = interaction.customId;
  if (id === 'done:cancel') {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Cancelled')
          .setDescription('No delivery logged.')
          .setColor(0x6b7280),
      ],
      components: [],
    });
  }

  // Format: done:pick:<currency>:<channelId>
  const parts = id.split(':');
  if (parts[1] !== 'pick' || parts.length < 4) return;
  const currency = parts[2]; // 'ROBUX' or 'USD'
  const ticketChannelId = parts[3];

  const modal = new ModalBuilder()
    .setCustomId('done:submit:' + currency + ':' + ticketChannelId)
    .setTitle(currency === 'ROBUX' ? 'Robux Amount' : 'USD Amount');

  const input = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel(
      currency === 'ROBUX'
        ? 'How many Robux?'
        : 'How many USD? (e.g. 50 or 50.5)',
    )
    .setPlaceholder(currency === 'ROBUX' ? '30000' : '50')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12);

  modal.addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function handleDoneModalSubmit(interaction) {
  // Format: done:submit:<currency>:<ticketChannelId>
  const parts = interaction.customId.split(':');
  if (parts.length < 4) return;
  const currency = parts[2];
  const ticketChannelId = parts[3];

  const raw = interaction.fields.getTextInputValue('amount').trim();
  // Accept "30000", "30,000", "30.000", "50.5" — Robux must be an
  // integer; USD allows decimals.
  const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g, '.');
  const amount = parseFloat(cleaned);
  if (!isFinite(amount) || amount <= 0) {
    return interaction.reply({
      content:
        '❌ "' +
        raw +
        '" is not a valid amount. Try a positive number (e.g. `30000` for Robux, `50.5` for USD).',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (currency === 'ROBUX' && !Number.isInteger(amount)) {
    return interaction.reply({
      content: '❌ Robux must be a whole number (no decimals).',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Resolve the ticket → client.
  const ticketChannel = interaction.guild.channels.cache.get(ticketChannelId);
  if (!ticketChannel) {
    return interaction.editReply({
      content:
        "❌ Could not find the ticket channel anymore. Was it deleted?",
    });
  }
  const ticketName = stripPriorityDots(ticketChannel.name);
  const clientId = findTicketOwner(ticketChannel, client.user.id);
  let clientName = 'unknown';
  if (clientId) {
    const m = await interaction.guild.members
      .fetch(clientId)
      .catch(() => null);
    if (m) clientName = m.user.username;
  }

  const tx = {
    type: 'delivery',
    designer: interaction.user.id,
    designerName: interaction.user.username,
    client: clientId || 'unknown',
    clientName,
    ticket: ticketChannelId,
    ticketName,
    currency,
    amount,
    timestamp: Date.now(),
  };

  try {
    await logTransaction(interaction.guild, tx);
  } catch (e) {
    console.error('logTransaction failed:', e?.message);
    return interaction.editReply({
      content:
        '❌ Could not save the delivery. Make sure the bot has access to the payments-log channel.',
    });
  }

  // Auto-clear the deadline now that the delivery has been logged.
  // Avoids the designer having to remember to run /dueby clear, and
  // keeps /deadlines + the priority dot in sync with reality.
  // We swallow the result — clearChannelDueby handles its own
  // rate-limit fallback for the rename.
  let hadDeadline = false;
  if (
    dueByMap.has(ticketChannelId) ||
    readDueByFromTopic(ticketChannel) != null
  ) {
    hadDeadline = true;
    clearChannelDueby(ticketChannel).catch((e) =>
      console.error('auto-clear deadline on /done failed:', e?.message),
    );
  }

  const formatted =
    currency === 'ROBUX' ? formatRobux(amount) : formatUSD(amount);

  const embed = new EmbedBuilder()
    .setTitle('✅ Delivery logged')
    .setDescription(
      'Recorded **' +
        formatted +
        '** for **' +
        ticketName +
        '**' +
        (clientId ? ' (client: <@' + clientId + '>)' : '') +
        '.\n\nUse `/payments` to see your running balance.' +
        (hadDeadline ? '\n\n*Deadline cleared automatically.*' : ''),
    )
    .setColor(0x22c55e)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// =====================================================================
// /payments view / /payments paid
// =====================================================================

async function cmdPayments(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'view') return cmdPaymentsView(interaction);
  if (sub === 'paid') return cmdPaymentsPaid(interaction);
}

// Founder/staff/admin overview: every designer with a non-zero
// pending balance (since their last payout). Sorted by most-owed
// USD desc, with Robux as a tiebreaker.
async function renderGlobalPaymentsDashboard(interaction) {
  const rows = [];
  let totalRobux = 0;
  let totalUSD = 0;
  for (const [designerId, row] of paymentsLedger.entries()) {
    if (row.robux === 0 && row.usd === 0) continue;
    rows.push({
      designerId,
      robux: row.robux,
      usd: row.usd,
      entries: row.entries,
    });
    totalRobux += row.robux;
    totalUSD += row.usd;
  }

  if (rows.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('💼 Pending payments — agency overview')
          .setDescription('No designer has a pending balance. Clean slate. 🧹')
          .setColor(0x6b7280),
      ],
    });
  }

  rows.sort((a, b) => b.usd - a.usd || b.robux - a.robux);

  const lines = rows.map((r) => {
    const parts = [];
    if (r.robux > 0) parts.push(formatRobux(r.robux));
    if (r.usd > 0) parts.push(formatUSD(r.usd));
    return '<@' + r.designerId + '> — ' + parts.join(' + ');
  });

  const totalParts = [];
  if (totalRobux > 0) totalParts.push('🔵 ' + formatRobux(totalRobux));
  if (totalUSD > 0) totalParts.push('💵 ' + formatUSD(totalUSD));

  const embed = new EmbedBuilder()
    .setTitle('💼 Pending payments — agency overview')
    .setColor(0x3b82f6)
    .addFields(
      {
        name: '🏦 Total owed (all designers)',
        value: totalParts.join('\n') || 'Nothing.',
        inline: false,
      },
      {
        name: '👤 Per designer (' + rows.length + ')',
        value: lines.join('\n'),
        inline: false,
      },
    )
    .setFooter({
      text:
        'Use /payments view user:@designer for per-client breakdown · /payments paid to settle',
    })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function cmdPaymentsView(interaction) {
  const scope = interaction.options.getString('scope'); // 'all' or null
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // scope = "all" → global dashboard, but ONLY founder/staff/admin
  // can see other designers' balances. Designers run /payments view
  // (no scope) to see their own.
  if (scope === 'all') {
    const isManager = interaction.member
      ? canManage(interaction.member)
      : await isManagerUser(interaction.user.id);
    if (!isManager) {
      return interaction.editReply({
        content:
          'Only founders, staff, or admins can use the **All** scope. Run `/payments view` without the scope option to see your own balance.',
      });
    }
    return renderGlobalPaymentsDashboard(interaction);
  }

  // Default: caller's own balance.
  const target = interaction.user;
  const isSelf = true;
  const row = paymentsLedger.get(target.id);
  if (!row || (row.robux === 0 && row.usd === 0)) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('💼 Pending payments')
          .setDescription(
            (isSelf
              ? 'You have'
              : '<@' + target.id + '> has') +
              ' nothing pending right now. Clean slate. 🧹',
          )
          .setColor(0x6b7280),
      ],
    });
  }

  // Group only the OPEN deliveries (those that haven't been settled
  // by a later payout) by client. Walk entries in order and rebuild
  // the running balance per client; entries before the most recent
  // payout drop out, the rest stack up.
  // For simplicity we treat the sum since the LAST payout as
  // "currently pending" — anything before that has been paid.
  let lastPayoutTs = 0;
  for (const e of row.entries) {
    if (e.type === 'payout' && e.timestamp > lastPayoutTs) {
      lastPayoutTs = e.timestamp;
    }
  }
  const openDeliveries = row.entries.filter(
    (e) => e.type === 'delivery' && e.timestamp > lastPayoutTs,
  );
  // Group by client.
  const byClient = new Map();
  for (const d of openDeliveries) {
    const key = d.client || 'unknown';
    let bucket = byClient.get(key);
    if (!bucket) {
      bucket = {
        clientName: d.clientName || 'unknown',
        robux: 0,
        usd: 0,
        count: 0,
      };
      byClient.set(key, bucket);
    }
    if (d.currency === 'ROBUX') bucket.robux += d.amount;
    else if (d.currency === 'USD') bucket.usd += d.amount;
    bucket.count++;
  }

  // Header totals
  const totalLines = [];
  if (row.robux > 0) totalLines.push('🔵 ' + formatRobux(row.robux));
  if (row.usd > 0) totalLines.push('💵 ' + formatUSD(row.usd));

  // Per-client breakdown
  const clientLines = [];
  for (const [clientId, bucket] of byClient.entries()) {
    const parts = [];
    if (bucket.robux > 0) parts.push(formatRobux(bucket.robux));
    if (bucket.usd > 0) parts.push(formatUSD(bucket.usd));
    const mention =
      clientId === 'unknown' ? '*unknown client*' : '<@' + clientId + '>';
    clientLines.push(
      mention +
        ' — ' +
        parts.join(' + ') +
        ' · ' +
        bucket.count +
        ' deliver' +
        (bucket.count === 1 ? 'y' : 'ies'),
    );
  }

  // Recent deliveries (last 5)
  const recent = openDeliveries
    .slice(-5)
    .reverse()
    .map((d) => {
      const formatted =
        d.currency === 'ROBUX' ? formatRobux(d.amount) : formatUSD(d.amount);
      return (
        '• `' +
        d.ticketName +
        '` — ' +
        formatted +
        ' · <t:' +
        Math.floor(d.timestamp / 1000) +
        ':d>'
      );
    });

  const embed = new EmbedBuilder()
    .setTitle(
      '💼 Pending payments — ' +
        (isSelf ? 'you' : target.username),
    )
    .setColor(0x3b82f6)
    .addFields(
      {
        name: '💰 Total owed',
        value: totalLines.join('\n') || 'Nothing.',
        inline: false,
      },
      {
        name: '👥 By client',
        value: clientLines.join('\n') || '—',
        inline: false,
      },
      {
        name: '📜 Recent deliveries',
        value: recent.join('\n') || '—',
        inline: false,
      },
    )
    .setFooter({ text: 'Cube Graphics · payouts run on the 1st of each month' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// Founder-only settlement flow. Roblox gamepass payouts settle 5
// days after the buyer's purchase, so on payday a chunk of
// "pending" Robux can still be in transit. The founder picks a
// designer from a dropdown, then chooses either:
//   - "Pay everything" → settles the full pending balance (one click)
//   - "Pay partial..." → opens a modal with Robux + USD inputs
//   - "Back" → returns to the designer picker
// Anything not paid stays on the ledger for next payday.
//
// Session state lives in payoutSessions: founderUserId →
//   { settled: [{designerId, robux, usd, ts}], guildId, startedAt }
// (Pending balances are read live from paymentsLedger so they stay
// accurate across multiple settlements in the same session.)
const payoutSessions = new Map();

async function cmdPaymentsPaid(interaction) {
  // Founder check that works in both guild and DM context.
  const founder = interaction.member
    ? interaction.member.roles?.cache?.has(FOUNDER_ROLE_ID)
    : await isFounderUser(interaction.user.id);

  if (!founder) {
    return interaction.reply({
      content: 'Only founders can settle payments.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (collectPendingDesigners().length === 0) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('💸 Nothing to settle')
          .setDescription('No designer has a pending balance right now.')
          .setColor(0x6b7280),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  // In DM context interaction.guild is null. Find the guild where
  // the founder lives so logTransaction can write to its
  // #payments-log channel.
  const guild =
    interaction.guild || (await getFounderGuild(interaction.user.id));
  if (!guild) {
    return interaction.reply({
      content:
        '❌ Could not find a Cube Graphics guild for you. Make sure the bot shares a server with you and you have the founder role.',
      flags: MessageFlags.Ephemeral,
    });
  }

  payoutSessions.set(interaction.user.id, {
    settled: [],
    guildId: guild.id,
    startedAt: Date.now(),
  });

  await interaction.reply({
    embeds: [renderPickerEmbed(interaction.user.id)],
    components: buildPickerComponents(),
    flags: MessageFlags.Ephemeral,
  });
}

// Resolve the guild a payout session is bound to (set when the
// session was created). Used by handlers so DM-context interactions
// still know where to log the transaction.
async function getSessionGuild(session) {
  if (!session) return null;
  return client.guilds.cache.get(session.guildId) || null;
}

// Snapshot every designer with > 0 pending balance, sorted by USD
// owed desc + Robux as tiebreaker. Read live from paymentsLedger.
function collectPendingDesigners() {
  const out = [];
  for (const [designerId, row] of paymentsLedger.entries()) {
    if (row.robux > 0 || row.usd > 0) {
      out.push({ designerId, robux: row.robux, usd: row.usd, entries: row.entries });
    }
  }
  out.sort((a, b) => b.usd - a.usd || b.robux - a.robux);
  return out;
}

// Look up a friendly designer name from the most recent ledger
// entry that carries one. Used by the picker dropdown labels.
function resolveDesignerName(designerId) {
  const row = paymentsLedger.get(designerId);
  if (!row || !row.entries.length) return designerId;
  for (let i = row.entries.length - 1; i >= 0; i--) {
    const e = row.entries[i];
    if (e.designerName) return e.designerName;
  }
  return designerId;
}

function renderPickerEmbed(founderId) {
  const session = payoutSessions.get(founderId);
  const pending = collectPendingDesigners();

  const pendingLines = pending.map((p) => {
    const parts = [];
    if (p.robux > 0) parts.push(formatRobux(p.robux));
    if (p.usd > 0) parts.push(formatUSD(p.usd));
    return '⏳ <@' + p.designerId + '> — ' + parts.join(' + ');
  });

  const settledLines = (session?.settled || []).map((s) => {
    const parts = [];
    if (s.robux > 0) parts.push(formatRobux(s.robux));
    if (s.usd > 0) parts.push(formatUSD(s.usd));
    return '✅ <@' + s.designerId + '> — ' + parts.join(' + ');
  });

  return new EmbedBuilder()
    .setTitle('💸 Settle payments')
    .setDescription(
      'Pick a designer from the dropdown to settle their balance. You can pay everything in one click, or enter a partial amount if part of it is still in transit (gamepass purchases take 5 days to land in the group).',
    )
    .addFields(
      {
        name: '⏳ Still pending',
        value: pendingLines.length ? pendingLines.join('\n') : '*All clear.*',
        inline: false,
      },
      {
        name: '✅ Settled this session',
        value: settledLines.length ? settledLines.join('\n') : '*Nothing yet.*',
        inline: false,
      },
    )
    .setColor(pendingLines.length ? 0xf59e0b : 0x22c55e)
    .setFooter({
      text: 'Cube Graphics · payouts run on the 1st of each month',
    });
}

function buildPickerComponents() {
  const pending = collectPendingDesigners();
  if (pending.length === 0) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('payments:paid_finish')
          .setLabel('Done')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🎉'),
      ),
    ];
  }

  // Discord caps select-menu options at 25 — well above any
  // realistic pending list, but slice defensively.
  const select = new StringSelectMenuBuilder()
    .setCustomId('payments:paid_pick')
    .setPlaceholder('Pick a designer to settle…')
    .addOptions(
      pending.slice(0, 25).map((p) => {
        const parts = [];
        if (p.robux > 0) parts.push(formatRobux(p.robux));
        if (p.usd > 0) parts.push(formatUSD(p.usd));
        return new StringSelectMenuOptionBuilder()
          .setLabel(resolveDesignerName(p.designerId).slice(0, 80))
          .setDescription((parts.join(' + ') || '—').slice(0, 100))
          .setValue(p.designerId);
      }),
    );

  return [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('payments:paid_finish')
        .setLabel('Done')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🏁'),
    ),
  ];
}

function renderDesignerPanel(designerId) {
  const row = paymentsLedger.get(designerId);
  const robux = row ? row.robux : 0;
  const usd = row ? row.usd : 0;
  const parts = [];
  if (robux > 0) parts.push('🔵 ' + formatRobux(robux));
  if (usd > 0) parts.push('💵 ' + formatUSD(usd));

  return new EmbedBuilder()
    .setTitle('💸 Settle <designer>')
    .setDescription(
      'Settling **<@' +
        designerId +
        ">**'s balance.\n\n" +
        '**Pending**\n' +
        (parts.join('\n') || '*Nothing pending*') +
        '\n\nUse **Pay everything** to clear it all in one click, or **Pay partial** if part of the money is still in transit.',
    )
    .setColor(0xf59e0b);
}

function buildDesignerPanelComponents(designerId) {
  const row = paymentsLedger.get(designerId);
  const hasBalance = row && (row.robux > 0 || row.usd > 0);

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('payments:paid_full:' + designerId)
        .setLabel('Pay everything')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅')
        .setDisabled(!hasBalance),
      new ButtonBuilder()
        .setCustomId('payments:paid_partial:' + designerId)
        .setLabel('Pay partial…')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('💸')
        .setDisabled(!hasBalance),
      new ButtonBuilder()
        .setCustomId('payments:paid_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⬅️'),
    ),
  ];
}

async function handlePaymentsSelect(interaction) {
  const founder = interaction.member
    ? interaction.member.roles?.cache?.has(FOUNDER_ROLE_ID)
    : await isFounderUser(interaction.user.id);
  if (!founder) {
    return interaction.reply({
      content: 'Only founders can settle payments.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const session = payoutSessions.get(interaction.user.id);
  if (!session) {
    return interaction.reply({
      content:
        'Your payout session expired. Run `/payments paid` again.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const designerId = interaction.values[0];
  await interaction.update({
    embeds: [renderDesignerPanel(designerId)],
    components: buildDesignerPanelComponents(designerId),
  });
}

async function handlePaymentsButton(interaction) {
  if (interaction.customId === 'payments:paid_cancel') {
    payoutSessions.delete(interaction.user.id);
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Cancelled')
          .setDescription('Payout session abandoned. Nothing was logged.')
          .setColor(0x6b7280),
      ],
      components: [],
    });
  }

  if (interaction.customId === 'payments:paid_finish') {
    payoutSessions.delete(interaction.user.id);
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('🏁 Payout session finished')
          .setDescription(
            'All chosen settlements were logged. Run `/payments view` to verify any remaining balances.',
          )
          .setColor(0x22c55e),
      ],
      components: [],
    });
  }

  // Back to the designer picker.
  if (interaction.customId === 'payments:paid_back') {
    if (!payoutSessions.has(interaction.user.id)) {
      return interaction.reply({
        content:
          'Your payout session expired. Run `/payments paid` again.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.update({
      embeds: [renderPickerEmbed(interaction.user.id)],
      components: buildPickerComponents(),
    });
  }

  // Pay everything (full balance) for one designer in one click.
  if (interaction.customId.startsWith('payments:paid_full:')) {
    const founderCheck = interaction.member
      ? interaction.member.roles?.cache?.has(FOUNDER_ROLE_ID)
      : await isFounderUser(interaction.user.id);
    if (!founderCheck) {
      return interaction.reply({
        content: 'Only founders can settle payments.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const session = payoutSessions.get(interaction.user.id);
    if (!session) {
      return interaction.reply({
        content:
          'Your payout session expired. Run `/payments paid` again.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const designerId = interaction.customId.split(':')[2];
    const row = paymentsLedger.get(designerId);
    if (!row || (row.robux === 0 && row.usd === 0)) {
      return interaction.reply({
        content: 'That designer has no pending balance left.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const tx = {
      type: 'payout',
      designer: designerId,
      designerName: resolveDesignerName(designerId),
      robux: row.robux,
      usd: row.usd,
      timestamp: Date.now(),
    };
    // Sessions store guildId so DM-context interactions still know
    // where to write the transaction.
    const targetGuild =
      interaction.guild || (await getSessionGuild(session));
    if (!targetGuild) {
      return interaction.reply({
        content: '❌ Lost track of the guild for this session.',
        flags: MessageFlags.Ephemeral,
      });
    }
    try {
      await logTransaction(targetGuild, tx);
    } catch (e) {
      console.error('full payout failed:', e?.message);
      return interaction.reply({
        content:
          '❌ Could not log the payout. Check the bot has access to the payments-log channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    session.settled.push({
      designerId,
      robux: tx.robux,
      usd: tx.usd,
      ts: Date.now(),
    });

    return interaction.update({
      embeds: [renderPickerEmbed(interaction.user.id)],
      components: buildPickerComponents(),
    });
  }

  // Pay partial — open the modal.
  if (interaction.customId.startsWith('payments:paid_partial:')) {
    const founderCheck = interaction.member
      ? interaction.member.roles?.cache?.has(FOUNDER_ROLE_ID)
      : await isFounderUser(interaction.user.id);
    if (!founderCheck) {
      return interaction.reply({
        content: 'Only founders can settle payments.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const session = payoutSessions.get(interaction.user.id);
    if (!session) {
      return interaction.reply({
        content:
          'Your payout session expired. Run `/payments paid` again.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const designerId = interaction.customId.split(':')[2];
    const row = paymentsLedger.get(designerId);
    if (!row || (row.robux === 0 && row.usd === 0)) {
      return interaction.reply({
        content: 'That designer has no pending balance left.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('payments:paid_modal:' + designerId)
      .setTitle(
        ('Settle ' + resolveDesignerName(designerId)).slice(0, 45),
      );

    const robuxInput = new TextInputBuilder()
      .setCustomId('robux')
      .setLabel(
        'Robux paid (pending: ' +
          (row.robux > 0 ? row.robux.toLocaleString('en-US') : '0') +
          ')',
      )
      .setPlaceholder(
        row.robux > 0 ? '0 - ' + row.robux : '0',
      )
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(12);

    const usdInput = new TextInputBuilder()
      .setCustomId('usd')
      .setLabel(
        'USD paid (pending: $' +
          (row.usd > 0 ? row.usd.toFixed(2) : '0.00') +
          ')',
      )
      .setPlaceholder(row.usd > 0 ? '0 - ' + row.usd.toFixed(2) : '0')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(12);

    modal.addComponents(
      new ActionRowBuilder().addComponents(robuxInput),
      new ActionRowBuilder().addComponents(usdInput),
    );

    await interaction.showModal(modal);
  }
}

async function handlePaymentsModalSubmit(interaction) {
  // Format: payments:paid_modal:<designerId>
  const designerId = interaction.customId.split(':')[2];
  const session = payoutSessions.get(interaction.user.id);
  if (!session) {
    return interaction.reply({
      content:
        'Your payout session expired. Run `/payments paid` again.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const founderModalCheck = interaction.member
    ? interaction.member.roles?.cache?.has(FOUNDER_ROLE_ID)
    : await isFounderUser(interaction.user.id);
  if (!founderModalCheck) {
    return interaction.reply({
      content: 'Only founders can settle payments.',
      flags: MessageFlags.Ephemeral,
    });
  }
  // Read the live balance straight from paymentsLedger so it
  // reflects any other settlements (or new deliveries) since the
  // session started.
  const ledgerRow = paymentsLedger.get(designerId);
  if (!ledgerRow || (ledgerRow.robux === 0 && ledgerRow.usd === 0)) {
    return interaction.reply({
      content: 'That designer has no pending balance left.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const pendingRobux = ledgerRow.robux;
  const pendingUSD = ledgerRow.usd;

  const parseAmount = (raw) => {
    if (!raw) return 0;
    const cleaned = String(raw).replace(/[^0-9.,]/g, '').replace(/,/g, '.');
    if (!cleaned) return 0;
    const n = parseFloat(cleaned);
    return isFinite(n) && n > 0 ? n : 0;
  };

  const robuxPaid = parseAmount(
    interaction.fields.getTextInputValue('robux'),
  );
  const usdPaid = parseAmount(interaction.fields.getTextInputValue('usd'));

  if (robuxPaid === 0 && usdPaid === 0) {
    return interaction.reply({
      content:
        '❌ You entered nothing. Type at least one amount, or click Back to pick another designer.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (robuxPaid > pendingRobux + 0.0001) {
    return interaction.reply({
      content:
        '❌ Robux amount exceeds the pending balance (' +
        pendingRobux.toLocaleString('en-US') +
        ').',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (usdPaid > pendingUSD + 0.0001) {
    return interaction.reply({
      content:
        '❌ USD amount exceeds the pending balance ($' +
        pendingUSD.toFixed(2) +
        ').',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (Math.floor(robuxPaid) !== robuxPaid || robuxPaid < 0) {
    return interaction.reply({
      content: '❌ Robux must be a non-negative whole number.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tx = {
    type: 'payout',
    designer: designerId,
    designerName: resolveDesignerName(designerId),
    robux: robuxPaid,
    usd: usdPaid,
    timestamp: Date.now(),
  };

  const partialTargetGuild =
    interaction.guild || (await getSessionGuild(session));
  if (!partialTargetGuild) {
    return interaction.editReply({
      content: '❌ Lost track of the guild for this session.',
    });
  }
  try {
    await logTransaction(partialTargetGuild, tx);
  } catch (e) {
    console.error('partial payout failed:', e?.message);
    return interaction.editReply({
      content:
        '❌ Could not log the payout. Check the bot has access to the payments-log channel.',
    });
  }

  session.settled.push({
    designerId,
    robux: robuxPaid,
    usd: usdPaid,
    ts: Date.now(),
  });

  // Modal submits can't update the original ephemeral message, so
  // we acknowledge the modal here, then refresh the original
  // panel via interaction.message if it exists. As a fallback, the
  // user can click "Back" to manually refresh.
  await interaction.editReply({
    content:
      '✅ Logged ' +
      [
        robuxPaid > 0 ? formatRobux(robuxPaid) : null,
        usdPaid > 0 ? formatUSD(usdPaid) : null,
      ]
        .filter(Boolean)
        .join(' + ') +
      ' to <@' +
      designerId +
      '>. Open `/payments paid` again or click Back to pick the next designer.',
  });
}

// /reminder — sends a placeholder deadline reminder DM to a chosen
// user. Pure testing tool: confirms DMs are reaching the recipient.
// The placeholder content mirrors the real daily-6am reminder
// embed shape (priority dot title + deadline timestamp + ping line)
// so it doubles as a visual smoke test for that template.
async function cmdReminder(interaction) {
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: 'Only founders, staff, or admins can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const target = interaction.options.getUser('user');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Fake a deadline 2 days out so the priority dot lands on yellow
  // and the user can see what the rendered reminder actually
  // looks like.
  const fakeDeadline = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const tsSec = Math.floor(fakeDeadline / 1000);
  const dot = priorityDotForDeadline(fakeDeadline) || '⚪';
  const color =
    dot === '🔴' ? 0xef4444 : dot === '🟡' ? 0xf59e0b : 0x22c55e;

  const embed = new EmbedBuilder()
    .setTitle(dot + ' Deadline reminder · placeholder')
    .setDescription(
      "Hey <@" +
        target.id +
        ">! This is a **test** reminder DM from the Cube Tickets bot.\n\n" +
        'Deadline (placeholder): <t:' +
        tsSec +
        ':R>\n' +
        'Full date: <t:' +
        tsSec +
        ':F>\n\n' +
        'If you can read this, DMs are working — ignore the message.',
    )
    .setColor(color)
    .setFooter({ text: 'Cube Tickets · automated test' })
    .setTimestamp();

  try {
    const dm = await target.createDM();
    await dm.send({ embeds: [embed] });
    return interaction.editReply({
      content:
        '✅ Test reminder DM sent to **' + target.username + '**.',
    });
  } catch (e) {
    console.error('cmdReminder DM failed:', e?.message);
    return interaction.editReply({
      content:
        '❌ Could not DM **' +
        target.username +
        '**. They probably have DMs closed for this server, or have blocked the bot.',
    });
  }
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
  soul: 'Soul',
  art: 'Art',
  pontin: 'Pontin',
  zack: 'Zack',
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
  // guild, interaction.guild is null — collectUserTicketsWithDeadlines
  // walks every guild the bot is in.
  const targetUser = interaction.options.getUser('user') || interaction.user;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rows = collectUserTicketsWithDeadlines(targetUser.id);

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
        '<:j_dot:1415844475120386230> `/sample` — Show a designer\'s sample work · S0da / Will / Nosher / Trispil / Soul / Art / Pontin / Zack · works in DMs too\n' +
        '<:j_dot:1415844475120386230> `/deadlines` — Show your (or someone else\'s) active deadlines · works in DMs too\n\n' +
        '**Founder / Staff / Admin**\n' +
        '<:j_dot:1415844475120386230> `/ordermsg` — Post the order banner with the Open-a-Ticket button (admin only)\n' +
        '<:j_dot:1415844475120386230> `/ticket user: [designer1: ...]` — Manually open a TICKETS-category project ticket (up to 4 designers optional)\n' +
        '<:j_dot:1415844475120386230> `/audit user:` — Open an AUDITS ticket · auto-adds the RTG team\n' +
        '<:j_dot:1415844475120386230> `/redirect designer1: [designer2: ...]` — Spin up a TICKETS channel from a talk (up to 5 designers)\n' +
        '<:j_dot:1415844475120386230> `/addticket user1: [user2: ...]` — Add up to 5 users to the current ticket\n' +
        '<:j_dot:1415844475120386230> `/removeticket user1: [user2: ...]` — Revoke up to 5 users from the current ticket\n' +
        '<:j_dot:1415844475120386230> `/dueby when:` — Set / show / clear the deadline (e.g. `2 days`, `tomorrow`, `clear`)\n' +
        '<:j_dot:1415844475120386230> `/load [user:]` — Show how many active deadlines a user is on\n' +
        '<:j_dot:1415844475120386230> `/done` — Designer logs a delivery (price panel, Robux or USD)\n' +
        '<:j_dot:1415844475120386230> `/payments view [user:]` — Show pending payments\n' +
        '<:j_dot:1415844475120386230> `/payments paid` — Settle every pending payment (founder only)\n' +
        '<:j_dot:1415844475120386230> `/reminder user:` — Send a placeholder reminder DM (testing)',
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

    setChannelOwner(ticketChannel, member.id);

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

    setChannelOwner(auditChannel, member.id);

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

    // Persist the owner ID in the topic so findTicketOwner stays
    // deterministic even when designers are also Member overrides.
    setChannelOwner(ticketChannel, clientMember.id);

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
