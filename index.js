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
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Roles that always have full access to every ticket (talk + order).
const FOUNDER_ROLE_ID = '1095002049713807390';
const STAFF_ROLE_ID = '1459610315863101735';

const TALK_CATEGORY_NAME = 'TALK';
const TICKET_CATEGORY_NAME = 'TICKETS';

// ============================================
// HELPERS
// ============================================

// Build the safe-for-channel-name slug for a user (lowercase a-z0-9
// with non-matching chars replaced by `-`). Centralized so the
// "open a ticket" button, !ticket admin shortcut, and existing-
// ticket lookup all agree on the same string.
function safeUsernameSlug(member) {
  return member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function isTalkChannel(channel) {
  if (channel.name && channel.name.startsWith('talk-')) return true;
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
  if (channel.name && channel.name.startsWith('ticket-')) return true;
  if (
    channel.parent &&
    channel.parent.name &&
    channel.parent.name.toUpperCase() === TICKET_CATEGORY_NAME
  ) {
    return true;
  }
  return false;
}

function isAnyTicketChannel(channel) {
  return isTalkChannel(channel) || isOrderChannel(channel);
}

// Founder, Staff, and server admins can run management commands
// (!redirect, !addticket, !removeticket).
function canManage(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
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

client.once('ready', () => {
  console.log(`Bot online as ${client.user.tag}`);
  client.user.setActivity('Cube Graphics Orders', { type: 3 });
});

// ============================================
// COMMANDS
// ============================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith('!')) return;

  const args = message.content.slice(1).split(/\s+/).filter(Boolean);
  const cmd = (args.shift() || '').toLowerCase();

  // !ordermsg — admin: posts the permanent banner with the
  // "Open a Ticket" button. Primary client entry point in Discord.
  if (cmd === 'ordermsg') {
    if (
      !message.member.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      return message.reply('Only admins can use this command.');
    }

    message.delete().catch(() => {});

    let bannerFile = null;
    try {
      const fs = require('fs');
      if (fs.existsSync('./ORDER_NOW_-_BANNER.png')) {
        bannerFile = new AttachmentBuilder('./ORDER_NOW_-_BANNER.png', {
          name: 'banner.png',
        });
      }
    } catch (e) {
      // No banner is fine — the embed just renders without an image.
    }

    const orderEmbed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setDescription(
        '<:Blue_Ticket:1415843891894026271> **READY TO BOOST YOUR GAME?** <:Blue_Ticket:1415843891894026271>\n\n' +
          '<:j_dot:1415844475120386230> Open a ticket right here and our team will help you create **stunning thumbnails and icons** for your Roblox game!',
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

    await message.channel.send(sendOptions);
  }

  // !close — close the current ticket (5s grace, then channel delete).
  if (cmd === 'close') {
    if (isAnyTicketChannel(message.channel)) {
      const embed = new EmbedBuilder()
        .setTitle('Ticket Closing')
        .setDescription('This ticket will be deleted in 5 seconds.')
        .setColor(0xef4444);
      await message.channel.send({ embeds: [embed] });
      setTimeout(() => message.channel.delete().catch(() => {}), 5000);
    }
  }

  // !ticket @user — admin shortcut: manually open a TALK ticket for
  // the mentioned user (same flow as the public Open-a-Ticket button).
  if (cmd === 'ticket' && message.mentions.members.size > 0) {
    if (!canManage(message.member)) {
      return message.reply(
        'Only founders, staff, or admins can use this command.',
      );
    }
    const member = message.mentions.members.first();
    const ticket = await createTalkTicket(message.guild, member);
    if (ticket) {
      message.reply(
        'Talk ticket created for ' + member.displayName + ': <#' + ticket.id + '>',
      );
    }
  }

  // !redirect @designer1 [@designer2 ...] — used in a TALK channel
  // by founder/staff/admin once the deal is locked. Pulls the talk's
  // owner out of the permission overwrites and spins up a new
  // TICKETS-category channel that includes the client + every
  // mentioned designer (founder/staff already have access to every
  // category-level ticket via their roles).
  if (cmd === 'redirect') {
    if (!canManage(message.member)) {
      return message.reply(
        'Only founders, staff, or admins can use this command.',
      );
    }
    if (!isTalkChannel(message.channel)) {
      return message.reply('This command only works inside a talk channel.');
    }
    if (message.mentions.members.size === 0) {
      return message.reply(
        'Mention at least one designer: `!redirect @user [@user2 ...]`',
      );
    }

    const ownerId = findTicketOwner(message.channel, client.user.id);
    if (!ownerId) {
      return message.reply(
        'Could not find this talk channel\'s client. Aborting.',
      );
    }

    let clientMember;
    try {
      clientMember = await message.guild.members.fetch(ownerId);
    } catch (e) {
      return message.reply(
        'The original client is no longer in the server. Aborting.',
      );
    }

    const designers = Array.from(message.mentions.members.values()).filter(
      (m) => m.id !== clientMember.id && m.id !== client.user.id,
    );

    if (designers.length === 0) {
      return message.reply(
        'Mention at least one designer (other than the client / bot).',
      );
    }

    const newTicket = await createOrderTicket(
      message.guild,
      clientMember,
      designers,
    );

    if (newTicket) {
      const designerMentions = designers
        .map((d) => '<@' + d.id + '>')
        .join(' ');
      await message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Redirected to project ticket')
            .setDescription(
              'New project ticket: <#' +
                newTicket.id +
                '>\n\nDesigner(s): ' +
                designerMentions +
                '\n\nThis talk channel stays open for further discussion. Use `!close` here when you no longer need it.',
            )
            .setColor(0x22c55e),
        ],
      });
    }
  }

  // !addticket @user [@user2 ...] — grant the mentioned users access
  // to the current ticket (talk OR order). Founder/staff/admin only.
  if (cmd === 'addticket') {
    if (!canManage(message.member)) {
      return message.reply(
        'Only founders, staff, or admins can use this command.',
      );
    }
    if (!isAnyTicketChannel(message.channel)) {
      return message.reply('This command only works inside a ticket channel.');
    }
    if (message.mentions.members.size === 0) {
      return message.reply('Mention at least one user: `!addticket @user`');
    }

    const added = [];
    for (const m of message.mentions.members.values()) {
      try {
        await message.channel.permissionOverwrites.edit(m.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
        added.push('<@' + m.id + '>');
      } catch (e) {
        console.error('addticket failed for', m.id, e);
      }
    }

    if (added.length === 0) {
      return message.reply('Could not add anyone — check the bot\'s permissions.');
    }

    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Added to ticket')
          .setDescription('✅ ' + added.join(', ') + ' added to this channel.')
          .setColor(0x22c55e),
      ],
    });
  }

  // !removeticket @user [@user2 ...] — revoke a user's access. Will
  // refuse to remove the bot, the owner, or anyone with the founder
  // / staff role (those are protected by their role override anyway).
  if (cmd === 'removeticket') {
    if (!canManage(message.member)) {
      return message.reply(
        'Only founders, staff, or admins can use this command.',
      );
    }
    if (!isAnyTicketChannel(message.channel)) {
      return message.reply('This command only works inside a ticket channel.');
    }
    if (message.mentions.members.size === 0) {
      return message.reply('Mention at least one user: `!removeticket @user`');
    }

    const ownerId = findTicketOwner(message.channel, client.user.id);
    const removed = [];
    const skipped = [];

    for (const m of message.mentions.members.values()) {
      if (m.id === client.user.id) {
        skipped.push('<@' + m.id + '> (bot)');
        continue;
      }
      if (m.id === ownerId) {
        skipped.push('<@' + m.id + '> (ticket owner)');
        continue;
      }
      if (m.roles.cache.has(FOUNDER_ROLE_ID)) {
        skipped.push('<@' + m.id + '> (founder)');
        continue;
      }
      if (m.roles.cache.has(STAFF_ROLE_ID)) {
        skipped.push('<@' + m.id + '> (staff)');
        continue;
      }
      try {
        await message.channel.permissionOverwrites.delete(m.id);
        removed.push('<@' + m.id + '>');
      } catch (e) {
        console.error('removeticket failed for', m.id, e);
      }
    }

    const lines = [];
    if (removed.length > 0) {
      lines.push('✅ Removed: ' + removed.join(', '));
    }
    if (skipped.length > 0) {
      lines.push('⚠️ Skipped: ' + skipped.join(', '));
    }
    if (lines.length === 0) {
      return message.reply('Nothing to do.');
    }

    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Removed from ticket')
          .setDescription(lines.join('\n'))
          .setColor(0xef4444),
      ],
    });
  }

  // !help — list every command currently available, grouped by who
  // can use it. Update this block whenever a command is added or
  // removed so it stays in sync with reality.
  if (cmd === 'help') {
    const helpEmbed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('<:Blue_Ticket:1415843891894026271>  Cube Tickets — Commands')
      .setDescription(
        '**Everyone**\n' +
          '<:j_dot:1415844475120386230> `!help` — Show this list\n' +
          '<:j_dot:1415844475120386230> `!close` — Close the current ticket (talk OR order)\n\n' +
          '**Founder / Staff / Admin**\n' +
          '<:j_dot:1415844475120386230> `!ordermsg` — Post the order banner with the Open-a-Ticket button (admin only)\n' +
          '<:j_dot:1415844475120386230> `!ticket @user` — Manually open a TALK ticket for the mentioned user\n' +
          '<:j_dot:1415844475120386230> `!redirect @user [@user2 ...]` — Inside a talk channel: spin up a new TICKETS-category channel for the same client with the mentioned designer(s)\n' +
          '<:j_dot:1415844475120386230> `!addticket @user [@user2 ...]` — Add the mentioned users to the current ticket\n' +
          '<:j_dot:1415844475120386230> `!removeticket @user [@user2 ...]` — Revoke the mentioned users\' access to the current ticket',
      )
      .setTimestamp();
    return message.channel.send({ embeds: [helpEmbed] });
  }
});

// ============================================
// INTERACTIONS (buttons)
// ============================================
client.on(Events.InteractionCreate, async (interaction) => {
  // "Open a Ticket" button on the !ordermsg banner — opens a TALK
  // ticket for the clicker (Founder + Staff also get access via
  // their roles, no other designers yet — they're added by
  // !redirect once the deal is locked).
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const member = interaction.member;
      const guild = interaction.guild;
      const slug = safeUsernameSlug(member);

      const existing = guild.channels.cache.find(
        (ch) =>
          (ch.name === 'talk-' + slug || ch.name === 'ticket-' + slug) &&
          ch.parentId,
      );

      if (existing) {
        return interaction.editReply({
          content:
            '🎫 You already have an open ticket: <#' + existing.id + '>',
        });
      }

      const newTalk = await createTalkTicket(guild, member);

      if (newTalk) {
        interaction.editReply({
          content: '🎫 Your ticket has been created: <#' + newTalk.id + '>',
        });
      } else {
        interaction.editReply({
          content:
            '🎫 Your ticket is being created! Check the talk category.',
        });
      }
    } catch (e) {
      console.error('Ticket button error:', e);
      interaction.editReply({
        content: '❌ Error creating ticket. Please try again.',
      });
    }
  }

  // "Close Ticket" button inside a ticket's welcome embed.
  if (interaction.isButton() && interaction.customId === 'close_ticket') {
    const embed = new EmbedBuilder()
      .setTitle('Ticket Closing')
      .setDescription('Deleting in 5 seconds.')
      .setColor(0xef4444);
    await interaction.reply({ embeds: [embed] });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
});

// ============================================
// CREATE TALK TICKET — private channel for the client + founder + staff
// ============================================
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
    const existing = guild.channels.cache.find((c) => c.name === safeName);
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
          'Use `!close` to close this ticket once we\'re done.',
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
    });

    return ticketChannel;
  } catch (error) {
    console.error('Error creating talk ticket:', error);
  }
}

// ============================================
// CREATE ORDER TICKET — TICKETS-category channel with client +
// specific designers + founder + staff (always).
// ============================================
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
    const existing = guild.channels.cache.find((c) => c.name === safeName);
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

    const welcomeEmbed = new EmbedBuilder()
      .setTitle('Ticket — ' + clientMember.displayName)
      .setDescription(
        'Hey <@' +
          clientMember.id +
          '>! This is your project ticket.\n\n' +
          'Working with: ' +
          designerMentions +
          '\n\nUse `!close` to close this ticket once the order is delivered.',
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
      content: '<@' + clientMember.id + '> ' + designerMentions,
      embeds: [welcomeEmbed],
      components: [row],
    });

    return ticketChannel;
  } catch (error) {
    console.error('Error creating order ticket:', error);
  }
}

client.login(process.env.BOT_TOKEN);
