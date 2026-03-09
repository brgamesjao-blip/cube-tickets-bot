const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, Events, AttachmentBuilder } = require('discord.js');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const ARTIST_ROLE_ID = '1095427320682119379';
const TICKET_CATEGORY_NAME = 'TICKETS';
const WORKER_URL = 'https://cube-api.brgamesjao.workers.dev';
const ADMIN_PW = 'CubeGraphics';

const DESIGNERS = ['Lyus', 'Juan', 'Soda', 'Nosher', 'Sueco', 'Sak', 'Thz'];

const pendingOrders = new Map();
const pendingDone = new Map(); // stores !done form data temporarily

client.once('ready', () => {
  console.log(`Bot online as ${client.user.tag}`);
  client.user.setActivity('Cube Graphics Orders', { type: 3 });
});

// ============================================
// DETECT WEBHOOK ORDERS
// ============================================
client.on('messageCreate', async (message) => {
  if (message.author.bot && message.author.username === 'Cube AI' && message.embeds.length > 0) {
    const embed = message.embeds[0];
    if (!embed.title || !embed.title.includes('New Order')) return;

    let discordUsername = null;
    for (const field of embed.fields) {
      if (field.name.includes('Discord')) {
        discordUsername = field.value.replace(/`/g, '').replace('@', '').trim();
        break;
      }
    }

    if (discordUsername) {
      pendingOrders.set(discordUsername.toLowerCase(), {
        embed, timestamp: Date.now(), channelId: message.channel.id
      });
      console.log(`New order for: ${discordUsername}`);

      const guild = message.guild;
      if (guild) {
        const members = await guild.members.fetch();
        const member = members.find(m =>
          m.user.username.toLowerCase() === discordUsername.toLowerCase() ||
          m.displayName.toLowerCase() === discordUsername.toLowerCase()
        );
        if (member) {
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

    // !done — start completion form
    if (cmd === 'done') {
      if (!message.channel.name.startsWith('ticket-')) {
        return message.reply('This command only works in ticket channels.');
      }

      const clientName = message.channel.name.replace('ticket-', '');

      // Designer select menu
      const designerSelect = new StringSelectMenuBuilder()
        .setCustomId('done_designer')
        .setPlaceholder('Select Designer')
        .addOptions(DESIGNERS.map(d => ({ label: d, value: d })));

      // Currency select
      const currencySelect = new StringSelectMenuBuilder()
        .setCustomId('done_currency')
        .setPlaceholder('Select Currency')
        .addOptions([
          { label: 'USD ($)', value: 'USD', emoji: '💵' },
          { label: 'BRL (R$)', value: 'BRL', emoji: '💰' },
          { label: 'Robux (R$)', value: 'RBX', emoji: '🎮' },
        ]);

      const row1 = new ActionRowBuilder().addComponents(designerSelect);
      const row2 = new ActionRowBuilder().addComponents(currencySelect);

      const doneEmbed = new EmbedBuilder()
        .setTitle('Order Completion Form')
        .setDescription('Fill in the details below to complete this order for **' + clientName + '**.')
        .setColor(0x3B82F6)
        .addFields(
          { name: '👤 Client', value: '`' + clientName + '`', inline: true },
          { name: '🎨 Designer', value: '_Select below_', inline: true },
          { name: '💰 Currency', value: '_Select below_', inline: true },
          { name: '📝 Status', value: 'Waiting for details...', inline: false },
        );

      const detailsBtn = new ButtonBuilder()
        .setCustomId('done_details')
        .setLabel('Fill Details & Price')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📝');

      const confirmBtn = new ButtonBuilder()
        .setCustomId('done_confirm')
        .setLabel('Confirm & Complete')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅')
        .setDisabled(true);

      const cancelBtn = new ButtonBuilder()
        .setCustomId('done_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

      const row3 = new ActionRowBuilder().addComponents(detailsBtn, confirmBtn, cancelBtn);

      const msg = await message.channel.send({
        embeds: [doneEmbed],
        components: [row1, row2, row3]
      });

      pendingDone.set(message.channel.id, {
        client: clientName,
        designer: null,
        currency: null,
        description: null,
        price: null,
        messageId: msg.id,
        channelId: message.channel.id,
      });
    }

    // !testcheckin @user — test check-in DM
    if (cmd === 'testcheckin' && message.mentions.members.size > 0) {
      const member = message.mentions.members.first();
      const embed = new EmbedBuilder()
        .setTitle('Hey! How\'s it going? 👋')
        .setDescription('It\'s been a week since your order with **Cube Graphics** was completed!\n\nHow\'s the thumbnail performing? If you need any adjustments or want to order something new, just head to our website or open a ticket!\n\n🔗 **cubegraphics.org**')
        .setColor(0x3B82F6)
        .setFooter({ text: 'Cube Graphics — Automated Check-in' });
      await member.send({ embeds: [embed] }).then(() => {
        message.reply('✅ Check-in DM sent to ' + member.displayName);
      }).catch(() => {
        message.reply('❌ Could not DM ' + member.displayName + ' (DMs closed)');
      });
    }

    // !testreminder — test reminder
    if (cmd === 'testreminder') {
      await sendReminder();
      message.reply('✅ Reminder sent!');
    }

    
    
    // !ordermsg — send permanent order message with banner and ticket button
    if (cmd === 'ordermsg') {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply('Only admins can use this command.');
      }

      // Delete the command message
      message.delete().catch(() => {});

      let bannerFile = null;
      try {
        const fs = require('fs');
        if (fs.existsSync('./ORDER_NOW_-_BANNER.png')) {
          bannerFile = new AttachmentBuilder('./ORDER_NOW_-_BANNER.png', { name: 'banner.png' });
        }
      } catch(e) {}

      const orderEmbed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setDescription(
          '<:Blue_Ticket:1415843891894026271> **READY TO BOOST YOUR GAME?** <:Blue_Ticket:1415843891894026271>\n\n' +
          '<:j_dot:1415844475120386230> Open a ticket right here and our team will help you create **stunning thumbnails and icons** for your Roblox game!\n\n' +
          '<:j_dot:1415844475120386230> Or if you prefer, visit our **website** and place your order with our **personalized AI assistant:**\n\n' +
          '<:j_dot:1415844475120386230> **[CUBEGRAPHICS.ORG](https://cubegraphics.org)**'
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('open_ticket')
          .setLabel('🎫 Open a Ticket')
          .setStyle(ButtonStyle.Primary)
      );

      if (bannerFile) orderEmbed.setImage('attachment://banner.png');
      
      const sendOptions = { embeds: [orderEmbed], components: [row] };
      if (bannerFile) sendOptions.files = [bannerFile];
      
      await message.channel.send(sendOptions);
    }

    // !portfolio <designer> — show designer portfolio (artists only)
    if (cmd === 'portfolio') {
      // Check if user has Artist role
      if (!message.member.roles.cache.has(ARTIST_ROLE_ID)) {
        return message.reply('Only artists can use this command.');
      }

      const designerName = args[0];
      const validDesigners = ['Lyus', 'Thz', 'Nosher', 'Soda'];
      const matched = validDesigners.find(d => d.toLowerCase() === (designerName || '').toLowerCase());

      if (!matched) {
        return message.reply('Usage: `!portfolio Lyus`, `!portfolio Thz`, `!portfolio Nosher`, or `!portfolio Soda`');
      }

      try {
        const fs = require('fs');
        const files = [];

        for (let i = 1; i <= 4; i++) {
          const filePath = './portfolio/' + matched + i + '.png';
          if (fs.existsSync(filePath)) {
            files.push(new AttachmentBuilder(filePath, { name: matched + i + '.png' }));
          }
        }

        if (files.length === 0) {
          return message.reply('No portfolio images found for ' + matched + '.');
        }

        const embed = new EmbedBuilder()
          .setColor(0x3B82F6)
          .setTitle('<:Blue_Ticket:1415843891894026271>  ' + matched + "'s Portfolio")
          .setDescription('<:j_dot:1415844475120386230> Here are some of **' + matched + "'s** best works!");

        await message.channel.send({ embeds: [embed] });
        await message.channel.send({ files: files });
      } catch (e) {
        console.error('Portfolio error:', e);
        message.reply('Error loading portfolio.');
      }
    }

    // !help — list all commands
    if (cmd === 'help') {
      const helpEmbed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setTitle('<:Blue_Ticket:1415843891894026271> Cube Tickets — Commands')
        .setDescription(
          '**Everyone:**\n' +
          '<:j_dot:1415844475120386230> `!help` — Show this list\n\n' +
          '**Artists Only:**\n' +
          '<:j_dot:1415844475120386230> `!done` — Complete an order (opens form)\n' +
          '<:j_dot:1415844475120386230> `!close` — Close current ticket\n' +
          '<:j_dot:1415844475120386230> `!rush` — Mark ticket as rush (⚠️)\n' +
          '<:j_dot:1415844475120386230> `!unrush` — Remove rush from ticket\n' +
          '<:j_dot:1415844475120386230> `!portfolio <name>` — Show designer portfolio\n' +
          '<:j_dot:1415844475120386230> `!revision` — Track revision count\n' + '<:j_dot:1415844475120386230> `!cleanrevision` — Reset revision count\n\n' +
          '**Admin Only:**\n' +
          '<:j_dot:1415844475120386230> `!ticket @user` — Create ticket for user\n' +
          '<:j_dot:1415844475120386230> `!ordermsg` — Send order message to channel'
        )
        .setTimestamp();
      return message.channel.send({ embeds: [helpEmbed] });
    }

    // !rush — mark ticket as rush
    if (cmd === 'rush') {
      if (!message.member.roles.cache.has(ARTIST_ROLE_ID)) return;
      if (!message.channel.name.startsWith('ticket-')) return message.reply('Use this in a ticket channel.');
      const name = message.channel.name;
      if (name.startsWith('⚠️')) return message.reply('This ticket is already marked as rush.');
      await message.channel.setName('⚠️' + name).catch(() => {});
      const rushEmbed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setDescription('⚠️ **This ticket has been marked as RUSH!**');
      await message.channel.send({ embeds: [rushEmbed] });
    }

    // !unrush — remove rush from ticket
    if (cmd === 'unrush') {
      if (!message.member.roles.cache.has(ARTIST_ROLE_ID)) return;
      if (!message.channel.name.startsWith('⚠️')) return message.reply('This ticket is not marked as rush.');
      const name = message.channel.name.replace('⚠️', '');
      await message.channel.setName(name).catch(() => {});
      const unrushEmbed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setDescription('✅ **Rush removed from this ticket.**');
      await message.channel.send({ embeds: [unrushEmbed] });
    }

    // !revision — track revision in ticket
    if (cmd === 'revision') {
      if (!message.channel.name.includes('ticket-')) return;
      // Count how many times !revision was used in this channel
      const msgs = await message.channel.messages.fetch({ limit: 100 });
      const revCount = msgs.filter(m => m.content.toLowerCase().startsWith('!revision') && !m.author.bot).size;
      const maxRevisions = 3;
      
      if (revCount > maxRevisions) {
        const limitEmbed = new EmbedBuilder()
          .setColor(0xEF4444)
          .setDescription('⚠️ **Revision ' + revCount + '/' + maxRevisions + '** — Maximum revisions reached! Please contact an admin for additional revisions.');
        return message.channel.send({ embeds: [limitEmbed] });
      }

      const revEmbed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setDescription('🔄 **Revision ' + revCount + '/' + maxRevisions + '** — Client requested changes.');
      await message.channel.send({ embeds: [revEmbed] });
    }

    // !cleanrevision — reset revision count in ticket
    if (cmd === 'cleanrevision') {
      if (!message.member.roles.cache.has(ARTIST_ROLE_ID)) return;
      if (!message.channel.name.includes('ticket-')) return message.reply('Use this in a ticket channel.');
      
      const msgs = await message.channel.messages.fetch({ limit: 100 });
      const revMsgs = msgs.filter(m => m.author.bot && m.embeds.length > 0 && m.embeds[0].description && m.embeds[0].description.includes('Revision'));
      
      for (const [, msg] of revMsgs) {
        await msg.delete().catch(() => {});
      }
      
      const resetEmbed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setDescription('✅ **Revision count has been reset.**');
      await message.channel.send({ embeds: [resetEmbed] });
    }

    // !close — close ticket
    if (cmd === 'close') {
      if (message.channel.name.startsWith('ticket-')) {
        const embed = new EmbedBuilder()
          .setTitle('Ticket Closing')
          .setDescription('This ticket will be deleted in 5 seconds.')
          .setColor(0xEF4444);
        await message.channel.send({ embeds: [embed] });
        setTimeout(() => message.channel.delete().catch(() => {}), 5000);
      }
    }

    // !ticket @user
    if (cmd === 'ticket' && message.mentions.members.size > 0) {
      const member = message.mentions.members.first();
      await createTicket(message.guild, member, null);
      message.reply('Ticket created for ' + member.displayName + '!');
    }
  }
});

// ============================================
// INTERACTIONS (selects, buttons, modals)
// ============================================
client.on(Events.InteractionCreate, async (interaction) => {

  // Open ticket button from order message
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const member = interaction.member;
      const guild = interaction.guild;
      
      // Check if user already has an open ticket
      const existingTicket = guild.channels.cache.find(
        ch => ch.name === 'ticket-' + member.user.username.toLowerCase() && ch.parentId
      );
      
      if (existingTicket) {
        return interaction.editReply({ content: '🎫 You already have an open ticket: <#' + existingTicket.id + '>' });
      }

      // Create ticket
      await createTicket(guild, member, null);
      
      const newTicket = guild.channels.cache.find(
        ch => ch.name === 'ticket-' + member.user.username.toLowerCase()
      );
      
      if (newTicket) {
        interaction.editReply({ content: '🎫 Your ticket has been created: <#' + newTicket.id + '>' });
      } else {
        interaction.editReply({ content: '🎫 Your ticket is being created! Check the tickets category.' });
      }
    } catch (e) {
      console.error('Ticket button error:', e);
      interaction.editReply({ content: '❌ Error creating ticket. Please try again.' });
    }
  }


  const channelId = interaction.channel?.id;
  const form = pendingDone.get(channelId);

  // Designer select
  if (interaction.isStringSelectMenu() && interaction.customId === 'done_designer') {
    if (!interaction.member.roles.cache.has(ARTIST_ROLE_ID)) return interaction.reply({ content: 'Only artists can use this.', ephemeral: true });
    if (!form) return interaction.reply({ content: 'Form expired. Run !done again.', ephemeral: true });
    form.designer = interaction.values[0];
    await updateDoneEmbed(interaction, form);
    await interaction.deferUpdate();
  }

  // Currency select
  if (interaction.isStringSelectMenu() && interaction.customId === 'done_currency') {
    if (!interaction.member.roles.cache.has(ARTIST_ROLE_ID)) return interaction.reply({ content: 'Only artists can use this.', ephemeral: true });
    if (!form) return interaction.reply({ content: 'Form expired. Run !done again.', ephemeral: true });
    form.currency = interaction.values[0];
    await updateDoneEmbed(interaction, form);
    await interaction.deferUpdate();
  }

  // Details button — opens modal
  if (interaction.isButton() && interaction.customId === 'done_details') {
    if (!interaction.member.roles.cache.has(ARTIST_ROLE_ID)) return interaction.reply({ content: 'Only artists can use this.', ephemeral: true });
    const modal = new ModalBuilder()
      .setCustomId('done_modal')
      .setTitle('Order Details');

    const descInput = new TextInputBuilder()
      .setCustomId('done_desc')
      .setLabel('What was delivered?')
      .setPlaceholder('e.g. 2 thumbnails + 1 icon, cartoon style...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const priceInput = new TextInputBuilder()
      .setCustomId('done_price')
      .setLabel('Price (number only)')
      .setPlaceholder('e.g. 25.00')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(descInput),
      new ActionRowBuilder().addComponents(priceInput),
    );

    await interaction.showModal(modal);
  }

  // Modal submit
  if (interaction.isModalSubmit() && interaction.customId === 'done_modal') {
    if (!interaction.member.roles.cache.has(ARTIST_ROLE_ID)) return interaction.reply({ content: 'Only artists can use this.', ephemeral: true });
    if (!form) return interaction.reply({ content: 'Form expired. Run !done again.', ephemeral: true });
    form.description = interaction.fields.getTextInputValue('done_desc');
    form.price = parseFloat(interaction.fields.getTextInputValue('done_price')) || 0;
    await updateDoneEmbed(interaction, form);
    await interaction.deferUpdate();
  }

  // Confirm button
  if (interaction.isButton() && interaction.customId === 'done_confirm') {
    if (!interaction.member.roles.cache.has(ARTIST_ROLE_ID)) return interaction.reply({ content: 'Only artists can use this.', ephemeral: true });
    if (!form) return interaction.reply({ content: 'Form expired.', ephemeral: true });
    if (!form.designer || !form.currency || !form.description || !form.price) {
      return interaction.reply({ content: 'Please fill all fields first!', ephemeral: true });
    }

    // Send to Worker dashboard
    try {
      await fetch(WORKER_URL + '/admin/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pw: ADMIN_PW,
          client: form.client,
          designer: form.designer,
          currency: form.currency,
          description: form.description,
          price: form.price,
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          timestamp: Date.now(),
        })
      });
    } catch (e) {
      console.error('Failed to send to dashboard:', e);
    }

    const completeEmbed = new EmbedBuilder()
      .setTitle('Order Completed!')
      .setColor(0x22C55E)
      .addFields(
        { name: '👤 Client', value: '`' + form.client + '`', inline: true },
        { name: '🎨 Designer', value: '`' + form.designer + '`', inline: true },
        { name: '💰 Price', value: '`' + formatPrice(form.price, form.currency) + '`', inline: true },
        { name: '📝 Delivered', value: form.description },
      )
      .setFooter({ text: 'Order completed and sent to admin dashboard' })
      .setTimestamp();

    await interaction.update({
      embeds: [completeEmbed],
      components: []
    });

    pendingDone.delete(channelId);
  }

  // Cancel button
  if (interaction.isButton() && interaction.customId === 'done_cancel') {
    if (!interaction.member.roles.cache.has(ARTIST_ROLE_ID)) return interaction.reply({ content: 'Only artists can use this.', ephemeral: true });
    pendingDone.delete(channelId);
    await interaction.update({
      embeds: [new EmbedBuilder().setTitle('Cancelled').setColor(0xEF4444).setDescription('Order completion cancelled.')],
      components: []
    });
  }

  
  // Close ticket button
  if (interaction.isButton() && interaction.customId === 'close_ticket') {
    const embed = new EmbedBuilder().setTitle('Ticket Closing').setDescription('Deleting in 5 seconds.').setColor(0xEF4444);
    await interaction.reply({ embeds: [embed] });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
});

// ============================================
// UPDATE DONE EMBED
// ============================================
async function updateDoneEmbed(interaction, form) {
  try {
    const channel = await client.channels.fetch(form.channelId);
    const msg = await channel.messages.fetch(form.messageId);

    const allFilled = form.designer && form.currency && form.description && form.price;

    const embed = new EmbedBuilder()
      .setTitle(form.isReorder ? '🔄 Reorder — New Commission' : '✅ Order Completion Form')
      .setDescription(form.isReorder ? 'Fill in the new order details for **' + form.client + '**.' : 'Fill in the details to complete this order for **' + form.client + '**.')
      .setColor(form.isReorder ? (allFilled ? 0x8B5CF6 : 0x3B82F6) : (allFilled ? 0x22C55E : 0x3B82F6))
      .addFields(
        { name: '👤 Client', value: '`' + form.client + '`', inline: true },
        { name: '🎨 Designer', value: form.designer ? '`' + form.designer + '`' : '_Select below_', inline: true },
        { name: '💰 Price', value: form.price ? '`' + formatPrice(form.price, form.currency) + '`' : '_Fill details_', inline: true },
        { name: '💱 Currency', value: form.currency ? '`' + form.currency + '`' : '_Select below_', inline: true },
        { name: '📝 Delivered', value: form.description || '_Click Fill Details_', inline: false },
        { name: '📊 Status', value: allFilled ? '✅ Ready to confirm!' : '⏳ Waiting for details...', inline: false },
      );

    // Update confirm button enabled state
    const designerSelect = new StringSelectMenuBuilder()
      .setCustomId('done_designer')
      .setPlaceholder(form.designer || 'Select Designer')
      .addOptions(DESIGNERS.map(d => ({ label: d, value: d, default: d === form.designer })));

    const currencySelect = new StringSelectMenuBuilder()
      .setCustomId('done_currency')
      .setPlaceholder(form.currency || 'Select Currency')
      .addOptions([
        { label: 'USD ($)', value: 'USD', emoji: '💵', default: form.currency === 'USD' },
        { label: 'BRL (R$)', value: 'BRL', emoji: '💰', default: form.currency === 'BRL' },
        { label: 'Robux (R$)', value: 'RBX', emoji: '🎮', default: form.currency === 'RBX' },
      ]);

    const row1 = new ActionRowBuilder().addComponents(designerSelect);
    const row2 = new ActionRowBuilder().addComponents(currencySelect);
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('done_details').setLabel('Fill Details & Price').setStyle(ButtonStyle.Primary).setEmoji('📝'),
      new ButtonBuilder().setCustomId('done_confirm').setLabel('Confirm & Complete').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(!allFilled),
      new ButtonBuilder().setCustomId('done_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    await msg.edit({ embeds: [embed], components: [row1, row2, row3] });
  } catch (e) {
    console.error('Error updating embed:', e);
  }
}

function formatPrice(price, currency) {
  if (currency === 'BRL') return 'R$' + price.toFixed(2);
  if (currency === 'RBX') return price.toFixed(0) + ' Robux';
  return '$' + price.toFixed(2);
}

// ============================================
// WHEN MEMBER JOINS
// ============================================
client.on('guildMemberAdd', async (member) => {
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
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === TICKET_CATEGORY_NAME);
    if (!category) category = await guild.channels.create({ name: TICKET_CATEGORY_NAME, type: ChannelType.GuildCategory });

    const existing = guild.channels.cache.find(c => c.name === 'ticket-' + member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-'));
    if (existing) return existing;

    const ticketChannel = await guild.channels.create({
      name: 'ticket-' + member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: ARTIST_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ],
    });

    const welcomeEmbed = new EmbedBuilder()
      .setTitle('Ticket — ' + member.displayName)
      .setDescription('Hey <@' + member.id + '>! Welcome to your order ticket.\n\nAn artist from <@&' + ARTIST_ROLE_ID + '> will be with you shortly.\n\nUse `!done` when the order is complete.\nUse `!close` to close this ticket.')
      .setColor(0x3B82F6)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );

    // Add order details to welcome embed if available
    if (orderData && orderData.embed && orderData.embed.fields) {
      welcomeEmbed.addFields({ name: '\u200b', value: '**───── Order Details ─────**', inline: false });
      for (const field of orderData.embed.fields) {
        if (field.value && field.value !== '\u200b' && !field.value.includes('─────'))
          welcomeEmbed.addFields({ name: field.name, value: field.value, inline: field.inline || false });
      }
    }

    await ticketChannel.send({ content: '<@' + member.id + '> <@&' + ARTIST_ROLE_ID + '>', embeds: [welcomeEmbed], components: [row] });

    return ticketChannel;
  } catch (error) { console.error('Error creating ticket:', error); }
}

// Cleanup old pending orders
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOrders) if (now - val.timestamp > 86400000) pendingOrders.delete(key);
  for (const [key, val] of pendingDone) if (now - val.timestamp > 3600000) pendingDone.delete(key);
}, 3600000);


// ============================================
// REMINDER — every 12 hours in ⚠️・reminder channel
// ============================================
const REMINDER_CHANNEL_NAME = '⚠️・reminder';

async function sendReminder() {
  console.log('⏰ Sending reminder...');
  try {
    const guilds = client.guilds.cache;
    for (const [, guild] of guilds) {
      const channel = guild.channels.cache.find(c => c.name === REMINDER_CHANNEL_NAME || c.name.includes('reminder'));
      if (!channel) { console.log('No reminder channel found'); continue; }

      // Count open tickets
      const tickets = guild.channels.cache.filter(c => c.name.startsWith('ticket-') && c.type === ChannelType.GuildText);
      const ticketCount = tickets.size;

      const greetings = [
        'Hey team! Quick check-in time 🎨',
        'Yo artists! Let\'s check the status 🔥',
        'Reminder time! How are we doing? 💪',
        'Hey everyone! Let\'s stay on track 🚀',
        'Time for a progress update! ✨',
      ];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];

      const embed = new EmbedBuilder()
        .setTitle(greeting)
        .setDescription('How is the progress on current orders? Any updates?\n\n' +
          '📋 **Open tickets:** ' + ticketCount + '\n\n' +
          'Please reply with updates on your assignments:\n' +
          '→ What are you working on?\n' +
          '→ Any blockers?\n' +
          '→ Expected completion time?\n\n' +
          '_Use `!done` in a ticket when finished!_')
        .setColor(0xF59E0B)
        .setFooter({ text: 'Cube Graphics — Auto Reminder' })
        .setTimestamp();

      await channel.send({ 
        content: '<@&' + ARTIST_ROLE_ID + '>', 
        embeds: [embed] 
      });
      console.log('✅ Reminder sent! Open tickets: ' + ticketCount);
    }
  } catch (e) { console.error('Reminder error:', e); }
}

// Every 12 hours
setInterval(sendReminder, 12 * 60 * 60 * 1000);
// First run 1 minute after startup
setTimeout(function(){ sendReminder().catch(function(e){console.error('Reminder error:',e)}) }, 60000);

// ============================================
// CHECK-IN — 7 days after ticket closes, DM client
// Uses Worker KV for persistence
// ============================================

async function addToCheckinQueue(username) {
  try {
    await fetch(WORKER_URL + '/bot/checkin-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pw: ADMIN_PW, username, timestamp: Date.now() })
    });
    console.log('📝 Added ' + username + ' to check-in queue (KV)');
  } catch (e) { console.error('Check-in add error:', e); }
}

client.on('channelDelete', async (channel) => {
  if (channel.name && channel.name.startsWith('ticket-')) {
    const username = channel.name.replace('ticket-', '');
    await addToCheckinQueue(username);
  }
});

async function processCheckins() {
  console.log('📩 Processing check-ins...');
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
  
  try {
    // Fetch queue from Worker KV
    const res = await fetch(WORKER_URL + '/bot/checkin-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pw: ADMIN_PW })
    });
    const data = await res.json();
    if (!data.queue) return;

    for (const item of data.queue) {
      if (Date.now() - item.timestamp >= ONE_WEEK) {
        const guilds = client.guilds.cache;
        for (const [, guild] of guilds) {
          const members = await guild.members.fetch();
          const member = members.find(m => 
            m.user.username.toLowerCase() === item.username.toLowerCase() ||
            m.displayName.toLowerCase() === item.username.toLowerCase()
          );
          
          if (member) {
            const embed = new EmbedBuilder()
              .setTitle('Hey! How\'s it going? 👋')
              .setDescription('It\'s been a week since your order with **Cube Graphics** was completed!\n\nHow\'s the thumbnail performing? If you need any adjustments or want to order something new, just head to our website or open a ticket!\n\n🔗 **cubegraphics.org**')
              .setColor(0x3B82F6)
              .setFooter({ text: 'Cube Graphics — Automated Check-in' });
            
            await member.send({ embeds: [embed] }).catch(() => {
              console.log('Could not DM ' + item.username);
            });
            console.log('✅ Check-in sent to ' + item.username);
          }
        }
        
        // Remove from queue
        await fetch(WORKER_URL + '/bot/checkin-remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pw: ADMIN_PW, username: item.username })
        });
      }
    }
  } catch (e) { console.error('Check-in error:', e); }
}

// Check every 6 hours
setInterval(processCheckins, 6 * 60 * 60 * 1000);


client.login(process.env.BOT_TOKEN);
