const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
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

const ARTIST_ROLE_ID = '1095427320682119379';
const TICKET_CATEGORY_NAME = 'TICKETS';

// Pending orders posted by the "Cube AI" webhook for users who aren't
// in the guild yet — keyed by lowercase Discord username, 24h TTL.
const pendingOrders = new Map();

function isTicketChannel(channel) {
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

client.once('ready', () => {
  console.log(`Bot online as ${client.user.tag}`);
  client.user.setActivity('Cube Graphics Orders', { type: 3 });
});

// ============================================
// DETECT WEBHOOK ORDERS
// ============================================
client.on('messageCreate', async (message) => {
  // Auto-pickup of orders posted by the "Cube AI" webhook. The embed
  // carries the customer's Discord username; if they're already in
  // the guild a ticket is created for them right now, otherwise the
  // order is parked in pendingOrders until they join.
  if (
    message.author.bot &&
    message.author.username === 'Cube AI' &&
    message.embeds.length > 0
  ) {
    const embed = message.embeds[0];
    if (!embed.title || !embed.title.includes('New Order')) return;

    let discordUsername = null;
    for (const field of embed.fields) {
      if (field.name.includes('Discord')) {
        discordUsername = field.value
          .replace(/`/g, '')
          .replace('@', '')
          .trim();
        break;
      }
    }

    if (discordUsername) {
      pendingOrders.set(discordUsername.toLowerCase(), {
        embed,
        timestamp: Date.now(),
        channelId: message.channel.id,
      });
      console.log(`New order for: ${discordUsername}`);

      const guild = message.guild;
      if (guild) {
        const members = await guild.members.fetch();
        const member = members.find(
          (m) =>
            m.user.username.toLowerCase() === discordUsername.toLowerCase() ||
            m.displayName.toLowerCase() === discordUsername.toLowerCase(),
        );
        if (member) {
          await createTicket(
            guild,
            member,
            pendingOrders.get(discordUsername.toLowerCase()),
          );
          pendingOrders.delete(discordUsername.toLowerCase());
        }
      }
    }
  }

  // ============================================
  // COMMANDS
  // ============================================
  if (!message.author.bot && message.content.startsWith('!')) {
    const args = message.content.slice(1).split(' ');
    const cmd = args.shift().toLowerCase();

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
            '<:j_dot:1415844475120386230> Open a ticket right here and our team will help you create **stunning thumbnails and icons** for your Roblox game!\n\n' +
            '<:j_dot:1415844475120386230> Or if you prefer, visit our **website** and place your order with our **personalized AI assistant:**\n\n' +
            '<:j_dot:1415844475120386230> **[CUBEGRAPHICS.ORG](https://cubegraphics.org)**',
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
      if (isTicketChannel(message.channel)) {
        const embed = new EmbedBuilder()
          .setTitle('Ticket Closing')
          .setDescription('This ticket will be deleted in 5 seconds.')
          .setColor(0xef4444);
        await message.channel.send({ embeds: [embed] });
        setTimeout(
          () => message.channel.delete().catch(() => {}),
          5000,
        );
      }
    }

    // !ticket @user — admin: manual ticket creation by mention.
    if (cmd === 'ticket' && message.mentions.members.size > 0) {
      const member = message.mentions.members.first();
      await createTicket(message.guild, member, null);
      message.reply('Ticket created for ' + member.displayName + '!');
    }
  }
});

// ============================================
// INTERACTIONS (buttons)
// ============================================
client.on(Events.InteractionCreate, async (interaction) => {
  // "Open a Ticket" button on the !ordermsg banner.
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const member = interaction.member;
      const guild = interaction.guild;

      const existingTicket = guild.channels.cache.find(
        (ch) =>
          ch.name === 'ticket-' + member.user.username.toLowerCase() &&
          ch.parentId,
      );

      if (existingTicket) {
        return interaction.editReply({
          content:
            '🎫 You already have an open ticket: <#' + existingTicket.id + '>',
        });
      }

      await createTicket(guild, member, null);

      const newTicket = guild.channels.cache.find(
        (ch) => ch.name === 'ticket-' + member.user.username.toLowerCase(),
      );

      if (newTicket) {
        interaction.editReply({
          content: '🎫 Your ticket has been created: <#' + newTicket.id + '>',
        });
      } else {
        interaction.editReply({
          content:
            '🎫 Your ticket is being created! Check the tickets category.',
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
// WHEN MEMBER JOINS
// ============================================
client.on('guildMemberAdd', async (member) => {
  // If the joiner had a queued order from the Cube AI webhook,
  // create their ticket now.
  const username = member.user.username.toLowerCase();
  const order = pendingOrders.get(username);
  if (order) {
    await createTicket(member.guild, member, order);
    pendingOrders.delete(username);
  }
});

// ============================================
// CREATE TICKET
// ============================================
async function createTicket(guild, member, orderData) {
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

    const safeName =
      'ticket-' +
      member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const existing = guild.channels.cache.find((c) => c.name === safeName);
    if (existing) return existing;

    const ticketChannel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: ARTIST_ROLE_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
          ],
        },
      ],
    });

    const welcomeEmbed = new EmbedBuilder()
      .setTitle('Ticket — ' + member.displayName)
      .setDescription(
        'Hey <@' +
          member.id +
          '>! Welcome to your order ticket.\n\n' +
          'An artist from <@&' +
          ARTIST_ROLE_ID +
          '> will be with you shortly.\n\n' +
          'Use `!close` to close this ticket.',
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

    if (orderData && orderData.embed && orderData.embed.fields) {
      welcomeEmbed.addFields({
        name: '​',
        value: '**───── Order Details ─────**',
        inline: false,
      });
      for (const field of orderData.embed.fields) {
        if (
          field.value &&
          field.value !== '​' &&
          !field.value.includes('─────')
        ) {
          welcomeEmbed.addFields({
            name: field.name,
            value: field.value,
            inline: field.inline || false,
          });
        }
      }
    }

    await ticketChannel.send({
      content: '<@' + member.id + '> <@&' + ARTIST_ROLE_ID + '>',
      embeds: [welcomeEmbed],
      components: [row],
    });

    return ticketChannel;
  } catch (error) {
    console.error('Error creating ticket:', error);
  }
}

// Cleanup expired pending orders every hour (24h TTL).
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOrders) {
    if (now - val.timestamp > 86400000) pendingOrders.delete(key);
  }
}, 3600000);

client.login(process.env.BOT_TOKEN);
