const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ============================================
// CONFIG — change these
// ============================================
const ARTIST_ROLE_ID = '1095427320682119379';
const TICKET_CATEGORY_NAME = 'TICKETS';

// In-memory pending orders (from webhook channel)
const pendingOrders = new Map();

client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  client.user.setActivity('Cube Graphics Orders', { type: 3 }); // "Watching"
});

// ============================================
// DETECT NEW ORDERS FROM WEBHOOK
// ============================================
client.on('messageCreate', async (message) => {
  // Detect webhook messages from Cube AI
  if (message.author.bot && message.author.username === 'Cube AI' && message.embeds.length > 0) {
    const embed = message.embeds[0];
    if (!embed.title || !embed.title.includes('New Order')) return;

    // Extract discord username from the embed
    let discordUsername = null;
    for (const field of embed.fields) {
      if (field.name.includes('Discord')) {
        discordUsername = field.value.replace(/`/g, '').replace('@', '').trim();
        break;
      }
    }

    if (discordUsername) {
      pendingOrders.set(discordUsername.toLowerCase(), {
        embed: embed,
        timestamp: Date.now(),
        channelId: message.channel.id
      });
      console.log(`📦 New order detected for: ${discordUsername}`);

      // Also check if user is already in the server
      const guild = message.guild;
      if (guild) {
        const members = await guild.members.fetch();
        const member = members.find(m => 
          m.user.username.toLowerCase() === discordUsername.toLowerCase() ||
          m.displayName.toLowerCase() === discordUsername.toLowerCase()
        );
        if (member) {
          console.log(`👤 User already in server, creating ticket...`);
          await createTicket(guild, member, pendingOrders.get(discordUsername.toLowerCase()));
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

    // !close — close ticket
    if (cmd === 'close') {
      if (message.channel.name.startsWith('ticket-')) {
        const closeEmbed = new EmbedBuilder()
          .setTitle('🔒 Ticket Closed')
          .setDescription('This ticket will be deleted in 5 seconds.')
          .setColor(0xEF4444);
        await message.channel.send({ embeds: [closeEmbed] });
        setTimeout(() => message.channel.delete().catch(() => {}), 5000);
      }
    }

    // !ticket @user — manually create ticket
    if (cmd === 'ticket' && message.mentions.members.size > 0) {
      const member = message.mentions.members.first();
      await createTicket(message.guild, member, null);
      message.reply(`✅ Ticket created for ${member.displayName}!`);
    }
  }
});

// ============================================
// WHEN NEW MEMBER JOINS — CHECK PENDING ORDERS
// ============================================
client.on('guildMemberAdd', async (member) => {
  const username = member.user.username.toLowerCase();
  const displayName = member.displayName.toLowerCase();

  console.log(`👋 New member: ${member.user.username}`);

  // Check if they have a pending order
  const order = pendingOrders.get(username) || pendingOrders.get(displayName);
  if (order) {
    console.log(`🎫 Creating ticket for ${member.user.username}...`);
    await createTicket(member.guild, member, order);
    pendingOrders.delete(username);
    pendingOrders.delete(displayName);
  }
});

// ============================================
// CREATE TICKET
// ============================================
async function createTicket(guild, member, orderData) {
  try {
    // Find or create TICKETS category
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === TICKET_CATEGORY_NAME
    );

    if (!category) {
      category = await guild.channels.create({
        name: TICKET_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }

    // Check if ticket already exists
    const existingTicket = guild.channels.cache.find(
      c => c.name === `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
    );
    if (existingTicket) {
      console.log(`⚠️ Ticket already exists for ${member.user.username}`);
      return existingTicket;
    }

    // Create private channel
    const ticketChannel = await guild.channels.create({
      name: `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.id, // @everyone
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.id, // client
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
        {
          id: ARTIST_ROLE_ID, // artists
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
        {
          id: client.user.id, // bot
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
        },
      ],
    });

    // Welcome embed
    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`🎫  Ticket — ${member.displayName}`)
      .setDescription(`Hey ${member}! Welcome to your order ticket.\n\nAn artist from <@&${ARTIST_ROLE_ID}> will be with you shortly to discuss your order details.\n\nUse \`!close\` when everything is done.`)
      .setColor(0x3B82F6)
      .setTimestamp();

    // Close button
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒')
    );

    await ticketChannel.send({ 
      content: `${member} <@&${ARTIST_ROLE_ID}>`,
      embeds: [welcomeEmbed],
      components: [row]
    });

    // If we have order data, send the order details
    if (orderData && orderData.embed) {
      const orderEmbed = new EmbedBuilder()
        .setTitle('📦  Order Details')
        .setDescription('Here are the details from the AI chat:')
        .setColor(0x22C55E);

      // Copy fields from the webhook embed
      if (orderData.embed.fields) {
        for (const field of orderData.embed.fields) {
          if (field.value && field.value !== '\u200b' && !field.value.includes('─────')) {
            orderEmbed.addFields({ name: field.name, value: field.value, inline: field.inline || false });
          }
        }
      }

      orderEmbed.setFooter({ text: '🤖 Auto-generated from Cube AI order' });
      orderEmbed.setTimestamp();

      await ticketChannel.send({ embeds: [orderEmbed] });
    }

    console.log(`✅ Ticket created: #${ticketChannel.name}`);
    return ticketChannel;

  } catch (error) {
    console.error('❌ Error creating ticket:', error);
  }
}

// ============================================
// BUTTON INTERACTION — close ticket
// ============================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'close_ticket') {
    const closeEmbed = new EmbedBuilder()
      .setTitle('🔒 Ticket Closing')
      .setDescription('This ticket will be deleted in 5 seconds.')
      .setColor(0xEF4444);
    await interaction.reply({ embeds: [closeEmbed] });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
});

// ============================================
// CLEAN OLD PENDING ORDERS (older than 24h)
// ============================================
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOrders) {
    if (now - val.timestamp > 86400000) pendingOrders.delete(key);
  }
}, 3600000);

// Login
client.login(process.env.BOT_TOKEN);
