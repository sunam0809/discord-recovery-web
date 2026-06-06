require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const DB_PATH = path.join(__dirname, '../data/db.json');

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadDB() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    const initial = { verifiedUsers: {}, guildSettings: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(data) {
  ensureDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

app.get('/auth/callback', async (req, res) => {
  const { code, state: guildId } = req.query;

  if (!code || !guildId) {
    return res.redirect('/?error=missing_params');
  }

  try {
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token } = tokenRes.data;

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const user = userRes.data;
    const db = loadDB();

    if (!db.verifiedUsers[guildId]) db.verifiedUsers[guildId] = [];

    const existing = db.verifiedUsers[guildId].findIndex(u => u.userId === user.id);
    const entry = {
      userId: user.id,
      username: user.username,
      globalName: user.global_name,
      avatar: user.avatar,
      accessToken: access_token,
      refreshToken: refresh_token,
      verifiedAt: new Date().toISOString(),
    };

    if (existing >= 0) {
      db.verifiedUsers[guildId][existing] = entry;
    } else {
      db.verifiedUsers[guildId].push(entry);
    }

    saveDB(db);

    const settings = db.guildSettings?.[guildId];
    if (settings) {
      try {
        await axios.put(
          `https://discord.com/api/v10/guilds/${guildId}/members/${user.id}`,
          {
            access_token,
            roles: [settings.roleId],
          },
          {
            headers: {
              Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );
      } catch (e) {
        console.log('역할 부여 중 오류 (이미 멤버일 수 있음):', e.response?.data);
      }

      if (settings.webhookUrl) {
        try {
          const avatarUrl = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/0.png`;

          await axios.post(settings.webhookUrl, {
            embeds: [{
              title: '✅ 새 멤버 인증 완료',
              description: `**${user.global_name || user.username}** 님이 인증을 완료했습니다.`,
              color: 0x57F287,
              thumbnail: { url: avatarUrl },
              fields: [
                { name: '유저 ID', value: user.id, inline: true },
                { name: '유저명', value: user.username, inline: true },
                { name: '서버', value: settings.guildName || guildId, inline: false },
              ],
              timestamp: new Date().toISOString(),
              footer: { text: 'Discord 복구봇 인증 시스템' },
            }],
          });
        } catch (e) {
          console.log('웹훅 전송 오류:', e.message);
        }
      }
    }

    return res.redirect('/?success=1&user=' + encodeURIComponent(user.global_name || user.username));
  } catch (err) {
    console.error('OAuth 오류:', err.response?.data || err.message);
    return res.redirect('/?error=auth_failed');
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ 웹 서버 실행 중: http://localhost:${PORT}`);
});
