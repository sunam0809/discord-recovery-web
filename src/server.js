require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── GitHub-backed Persistent Database ───────────────────────────────────────
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_USER  = process.env.GH_USER  || 'sunam0809';
const GH_REPO  = process.env.GH_REPO  || 'discord-recovery-web';
const GH_FILE  = 'data/db.json';
const GH_HEADERS = {
  Authorization: `token ${GH_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
};

// 읽기: GitHub에서 최신 데이터 + SHA 동시에 가져옴
async function ghRead() {
  const res = await axios.get(
    `https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${GH_FILE}`,
    { headers: GH_HEADERS }
  );
  const data = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
  return { data, sha: res.data.sha };
}

// 쓰기: 반드시 최신 SHA로 PUT (충돌 방지)
async function ghWrite(data) {
  // 저장 직전에 최신 SHA를 가져옴 (SHA 없으면 GitHub 거절)
  let sha;
  try {
    const cur = await axios.get(
      `https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${GH_FILE}`,
      { headers: GH_HEADERS }
    );
    sha = cur.data.sha;
  } catch (e) {
    sha = null; // 파일이 없을 경우 (첫 생성)
  }

  const body = {
    message: `db: ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;

  await axios.put(
    `https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${GH_FILE}`,
    body,
    { headers: GH_HEADERS }
  );
  console.log('DB 저장 완료 ✅');
}

// 읽고 → 수정하고 → 저장 (원자적 처리)
async function withDB(fn) {
  try {
    const { data } = await ghRead();
    const result = await fn(data);
    await ghWrite(data);
    return result;
  } catch (e) {
    console.error('DB 작업 실패:', e.response?.data || e.message);
    throw e;
  }
}

const db = {
  async getVerifiedUsers(guildId) {
    const { data } = await ghRead();
    return data.verifiedUsers?.[guildId] || [];
  },
  async addVerifiedUser(guildId, userId, entry) {
    await withDB(data => {
      if (!data.verifiedUsers) data.verifiedUsers = {};
      if (!data.verifiedUsers[guildId]) data.verifiedUsers[guildId] = [];
      const idx = data.verifiedUsers[guildId].findIndex(u => u.userId === userId);
      if (idx >= 0) data.verifiedUsers[guildId][idx] = entry;
      else data.verifiedUsers[guildId].push(entry);
    });
  },
  async getGuildSettings(guildId) {
    const { data } = await ghRead();
    return data.guildSettings?.[guildId] || null;
  },
  async setGuildSettings(guildId, settings) {
    await withDB(data => {
      if (!data.guildSettings) data.guildSettings = {};
      data.guildSettings[guildId] = settings;
    });
  },
  async createRecoveryKey(guildId) {
    const key = require('crypto').randomBytes(10).toString('hex').toUpperCase();
    await withDB(data => {
      if (!data.recoveryKeys) data.recoveryKeys = {};
      data.recoveryKeys[key] = { guildId, createdAt: new Date().toISOString(), used: false };
    });
    return key;
  },
  async useRecoveryKey(key) {
    let found = null;
    await withDB(data => {
      if (!data.recoveryKeys?.[key] || data.recoveryKeys[key].used) return;
      found = data.recoveryKeys[key];
      data.recoveryKeys[key].used = true;
    });
    return found;
  },
};

// ─── Discord Bot ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName('인증창')
      .setDescription('인증 패널을 현재 채널에 설치합니다')
      .addRoleOption(o => o.setName('역할').setDescription('인증 후 부여할 역할').setRequired(true))
      .addStringOption(o => o.setName('웹훅').setDescription('인증 로그를 받을 웹훅 URL').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('복구키만들기')
      .setDescription('서버 복구를 위한 1회용 복구키를 생성합니다')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('복구키사용')
      .setDescription('복구키를 사용하여 인증된 멤버를 현재 서버로 초대합니다')
      .addStringOption(o => o.setName('키').setDescription('복구키를 입력하세요').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map(c => c.toJSON());
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: cmds });
    console.log('✅ 슬래시 명령어 등록 완료');
  } catch (e) {
    console.error('명령어 등록 실패:', e.message);
  }
}

client.once('ready', async () => {
  console.log(`✅ 봇 로그인: ${client.user.tag}`);
  await loadDB(); // 시작 시 DB 미리 로드
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === '인증창')      await cmdVerifyPanel(interaction);
      else if (name === '복구키만들기') await cmdCreateKey(interaction);
      else if (name === '복구키사용')   await cmdUseKey(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'verify_button') {
      await cmdVerifyButton(interaction);
    }
  } catch (err) {
    console.error('인터랙션 오류:', err);
    const msg = { content: '오류가 발생했습니다. 잠시 후 다시 시도하세요.', ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply(msg);
    } catch (_) {}
  }
});

client.on('error', e => console.error('Discord 오류:', e));
process.on('unhandledRejection', e => console.error('미처리 오류:', e));
client.login(process.env.DISCORD_BOT_TOKEN);

// ─── Bot Command Handlers ─────────────────────────────────────────────────────
const WEB_URL = process.env.WEB_URL || 'https://discord-web-vvxf.onrender.com';

async function cmdVerifyPanel(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const role = interaction.options.getRole('역할');
  const webhookUrl = interaction.options.getString('웹훅');
  const guildId = interaction.guild.id;

  await db.setGuildSettings(guildId, {
    roleId: role.id,
    roleName: role.name,
    webhookUrl,
    channelId: interaction.channel.id,
    guildName: interaction.guild.name,
  });

  const embed = new EmbedBuilder()
    .setTitle('서버 인증')
    .setDescription(
      '본 서버의 멤버임을 확인하기 위해 Discord 계정 인증이 필요합니다.\n\n' +
      '인증 완료 시 **' + role.name + '** 역할이 자동으로 부여됩니다.'
    )
    .setColor(0x5865F2)
    .setFooter({ text: interaction.guild.name })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_button')
      .setLabel('인증하기')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.editReply({ content: '인증창이 설치되었습니다.' });
}

async function cmdVerifyButton(interaction) {
  const guildId = interaction.guild.id;
  const settings = await db.getGuildSettings(guildId);
  if (!settings) {
    return interaction.reply({
      content: '인증 설정이 없습니다. `/인증창` 명령어를 먼저 실행해 주세요.',
      ephemeral: true,
    });
  }
  const redirectUri = process.env.DISCORD_REDIRECT_URI || `${WEB_URL}/auth/callback`;
  const authUrl =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${process.env.DISCORD_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=identify%20guilds.join` +
    `&state=${guildId}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Discord 계정으로 인증하기')
      .setStyle(ButtonStyle.Link)
      .setURL(authUrl)
  );
  await interaction.reply({
    content: '아래 버튼을 눌러 인증을 진행해 주세요.',
    components: [row],
    ephemeral: true,
  });
}

async function cmdCreateKey(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guild.id;
  const settings = await db.getGuildSettings(guildId);
  if (!settings) {
    return interaction.editReply({ content: '인증 설정이 없습니다. `/인증창` 명령어를 먼저 실행해 주세요.' });
  }
  const key = await db.createRecoveryKey(guildId);
  const users = await db.getVerifiedUsers(guildId);

  const embed = new EmbedBuilder()
    .setTitle('복구키 생성 완료')
    .setDescription(
      '**복구키 (1회용)**\n```\n' + key + '\n```\n\n' +
      '현재 인증된 멤버 수: **' + users.length + '명**\n\n' +
      '이 키는 1회만 사용 가능합니다. 안전하게 보관하세요.\n' +
      '`/복구키사용 키:발급받은키` 명령어로 멤버를 복구할 수 있습니다.'
    )
    .setColor(0x57F287)
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function cmdUseKey(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const key = interaction.options.getString('키').trim();
  const targetGuildId = interaction.guild.id;

  const keyData = await db.useRecoveryKey(key);
  if (!keyData) {
    return interaction.editReply({ content: '유효하지 않거나 이미 사용된 복구키입니다.' });
  }
  const verifiedUsers = await db.getVerifiedUsers(keyData.guildId);
  if (verifiedUsers.length === 0) {
    return interaction.editReply({ content: '복구할 인증된 멤버가 없습니다.' });
  }
  const settings = await db.getGuildSettings(targetGuildId);
  if (!settings) {
    return interaction.editReply({ content: '현재 서버에 인증 설정이 없습니다. `/인증창` 먼저 실행하세요.' });
  }

  let successCount = 0;
  let failCount = 0;
  await interaction.editReply({ content: `${verifiedUsers.length}명의 멤버를 초대 중입니다...` });

  for (const user of verifiedUsers) {
    try {
      await axios.put(
        `https://discord.com/api/v10/guilds/${targetGuildId}/members/${user.userId}`,
        { access_token: user.accessToken, roles: [settings.roleId] },
        { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      successCount++;
    } catch (err) {
      console.error(`유저 ${user.userId} 초대 실패:`, err.response?.data);
      failCount++;
    }
    await new Promise(r => setTimeout(r, 600));
  }

  const embed = new EmbedBuilder()
    .setTitle('복구 완료')
    .setDescription(
      `성공: **${successCount}명** / 실패: **${failCount}명**\n` +
      `총 ${verifiedUsers.length}명 중 ${successCount}명이 복구되었습니다.`
    )
    .setColor(0x57F287)
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

// ─── OAuth Callback ───────────────────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state: guildId } = req.query;
  if (!code || !guildId) return res.redirect('/?error=missing_params');

  try {
    const redirectUri = process.env.DISCORD_REDIRECT_URI || `${WEB_URL}/auth/callback`;
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token } = tokenRes.data;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const user = userRes.data;

    await db.addVerifiedUser(guildId, user.id, {
      userId: user.id,
      username: user.username,
      globalName: user.global_name,
      avatar: user.avatar,
      accessToken: access_token,
      refreshToken: refresh_token,
      verifiedAt: new Date().toISOString(),
    });

    const settings = await db.getGuildSettings(guildId);

    // 역할 부여
    if (settings) {
      try {
        await axios.put(
          `https://discord.com/api/v10/guilds/${guildId}/members/${user.id}`,
          { access_token, roles: [settings.roleId] },
          { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        console.log(`역할 부여 성공: ${user.username}`);
      } catch (e) {
        console.error('역할 부여 오류:', e.response?.data);
      }

      // 웹훅 전송
      if (settings.webhookUrl) {
        const avatarUrl = user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
          : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) % 6n)}.png`;
        try {
          await axios.post(settings.webhookUrl, {
            embeds: [{
              title: '인증 완료',
              color: 0x57F287,
              thumbnail: { url: avatarUrl },
              fields: [
                { name: '사용자', value: `<@${user.id}> (${user.username})`, inline: true },
                { name: 'ID', value: user.id, inline: true },
                { name: '서버', value: settings.guildName || guildId, inline: false },
              ],
              timestamp: new Date().toISOString(),
              footer: { text: '인증 시스템' },
            }],
          });
          console.log(`웹훅 전송 성공: ${user.username}`);
        } catch (e) {
          console.error('웹훅 전송 오류:', e.response?.data || e.message);
        }
      }
    }

    return res.redirect('/?success=1&user=' + encodeURIComponent(user.global_name || user.username));
  } catch (err) {
    console.error('OAuth 오류:', err.response?.data || err.message);
    return res.redirect('/?error=auth_failed');
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', bot: client.user?.tag || 'connecting...', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/api/db-status', async (_req, res) => {
  try {
    const data = await loadDB();
    const guildCount = Object.keys(data.guildSettings || {}).length;
    const userCount = Object.values(data.verifiedUsers || {}).reduce((a, arr) => a + arr.length, 0);
    res.json({ guildCount, totalVerifiedUsers: userCount, sha: _sha });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`✅ 서버 실행: http://0.0.0.0:${PORT}`));
