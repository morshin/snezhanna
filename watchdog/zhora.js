'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const https = require('https');
const { exec } = require('child_process');
const cron = require('node-cron');

const BOT_TOKEN = process.env.WATCHDOG_BOT_TOKEN;
const OWNER_ID = process.env.TELEGRAM_ALLOWED_USER_ID.replace('@', '');

// ── Telegram send (no deps, pure https) ──────────────────────────────────────

async function tgSend(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: OWNER_ID, text, parse_mode: 'Markdown' });

    // Try to resolve chatId from state if OWNER_ID is a username
    sendRaw(OWNER_ID, text).then(resolve).catch((err) => {
      console.error('[Zhora] tgSend error:', err.message);
      resolve(null);
    });
  });
}

function sendRaw(chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) resolve(parsed);
          else reject(new Error(parsed.description || 'Telegram error'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Shell exec helper ─────────────────────────────────────────────────────────

function sh(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// ── Resolve chatId from state ─────────────────────────────────────────────────

function getChatId() {
  try {
    const stateFile = require('path').join(__dirname, '../.nanobot/state.json');
    if (require('fs').existsSync(stateFile)) {
      const s = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
      if (s.chatId) return String(s.chatId);
    }
  } catch (e) {}
  return OWNER_ID;
}

async function send(text) {
  const chatId = getChatId();
  try {
    await sendRaw(chatId, text);
  } catch (e) {
    console.error('[Zhora] send error:', e.message);
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkSnezhanna() {
  const { code } = await sh('systemctl is-active snezhanna');
  if (code !== 0) {
    console.log('[Zhora] Snezhanna is DOWN. Restarting...');
    const restart = await sh('systemctl restart snezhanna');
    const status = await sh('systemctl is-active snezhanna');
    if (status.code === 0) {
      await send('⚠️ *Жора:* Снежанна упала, перезапустил — теперь OK ✅');
    } else {
      await send('🚨 *Жора:* Снежанна упала и не поднялась после перезапуска! Проверь логи:\n`journalctl -u snezhanna -n 50`');
    }
    return false;
  }
  return true;
}

async function checkTelegramApi() {
  return new Promise((resolve) => {
    const req = https.get('https://api.telegram.org', (res) => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

async function checkMounts() {
  const mounts = [
    { path: '/mnt/yadisk-readonly', name: 'yadisk-readonly' },
    { path: '/mnt/yadisk-agent', name: 'yadisk-agent' }
  ];

  const failed = [];
  for (const mount of mounts) {
    const { code } = await sh(`mountpoint -q ${mount.path}`);
    if (code !== 0) {
      failed.push(mount);
    }
  }

  if (failed.length > 0) {
    for (const mount of failed) {
      console.log(`[Zhora] Mount ${mount.path} is DOWN. Remounting...`);
      const remount = await sh(`mount ${mount.path}`);
      const check = await sh(`mountpoint -q ${mount.path}`);
      if (check.code === 0) {
        await send(`⚠️ *Жора:* Диск \`${mount.name}\` отмонтировался, перемонтировал — OK ✅`);
      } else {
        await send(`🚨 *Жора:* Диск \`${mount.name}\` недоступен и не монтируется! Проверь WebDAV.`);
      }
    }
    return false;
  }
  return true;
}

async function checkDiskSpace() {
  const { stdout } = await sh("df / --output=pcent | tail -1 | tr -d ' %'");
  const used = parseInt(stdout, 10);
  if (!isNaN(used) && used > 85) {
    await send(`⚠️ *Жора:* Диск сервера заполнен на *${used}%*! Скоро закончится место.`);
    return false;
  }
  return true;
}

async function checkLogs() {
  const { stdout } = await sh(
    'journalctl -u snezhanna --since "10 min ago" --no-pager -q 2>/dev/null | grep -i "error\\|fatal\\|uncaught" | tail -5'
  );
  if (stdout && stdout.length > 0) {
    const lines = stdout.split('\n').slice(0, 3).join('\n');
    await send(`⚠️ *Жора:* В логах Снежанны ошибки:\n\`\`\`\n${lines}\n\`\`\``);
    return false;
  }
  return true;
}

// ── Main check cycle ──────────────────────────────────────────────────────────

let telegramWasDown = false;

async function runChecks() {
  const snezhannaOk = await checkSnezhanna();
  const telegramOk = await checkTelegramApi();
  const mountsOk = await checkMounts();
  const diskOk = await checkDiskSpace();
  if (snezhannaOk) await checkLogs();

  if (!telegramOk && !telegramWasDown) {
    telegramWasDown = true;
    console.log('[Zhora] Telegram API is DOWN');
  } else if (telegramOk && telegramWasDown) {
    telegramWasDown = false;
    await send('✅ *Жора:* Telegram API снова доступен.');
  }
}

// ── Schedules ─────────────────────────────────────────────────────────────────

function setupSchedules() {
  // Check every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    runChecks().catch((e) => console.error('[Zhora] Check error:', e.message));
  });

  // Morning report — 07:55 Madrid
  cron.schedule('55 7 * * *', async () => {
    try {
      const snezhannaStatus = (await sh('systemctl is-active snezhanna')).stdout;
      const mountRo = (await sh('mountpoint -q /mnt/yadisk-readonly')).code === 0 ? '✅' : '❌';
      const mountRw = (await sh('mountpoint -q /mnt/yadisk-agent')).code === 0 ? '✅' : '❌';
      const disk = (await sh("df / --output=pcent | tail -1 | tr -d ' %'")).stdout;

      const ok = snezhannaStatus === 'active';
      await send(
        `🤖 *Жора рапортует:*\n\n` +
        `Снежанна: ${ok ? '✅ работает' : '❌ ' + snezhannaStatus}\n` +
        `Диск readonly: ${mountRo}\n` +
        `Диск агент: ${mountRw}\n` +
        `Место на сервере: ${disk}%\n\n` +
        (ok ? 'Снежанна готова к работе ✅' : '⚠️ Требуется внимание!')
      );
    } catch (e) {
      console.error('[Zhora] Morning report error:', e.message);
    }
  }, { timezone: 'Europe/Madrid' });

  console.log('[Zhora] Schedules initialized');
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[Zhora] Starting watchdog...');
  setupSchedules();

  // Startup message
  try {
    await send('🤖 Жора здесь. Слежу за Снежанной.');
    console.log('[Zhora] Startup message sent');
  } catch (e) {
    console.error('[Zhora] Failed to send startup message:', e.message);
  }

  // Initial check after 30s
  setTimeout(() => {
    runChecks().catch((e) => console.error('[Zhora] Initial check error:', e.message));
  }, 30000);

  console.log('[Zhora] Watchdog ready.');
}

main().catch((e) => {
  console.error('[Zhora] Fatal error:', e);
  process.exit(1);
});
