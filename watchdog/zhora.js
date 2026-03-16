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

// ── Monitored services ────────────────────────────────────────────────────────

const SERVICES = [
  { name: 'Снежанна', unit: 'snezhanna' },
  { name: 'Макс',     unit: 'tutor'     },
];

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkService(service) {
  const { code } = await sh(`systemctl is-active ${service.unit}`);
  if (code !== 0) {
    console.log(`[Zhora] ${service.name} (${service.unit}) is DOWN. Restarting...`);
    await sh(`sudo systemctl restart ${service.unit}`);
    const status = await sh(`systemctl is-active ${service.unit}`);
    if (status.code === 0) {
      await send(`⚠️ *Жора:* ${service.name} упала, перезапустил — теперь OK ✅`);
    } else {
      await send(`🚨 *Жора:* ${service.name} упала и не поднялась после перезапуска! Проверь логи:\n\`journalctl -u ${service.unit} -n 50\``);
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

async function checkLogs(unit, name) {
  const { stdout } = await sh(
    `journalctl -u ${unit} --since "10 min ago" --no-pager -q 2>/dev/null | grep -i "error\\|fatal\\|uncaught" | tail -5`
  );
  if (stdout && stdout.length > 0) {
    const lines = stdout.split('\n').slice(0, 3).join('\n');
    await send(`⚠️ *Жора:* В логах ${name} ошибки:\n\`\`\`\n${lines}\n\`\`\``);
    return false;
  }
  return true;
}

// ── Telegram polling (no deps) ───────────────────────────────────────────────

let pollOffset = 0;

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: body ? 'POST' : 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) resolve(parsed.result);
          else reject(new Error(parsed.description || 'Telegram API error'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(35000, () => { req.destroy(); reject(new Error('poll timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function isAllowed(msg) {
  if (!msg || !msg.from) return false;
  const { id, username } = msg.from;
  return String(id) === OWNER_ID || (username && username === OWNER_ID);
}

async function getServiceStatusLine(service) {
  const statusResult = (await sh(`systemctl is-active ${service.unit}`)).stdout;
  const isOk = statusResult === 'active';
  let uptimeStr = '';
  if (isOk) {
    const { stdout } = await sh(`systemctl show ${service.unit} --property=ActiveEnterTimestamp --value`);
    if (stdout) {
      const started = new Date(stdout);
      const diff = Date.now() - started.getTime();
      if (!isNaN(diff) && diff > 0) {
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        uptimeStr = days > 0 ? ` (uptime ${days}d ${hours}h)` : ` (uptime ${hours}h)`;
      }
    }
  }
  return `${service.name}: ${isOk ? '✅ active' + uptimeStr : '❌ ' + statusResult}`;
}

async function handleStatusCommand(chatId) {
  try {
    const serviceLines = [];
    let totalErrors = 0;
    for (const svc of SERVICES) {
      serviceLines.push(await getServiceStatusLine(svc));
      const { stdout: logErrors } = await sh(
        `journalctl -u ${svc.unit} --since "10 min ago" --no-pager -q 2>/dev/null | grep -ic "error\\|fatal\\|uncaught"`
      );
      totalErrors += parseInt(logErrors, 10) || 0;
    }

    const telegramOk = await checkTelegramApi();
    const mountRo = (await sh('mountpoint -q /mnt/yadisk-readonly')).code === 0;
    const mountRw = (await sh('mountpoint -q /mnt/yadisk-agent')).code === 0;
    const disk = (await sh("df / --output=pcent | tail -1 | tr -d ' %'")).stdout;

    const report =
      `🤖 *Жора рапортует:*\n\n` +
      serviceLines.join('\n') + '\n' +
      `Telegram API: ${telegramOk ? '✅' : '❌'}\n` +
      `Диск readonly: ${mountRo ? '✅' : '❌'}\n` +
      `Диск агент: ${mountRw ? '✅' : '❌'}\n` +
      `Место на сервере: ${disk}%\n` +
      `Ошибки в логах: ${totalErrors > 0 ? '⚠️ ' + totalErrors + ' за 10 мин' : 'нет'}`;

    await sendRaw(chatId, report);
  } catch (e) {
    console.error('[Zhora] /status error:', e.message);
    await sendRaw(chatId, '❌ Ошибка при сборе статуса: ' + e.message).catch(() => {});
  }
}

async function handleLogsCommand(chatId, rawArg) {
  try {
    // Парсим аргументы: /logs [snezhanna|max|index] [N]
    // Примеры: /logs, /logs 50, /logs max, /logs max 20, /logs index
    const parts = (rawArg || '').trim().split(/\s+/);

    let target = 'snezhanna';
    let nRaw = null;

    for (const part of parts) {
      if (/^(snezhanna|снежанна)$/i.test(part)) { target = 'snezhanna'; }
      else if (/^(max|макс|tutor)$/i.test(part))  { target = 'tutor'; }
      else if (/^(index|индекс)$/i.test(part))     { target = 'index'; }
      else if (/^\d+$/.test(part))                 { nRaw = part; }
    }

    const n = Math.min(Math.max(parseInt(nRaw, 10) || 30, 5), 100);

    let stdout, label, errorUnit;

    if (target === 'index') {
      // Индексер пишет в файл, не в journalctl
      const { stdout: tail } = await sh(`tail -n ${n} /var/log/snezhanna-index.log 2>/dev/null`);
      stdout = tail;
      label = 'Индексер Яндекс.Диска';
      errorUnit = null;
    } else {
      const { stdout: jout } = await sh(
        `journalctl -u ${target} -n ${n} --no-pager --output=cat 2>/dev/null`
      );
      stdout = jout;
      label = target === 'snezhanna' ? 'Снежанны' : 'Макса';
      errorUnit = target;
    }

    if (!stdout || stdout.trim() === '') {
      await sendRaw(chatId, `📋 *Логи ${label}*\n\nЛоги пусты или сервис ещё не запускался.`);
      return;
    }

    // Обрезаем слишком длинные строки (например, дамп инструментов)
    const lines = stdout.trim().split('\n').map(line =>
      line.length > 180 ? line.slice(0, 177) + '…' : line
    );

    // Считаем ошибки за последний час (только для systemd-юнитов)
    let footer = '';
    if (errorUnit) {
      const { stdout: errOut } = await sh(
        `journalctl -u ${errorUnit} --since "1 hour ago" --no-pager -q 2>/dev/null` +
        ' | grep -ic "error\\|fatal\\|uncaught" || echo 0'
      );
      const errorCount = parseInt(errOut, 10) || 0;
      footer = errorCount > 0
        ? `\n⚠️ Ошибок за последний час: *${errorCount}*`
        : '\n✅ Ошибок за последний час нет';
    }

    const header = `📋 *Логи ${label}* — последние ${lines.length} строк\n`;

    // Telegram ограничение: 4096 символов на сообщение
    const maxBody = 4096 - header.length - footer.length - 10;
    let body = lines.join('\n');
    if (body.length > maxBody) {
      body = '…\n' + body.slice(body.length - maxBody + 2);
    }

    const message = header + '```\n' + body + '\n```' + footer;
    await sendRaw(chatId, message);
  } catch (e) {
    console.error('[Zhora] /logs error:', e.message);
    await sendRaw(chatId, '❌ Ошибка при получении логов: ' + e.message).catch(() => {});
  }
}

// ── Lang week (язык недели Макса) ─────────────────────────────────────────────

const LANG_FILE = require('path').join(__dirname, '../tutor/lang-week.json');

// Вычисляем ISO-номер недели — дублируем логику из lang-week.js
// (Жора намеренно избегает зависимостей, поэтому не импортирует тот модуль)
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function handleLangCommand(chatId, arg) {
  const fs = require('fs');

  // /lang без аргумента — показать текущий язык
  if (!arg) {
    try {
      const data = fs.existsSync(LANG_FILE)
        ? JSON.parse(fs.readFileSync(LANG_FILE, 'utf8'))
        : { lang: 'es', weekStr: '' };
      const langName = data.lang === 'ru' ? 'русский 🇷🇺' : 'испанский 🇪🇸';
      const week = data.weekStr || '(не задана)';
      await sendRaw(chatId,
        `🗣 *Язык недели Макса:* ${langName}\nНеделя: ${week}\n\nЧтобы сменить: /lang ru  или  /lang es`
      );
    } catch (e) {
      await sendRaw(chatId, '❌ Ошибка чтения файла языка: ' + e.message);
    }
    return;
  }

  const lang = arg.toLowerCase().trim();
  if (lang !== 'es' && lang !== 'ru') {
    await sendRaw(chatId,
      '❌ Неизвестный язык. Доступные:\n• `ru` — русский\n• `es` — испанский'
    );
    return;
  }

  try {
    const weekStr = getISOWeek(new Date());
    const data = { lang, weekStr, setAt: new Date().toISOString() };
    fs.writeFileSync(LANG_FILE, JSON.stringify(data, null, 2), 'utf8');
    const langName = lang === 'ru' ? 'русский 🇷🇺' : 'испанский 🇪🇸';
    await sendRaw(chatId,
      `✅ Язык Макса на эту неделю: *${langName}*\nМакс начнёт использовать новый язык сразу при следующем запросе.`
    );
    console.log('[Zhora] Max language set to:', lang, 'week:', weekStr);
  } catch (e) {
    await sendRaw(chatId, '❌ Ошибка записи файла языка: ' + e.message);
    console.error('[Zhora] Failed to set language:', e.message);
  }
}

// Ожидающие подтверждения перезапуска: chatId → { timestamp, unit, name }
const pendingRestarts = new Map();

function findServiceByAlias(alias) {
  const lower = (alias || '').toLowerCase().trim();
  if (!lower || lower === 'snezhanna' || lower === 'снежанна') {
    return SERVICES.find(s => s.unit === 'snezhanna');
  }
  if (lower === 'max' || lower === 'макс' || lower === 'tutor') {
    return SERVICES.find(s => s.unit === 'tutor');
  }
  return null;
}

async function handleRestartCommand(chatId, arg) {
  const service = findServiceByAlias(arg || 'snezhanna');
  if (!service) {
    await sendRaw(chatId, '❌ Неизвестный сервис. Доступные: snezhanna, max');
    return;
  }
  pendingRestarts.set(chatId, { ts: Date.now(), unit: service.unit, name: service.name });
  await sendRaw(chatId,
    `⚠️ *Перезапустить ${service.name}?*\n\n` +
    'Отправь /restart\\_confirm чтобы подтвердить.\n' +
    'Запрос действует 60 секунд.'
  );
}

async function handleRestartConfirm(chatId) {
  const pending = pendingRestarts.get(chatId);
  if (!pending || Date.now() - pending.ts > 60000) {
    pendingRestarts.delete(chatId);
    await sendRaw(chatId, '❌ Запрос на перезапуск устарел или не был создан. Отправь /restart заново.');
    return;
  }
  pendingRestarts.delete(chatId);

  const { unit, name } = pending;
  await sendRaw(chatId, `🔄 Перезапускаю ${name}...`);
  console.log(`[Zhora] Manual restart requested for ${unit}`);

  await sh(`sudo systemctl restart ${unit}`);
  await new Promise(r => setTimeout(r, 3000));

  const { stdout: status } = await sh(`systemctl is-active ${unit}`);
  if (status === 'active') {
    await sendRaw(chatId, `✅ ${name} перезапущена и работает.`);
  } else {
    await sendRaw(chatId, `🚨 Перезапуск выполнен, но статус: *${status || 'неизвестен'}*. Проверь логи:\n\`journalctl -u ${unit} -n 50\``);
  }
}

async function pollLoop() {
  while (true) {
    try {
      const updates = await tgApi('getUpdates', {
        offset: pollOffset,
        timeout: 30,
        allowed_updates: ['message']
      });

      for (const update of updates) {
        pollOffset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text || !isAllowed(msg)) continue;

        if (msg.text === '/status') {
          console.log('[Zhora] /status command from', msg.from.id);
          handleStatusCommand(msg.chat.id).catch(e =>
            console.error('[Zhora] handleStatusCommand error:', e.message)
          );
        } else if (msg.text.startsWith('/logs')) {
          const arg = msg.text.split(' ')[1];
          console.log('[Zhora] /logs command from', msg.from.id, 'args:', arg || '(default)');
          handleLogsCommand(msg.chat.id, arg).catch(e =>
            console.error('[Zhora] handleLogsCommand error:', e.message)
          );
        } else if (msg.text.startsWith('/restart_confirm')) {
          console.log('[Zhora] /restart_confirm command from', msg.from.id);
          handleRestartConfirm(msg.chat.id).catch(e =>
            console.error('[Zhora] handleRestartConfirm error:', e.message)
          );
        } else if (msg.text.startsWith('/restart')) {
          const arg = msg.text.split(' ')[1];
          console.log('[Zhora] /restart command from', msg.from.id, 'service:', arg || 'snezhanna');
          handleRestartCommand(msg.chat.id, arg).catch(e =>
            console.error('[Zhora] handleRestartCommand error:', e.message)
          );
        } else if (msg.text.startsWith('/lang')) {
          const arg = msg.text.split(' ')[1];
          console.log('[Zhora] /lang command from', msg.from.id, 'arg:', arg || '(show current)');
          handleLangCommand(msg.chat.id, arg).catch(e =>
            console.error('[Zhora] handleLangCommand error:', e.message)
          );
        }
      }
    } catch (e) {
      // Network hiccup — wait a bit and retry
      console.error('[Zhora] Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── Main check cycle ──────────────────────────────────────────────────────────

let telegramWasDown = false;

async function runChecks() {
  for (const svc of SERVICES) {
    const ok = await checkService(svc);
    if (ok) await checkLogs(svc.unit, svc.name);
  }
  const telegramOk = await checkTelegramApi();
  await checkMounts();
  await checkDiskSpace();

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
      const serviceLines = [];
      let allOk = true;
      for (const svc of SERVICES) {
        const status = (await sh(`systemctl is-active ${svc.unit}`)).stdout;
        const ok = status === 'active';
        if (!ok) allOk = false;
        serviceLines.push(`${svc.name}: ${ok ? '✅ работает' : '❌ ' + status}`);
      }
      const mountRo = (await sh('mountpoint -q /mnt/yadisk-readonly')).code === 0 ? '✅' : '❌';
      const mountRw = (await sh('mountpoint -q /mnt/yadisk-agent')).code === 0 ? '✅' : '❌';
      const disk = (await sh("df / --output=pcent | tail -1 | tr -d ' %'")).stdout;

      await send(
        `🤖 *Жора рапортует:*\n\n` +
        serviceLines.join('\n') + '\n' +
        `Диск readonly: ${mountRo}\n` +
        `Диск агент: ${mountRw}\n` +
        `Место на сервере: ${disk}%\n\n` +
        (allOk ? 'Все системы готовы к работе ✅' : '⚠️ Требуется внимание!')
      );
    } catch (e) {
      console.error('[Zhora] Morning report error:', e.message);
    }
  }, { timezone: 'Europe/Madrid' });

  console.log('[Zhora] Schedules initialized');
}

// ── Bot commands menu ─────────────────────────────────────────────────────────

async function registerCommands() {
  try {
    await tgApi('setMyCommands', {
      commands: [
        { command: 'status',          description: 'Статус всех сервисов и инфраструктуры' },
        { command: 'logs',            description: 'Логи: /logs [snezhanna|max|index] [N]' },
        { command: 'restart',         description: 'Перезапустить сервис: /restart [snezhanna|max]' },
        { command: 'restart_confirm', description: 'Подтвердить перезапуск' },
        { command: 'lang',            description: 'Язык недели Макса: /lang [ru|es]' },
      ]
    });
    console.log('[Zhora] Bot commands registered');
  } catch (e) {
    console.error('[Zhora] Failed to register commands:', e.message);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[Zhora] Starting watchdog...');
  setupSchedules();
  await registerCommands();

  // Startup message
  try {
    await send('🤖 Жора здесь. Слежу за Снежанной и Максом.');
    console.log('[Zhora] Startup message sent');
  } catch (e) {
    console.error('[Zhora] Failed to send startup message:', e.message);
  }

  // Start polling for /status commands
  pollLoop();

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
