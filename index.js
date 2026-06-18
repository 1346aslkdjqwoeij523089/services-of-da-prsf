const { Client, GatewayIntentBits, Partials, Routes, REST, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, ComponentType, PermissionFlagsBits } = require('discord.js');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// ====== Config (from prompt) ======
const BOT_USER_ID = '1500345067754360922';
const SERVER_ID = '1499139848559132672';
const GREETING_CHANNEL_ID = '1499139850895360143';

const ROLE_IDS = {
  Leadership: '1499160401781330053',
  Directive: '1499160472753147986',
  Management: '1499160704215814234',
  'Internal Affairs': '1499161036341776414',
  Administration: '1499161287874314473',
  Moderation: '1499161482926231643'
};

const MODULES = {
  // Module 3 - statistics channel name updater
  statsNameChannelId: '1499244464596848723'
};

// ====== Environment ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const BOT_PREFIX_DEFAULT = process.env.BOT_PREFIX_DEFAULT || 'PREFIX'; // used until DB config is set

const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'fsrp_services';
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || 'guildConfigs';

// Optional AI generation (free tier). If not provided, uses varied templates.
const HF_API_TOKEN = process.env.HUGGINGFACE_API_TOKEN || '';

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN env var');
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var');
  process.exit(1);
}

// ====== Helpers ======
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function isLeadership(member) {
  return member.roles.cache.some(r => r.id === ROLE_IDS.Leadership);
}

async function getGuildConfig(db, guildId) {
  const doc = await db.collection(MONGO_COLLECTION).findOne({ guildId });
  if (doc) return doc;
  const insertDoc = {
    guildId,
    prefix: BOT_PREFIX_DEFAULT,
    statsDisplayChannelId: null,
    createdAt: new Date()
  };
  await db.collection(MONGO_COLLECTION).insertOne(insertDoc);
  return insertDoc;
}

async function setGuildConfig(db, guildId, patch) {
  await db.collection(MONGO_COLLECTION).updateOne(
    { guildId },
    { $set: patch },
    { upsert: true }
  );
}

function countNonBotMembers(guild) {
  // Use member fetch for accurate non-bot count
  return guild.members.cache.filter(m => !m.user.bot).size;
}

async function generateBoostThankYouMessage({ user, guild }) {
  const mention = user.toString();

  // Local varied templates (always available)
  const templates = [
    `Big thanks to ${mention} for boosting **${guild.name}**! Your support keeps the community moving forward.`,
    `BOOST ALERT 🚀 Huge shoutout to ${mention}! Appreciate you making **${guild.name}** better.`,
    `Thank you so much ${mention}! Boosting **${guild.name}** helps us grow—you're the real MVP.`,
    `${mention}, thanks for boosting **${guild.name}**! Hope you enjoy every moment in the server.`
  ];
  // Create additional variation by shuffling punctuation/style
  const variant = templates[Math.floor(Math.random() * templates.length)];

  // If HF token is present, attempt to get a unique 1-2 sentence message.
  // This is best-effort; if it fails, fallback to templates.
  if (HF_API_TOKEN) {
    try {
      const resp = await fetch('https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: `Write a friendly, unique 1-2 sentence Discord boost thank-you message for ${user.username} who boosted the server ${guild.name}. Always include the user mention in the exact format <@id>. Keep it casual and enthusiastic.`,
          parameters: {
            max_new_tokens: 80,
            temperature: 0.9,
            do_sample: true
          }
        })
      });

      const data = await resp.json();
      let text = '';
      if (Array.isArray(data) && data[0]?.generated_text) text = data[0].generated_text;
      else if (data?.generated_text) text = data.generated_text;
      else if (typeof data === 'string') text = data;

      if (text) {
        // Ensure it includes mention
        const mentionToken = `<@${user.id}>`;
        if (!text.includes(mentionToken)) {
          text = `${mentionToken} ${text}`;
        }
        // Keep short: trim to ~2 sentences
        const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
        const trimmed = sentences.slice(0, 2).join(' ');
        return trimmed.length ? trimmed : variant;
      }
    } catch (e) {
      console.warn('HF generation failed, using template fallback:', e?.message || e);
    }
  }

  return variant;
}

// ====== Discord App Setup ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

// slash commands registration
const slashCommands = [
  {
    name: 'update-prefix',
    description: 'Update the bot prefix (Leadership only)',
    defaultMemberPermissions: null,
    options: [{ name: 'prefix', type: 3, description: 'New prefix', required: true }]
  },
  {
    name: 'update-statistics',
    description: 'Open Statistics Management panel'
  }
];

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(BOT_USER_ID, SERVER_ID),
    { body: slashCommands }
  );
  console.log('Slash commands registered');
}

// ====== Module 3: panel state ======
// We store the panel channel in DB (statsDisplayChannelId). The updater always updates the name channel.
// Panel interaction updates the DB and posts/edits embed.

const panelButtonCustomId = 'fsrp_stats_config';

async function buildStatisticsPanelEmbed({ guild, nonBotCount, botCount, boosters, displayChannelId }) {
  const embed = new EmbedBuilder()
    .setTitle('FSRP Services - Module 3')
    .setColor(0x5865F2);

  embed.setDescription(
    `# <:FSRP:1499231297636401273> __Module 3: Statistics Management__\n\n` +
    `## Current Community Statistics\n` +
    `> **Overall Membercount:** **${nonBotCount}**\n` +
    `> **Automation Count:** **${botCount}**\n` +
    `> **Server Boosters:** **${boosters}** boosters\n\n` +
    `## Configure Statistics\n` +
    `**Select the channel where the membercount is displayed:**`
  );

  if (displayChannelId) {
    embed.addFields({ name: 'Currently configured', value: `<#${displayChannelId}>`, inline: false });
  }

  return embed;
}

async function updateStatsChannelName(guild, db) {
  const cfg = await getGuildConfig(db, guild.id);
  const nonBot = guild.members.cache.filter(m => !m.user.bot).size;
  const displayChannel = MODULES.statsNameChannelId;

  const ch = await guild.channels.fetch(displayChannel).catch(() => null);
  if (!ch || !('edit' in ch)) return;

  await ch.edit({ name: `Members: ${nonBot}` }).catch(() => {});
  return cfg;
}

// ====== Main ======
let mongo;
let db;

client.once('ready', async () => {
  mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  db = mongo.db(MONGO_DB_NAME);

  // Ensure slash commands registered
  await registerSlashCommands().catch(() => {});

  console.log(`Logged in as ${client.user.tag}`);

  // Start 15-min updater (Module 3 default objective)
  const guild = await client.guilds.fetch(SERVER_ID).catch(() => null);
  if (guild) {
    await guild.members.fetch().catch(() => {});
    const update = async () => {
      try {
        await updateStatsChannelName(guild, db);
      } catch (e) {
        console.warn('stats updater error', e?.message || e);
      }
    };
    await update();
    setInterval(update, 15 * 60 * 1000);
  }
});

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== SERVER_ID) return;

  const greetingChannel = await member.guild.channels.fetch(GREETING_CHANNEL_ID).catch(() => null);
  if (!greetingChannel || !greetingChannel.isTextBased()) return;

  // count non-bot members after fetch for accuracy
  await member.guild.members.fetch().catch(() => {});
  const nonBotCount = member.guild.members.cache.filter(m => !m.user.bot).size;

  const n = nonBotCount; // based on prompt wording
  const suf = ordinal(n);

  const embed = new EmbedBuilder()
    .setColor(0x00b0f4)
    .setDescription(`Welcome to <:FSRP:1499231297636401273> **Florida State Roleplay** , ${member.toString()}. You are the **${n}${suf}** **non bot members**`);

  greetingChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.guildId !== SERVER_ID) return;

      const guild = interaction.guild;
      const cfg = await getGuildConfig(db, guild.id);

      if (interaction.commandName === 'update-prefix') {
        const member = await guild.members.fetch(interaction.user.id);
        if (!member) return;
        if (!isLeadership(member)) {
          await interaction.reply({ content: 'Leadership only.', ephemeral: true });
          return;
        }
        const prefix = interaction.options.getString('prefix', true);
        if (!prefix || prefix.length > 10) {
          await interaction.reply({ content: 'Prefix must be 1-10 characters.', ephemeral: true });
          return;
        }
        await setGuildConfig(db, guild.id, { prefix });
        await interaction.reply({ content: `Prefix updated to:  ${prefix}`.replace('\u0000', prefix), ephemeral: true });
        return;
      }

      if (interaction.commandName === 'update-statistics') {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply({ content: 'Opening the Statistics Management panel...' });

        await memberStatsPanel(interaction);
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === panelButtonCustomId) {
        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const nonBotCount = guild.members.cache.filter(m => !m.user.bot).size;
        const botCount = guild.members.cache.filter(m => m.user.bot).size;
        const boosters = guild.premiumSubscriptionCount || 0;
        const cfg = await getGuildConfig(db, guild.id);

        const modal = new ModalBuilder()
          .setCustomId('fsrp_stats_channel_modal')
          .setTitle('Configure Statistics Channel');

        const select = new ChannelSelectMenuBuilder()
          .setCustomId('stats_channel_select')
          .setMinValues(1)
          .setMaxValues(1)
          .setPlaceholder('Select a channel');

        const row = new ActionRowBuilder().addComponents(select);
        // Discord.js requires components on the modal as ActionRowBuilder components.
        // However ChannelSelectMenuBuilder is not a TextInput; modal accepts components of type ActionRow.
        // Use a TextInput for channel id to keep it compatible across bots.
        // We'll do that instead.

        const channelIdInput = new TextInputBuilder()
          .setCustomId('stats_channel_id')
          .setLabel('Channel ID to display membercount')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(cfg.statsDisplayChannelId || '');

        const row2 = new ActionRowBuilder().addComponents(channelIdInput);
        modal.addComponents(row2);

        await interaction.showModal(modal);
        return;
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'fsrp_stats_channel_modal') {
        const guild = interaction.guild;
        const channelId = interaction.fields.getTextInputValue('stats_channel_id').trim();

        const ch = await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased()) {
          await interaction.reply({ content: 'That channel ID is invalid.', ephemeral: true });
          return;
        }

        await setGuildConfig(db, guild.id, { statsDisplayChannelId: channelId });

        // Update stats name channel as requested objective (still uses MODULES.statsNameChannelId)
        await guild.members.fetch().catch(() => {});
        const nonBotCount = guild.members.cache.filter(m => !m.user.bot).size;
        const botCount = guild.members.cache.filter(m => m.user.bot).size;
        const boosters = guild.premiumSubscriptionCount || 0;

        const panelEmbed = await buildStatisticsPanelEmbed({
          guild,
          nonBotCount,
          botCount,
          boosters,
          displayChannelId: channelId
        });

        // Edit panel message: since we used deferReply ephemeral, just send an ephemeral confirmation.
        await interaction.reply({
          ephemeral: true,
          content: `Statistics display channel updated to: <#${channelId}>`
        });

        // Also update the membercount channel name as a visual update (per objective it should be the statsNameChannelId)
        const nameChannel = await guild.channels.fetch(MODULES.statsNameChannelId).catch(() => null);
        if (nameChannel && 'edit' in nameChannel) {
          await nameChannel.edit({ name: `Members: ${nonBotCount}` }).catch(() => {});
        }

        // Additionally post embed to the configured channel (optional interpretation of "edit the private panel"—we can keep it ephemeral).
        // We'll post a message with the updated embed.
        await ch.send({ embeds: [panelEmbed] }).catch(() => {});
        return;
      }
    }
  } catch (e) {
    console.warn('interaction error', e?.message || e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

async function memberStatsPanel(interaction) {
  const guild = interaction.guild;
  await guild.members.fetch().catch(() => {});
  const nonBotCount = guild.members.cache.filter(m => !m.user.bot).size;
  const botCount = guild.members.cache.filter(m => m.user.bot).size;
  const boosters = guild.premiumSubscriptionCount || 0;

  const cfg = await getGuildConfig(db, guild.id);
  const embed = await buildStatisticsPanelEmbed({
    guild,
    nonBotCount,
    botCount,
    boosters,
    displayChannelId: cfg.statsDisplayChannelId
  });

  const button = new ButtonBuilder()
    .setCustomId(panelButtonCustomId)
    .setEmoji('🔄')
    .setLabel('Configure Statistics')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);

  await interaction.editReply({ embeds: [embed], components: [row], ephemeral: true }).catch(async () => {
    await interaction.followUp({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
  });
}

// Prefix commands for Module 1
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.guildId !== SERVER_ID) return;

  const guild = message.guild;
  const cfg = await getGuildConfig(db, guild.id);
  const prefix = cfg.prefix || BOT_PREFIX_DEFAULT;

  const content = message.content;
  if (!content.startsWith(prefix)) return;

  const args = content.slice(prefix.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  if (cmd === 'update-prefix' || cmd === 'update-prefix') {
    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (!member || !isLeadership(member)) return;

    const newPrefix = args[0];
    if (!newPrefix) {
      message.reply('Usage: update-prefix <newPrefix>').then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
      return;
    }

    await setGuildConfig(db, guild.id, { prefix: newPrefix });
    message.reply(`Prefix updated to: ${newPrefix}`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
    return;
  }

  if (cmd === 'update-statistics') {
    // Only for prefix-style; slash handles ephemeral.
    // We'll open the panel as a reply.
    const tempInteraction = {
      guild,
      user: message.author,
      editReply: () => {},
      deferReply: () => {},
      reply: () => {}
    };
    // Simpler: instruct to use slash command.
    message.reply('Use /update-statistics for the panel.').then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
    return;
  }
});

// Prefix viewing: when bot is mentioned exactly
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.guildId !== SERVER_ID) return;

    const isMention = message.mentions.users.has(BOT_USER_ID);
    if (!isMention) return;

    const cfg = await getGuildConfig(db, message.guildId);
    const prefix = cfg.prefix || BOT_PREFIX_DEFAULT;

    const reply = await message.reply({ content: `Welcome to **FSRP Services!** My prefix is  ${prefix}`.replace('\u0000', prefix) });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
  } catch (e) {
    console.warn('prefix mention error', e?.message || e);
  }
});

// Boost thank you
client.on('guildMemberUpdate', () => {});

client.on('guildUpdate', () => {});

client.on('messageDelete', () => {});

// discord.js supports premiumSince on guild member? For Nitro boosts, use guildMemberUpdate and check premiumSince.
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.guild.id !== SERVER_ID) return;

  // premiumSince starts when they boost.
  const oldBoost = oldMember.premiumSince;
  const newBoost = newMember.premiumSince;

  if (!oldBoost && newBoost) {
    // Member started boosting
    const channel = await newMember.guild.channels.fetch('1499162945559597196').catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const msg = await generateBoostThankYouMessage({ user: newMember.user, guild: newMember.guild });
    await channel.send({ content: msg }).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);

