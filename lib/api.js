'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');
const tasksMerge = require('./tasks-merge');
const google = require('./google');
const github = require('./github');
const settings = require('./settings');
const chatMonitor = require('./chat-monitor');
const { db } = require('./db');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const PORT = (config.mini_app && config.mini_app.port) || 3001;
const MINI_APP_DIR = path.join(__dirname, '../mini-app');

// ── initData validation ─────────────────────────────────────────────────────

function validateInitData(initDataRaw) {
  if (!initDataRaw) return false;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('[API] TELEGRAM_BOT_TOKEN not set, cannot validate initData');
    return false;
  }

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash) return false;

    params.delete('hash');
    const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computed !== hash) return false;

    // Check auth_date is not older than 1 hour
    const authDate = parseInt(params.get('auth_date'), 10);
    if (!authDate) return false;
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > 3600) return false;

    return true;
  } catch (e) {
    console.error('[API] initData validation error:', e.message);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        if (!raw) {
          resolve({});
          return;
        }
        const parsed = JSON.parse(raw);
        // Иначе { id, ...body } даст TypeError (null / массив / примитив) и роняет обработчик
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          resolve({});
        } else {
          resolve(parsed);
        }
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function serveStatic(res, filePath) {
  const resolved = path.resolve(MINI_APP_DIR, filePath);
  if (!resolved.startsWith(MINI_APP_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const data = fs.readFileSync(resolved);
    const ext = path.extname(resolved);
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    // Mini App WebView (esp. iOS Telegram) caches HTML strongly — avoid stale UI after deploy.
    const headers =
      ext === '.html'
        ? {
            'Content-Type': type,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            Pragma: 'no-cache'
          }
        : { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' };
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

// ── Calendar helpers ────────────────────────────────────────────────────────

function formatCalendarEvents(items) {
  return items.map(ev => ({
    id: ev.id,
    title: ev.summary || '(No title)',
    start: ev.start.dateTime || ev.start.date,
    end: ev.end.dateTime || ev.end.date,
    allDay: !ev.start.dateTime,
    color: ev.colorId || null,
    location: ev.location || null
  }));
}

// ── App state context (set from index.js) ──────────────────────────────────

let _appState = null;
let _saveState = null;
let _rescheduleBriefing = null;
let _rescheduleEmailPoll = null;

function setApiContext(appState, saveStateFn, rescheduleBriefingFn, rescheduleEmailPollFn) {
  _appState = appState;
  _saveState = saveStateFn;
  _rescheduleBriefing = rescheduleBriefingFn || null;
  _rescheduleEmailPoll = rescheduleEmailPollFn || null;
}

// ── Route matching ──────────────────────────────────────────────────────────

function parseRoute(method, pathname) {
  // GET /api/tasks
  if (method === 'GET' && pathname === '/api/tasks') return { handler: 'listTasks' };

  // POST /api/tasks/:id/complete
  const completeMatch = pathname.match(/^\/api\/tasks\/(\d+)\/complete$/);
  if (method === 'POST' && completeMatch) return { handler: 'completeTask', id: Number(completeMatch[1]) };

  // PATCH /api/tasks/:id
  const patchMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (method === 'PATCH' && patchMatch) return { handler: 'updateTask', id: Number(patchMatch[1]) };

  // DELETE /api/tasks/:id
  const deleteMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (method === 'DELETE' && deleteMatch) return { handler: 'deleteTask', id: Number(deleteMatch[1]) };

  // GET /api/github/milestones (legacy: /api/github/issues — тот же ответ)
  if (method === 'GET' && pathname === '/api/github/milestones') return { handler: 'githubMilestones' };
  if (method === 'GET' && pathname === '/api/github/issues') return { handler: 'githubMilestones' };

  // GET /api/calendar/day
  if (method === 'GET' && pathname === '/api/calendar/day') return { handler: 'calendarDay' };

  // GET /api/calendar/week
  if (method === 'GET' && pathname === '/api/calendar/week') return { handler: 'calendarWeek' };

  // Settings
  if (method === 'GET'  && pathname === '/api/settings')        return { handler: 'settingsGet' };
  if (method === 'POST' && pathname === '/api/settings')        return { handler: 'settingsSet' };
  if (method === 'POST' && pathname === '/api/settings/batch')  return { handler: 'settingsBatch' };

  // Quiet mode
  if (method === 'POST' && pathname === '/api/quiet')           return { handler: 'quietSet' };

  // Chats
  if (method === 'GET'  && pathname === '/api/chats')           return { handler: 'chatsGet' };
  if (method === 'POST' && pathname === '/api/chats')           return { handler: 'chatsAdd' };
  const chatDeleteMatch = pathname.match(/^\/api\/chats\/(-?\d+)$/);
  if (method === 'DELETE' && chatDeleteMatch) return { handler: 'chatsDelete', chatId: Number(chatDeleteMatch[1]) };

  // Projects
  if (method === 'GET'  && pathname === '/api/projects')        return { handler: 'projectsList' };
  if (method === 'POST' && pathname === '/api/projects')        return { handler: 'projectsCreate' };
  const projectMatch = pathname.match(/^\/api\/projects\/(\d+)$/);
  if (method === 'PATCH' && projectMatch)                       return { handler: 'projectsPatch', id: Number(projectMatch[1]) };
  const paramsMatch = pathname.match(/^\/api\/projects\/(\d+)\/params$/);
  if (method === 'GET'  && paramsMatch) return { handler: 'projectParamsGet', id: Number(paramsMatch[1]) };
  if (method === 'POST' && paramsMatch) return { handler: 'projectParamsSet', id: Number(paramsMatch[1]) };

  // Contacts
  if (method === 'GET'  && pathname === '/api/contacts')        return { handler: 'contactsList' };
  if (method === 'POST' && pathname === '/api/contacts')        return { handler: 'contactsCreate' };
  const contactMatch = pathname.match(/^\/api\/contacts\/(\d+)$/);
  if (method === 'PATCH'  && contactMatch) return { handler: 'contactsPatch',  id: Number(contactMatch[1]) };
  if (method === 'DELETE' && contactMatch) return { handler: 'contactsDelete', id: Number(contactMatch[1]) };
  const contactProjectsMatch = pathname.match(/^\/api\/contacts\/(\d+)\/projects$/);
  if (method === 'GET'  && contactProjectsMatch) return { handler: 'contactProjectsGet', id: Number(contactProjectsMatch[1]) };
  if (method === 'POST' && contactProjectsMatch) return { handler: 'contactProjectsAdd', id: Number(contactProjectsMatch[1]) };
  const contactProjectUnlinkMatch = pathname.match(/^\/api\/contacts\/(\d+)\/projects\/(\d+)$/);
  if (method === 'DELETE' && contactProjectUnlinkMatch) return { handler: 'contactProjectsRemove', id: Number(contactProjectUnlinkMatch[1]), pid: Number(contactProjectUnlinkMatch[2]) };

  // Email accounts
  if (method === 'GET'  && pathname === '/api/email-accounts') return { handler: 'emailAccountsList' };
  if (method === 'POST' && pathname === '/api/email-accounts') return { handler: 'emailAccountsCreate' };
  const emailAccountMatch = pathname.match(/^\/api\/email-accounts\/(\d+)$/);
  if (method === 'PATCH'  && emailAccountMatch) return { handler: 'emailAccountsPatch',  id: Number(emailAccountMatch[1]) };
  if (method === 'DELETE' && emailAccountMatch) return { handler: 'emailAccountsDelete', id: Number(emailAccountMatch[1]) };
  const emailTestMatch = pathname.match(/^\/api\/email-accounts\/(\d+)\/test$/);
  if (method === 'POST' && emailTestMatch) return { handler: 'emailAccountsTest', id: Number(emailTestMatch[1]) };
  const emailAuthUrlMatch = pathname.match(/^\/api\/email-accounts\/(\d+)\/auth-url$/);
  if (method === 'GET' && emailAuthUrlMatch) return { handler: 'emailAccountAuthUrl', id: Number(emailAuthUrlMatch[1]) };
  const emailAuthCodeMatch = pathname.match(/^\/api\/email-accounts\/(\d+)\/auth-code$/);
  if (method === 'POST' && emailAuthCodeMatch) return { handler: 'emailAccountAuthCode', id: Number(emailAuthCodeMatch[1]) };

  // Google OAuth (for mini app auth guide)
  if (method === 'GET'  && pathname === '/api/google/auth-url')  return { handler: 'googleAuthUrl' };
  if (method === 'POST' && pathname === '/api/google/auth-code') return { handler: 'googleAuthCode' };

  // System status / control
  if (method === 'GET'  && pathname === '/api/system/status')  return { handler: 'systemStatus' };
  if (method === 'POST' && pathname === '/api/system/restart') return { handler: 'systemRestart' };
  if (method === 'POST' && pathname === '/api/system/start')   return { handler: 'systemStart' };
  if (method === 'POST' && pathname === '/api/system/update')  return { handler: 'systemUpdate' };

  return null;
}

// ── Request handler ─────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data'
    });
    res.end();
    return;
  }

  // Static files
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    serveStatic(res, file);
    return;
  }

  // API routes — require valid initData
  const initData = req.headers['x-init-data'];
  if (!validateInitData(initData)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const route = parseRoute(req.method, pathname);
  if (!route) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  try {
    switch (route.handler) {
      case 'listTasks': {
        const filter = url.searchParams.get('filter') || 'today';
        if (filter === 'today') {
          const result = await tasksMerge.getTodayTasksWithGithub();
          sendJson(res, 200, { tasks: result });
        } else {
          const result = await tasksMerge.listTasksWithGithub({ status: 'pending' });
          sendJson(res, 200, result);
        }
        break;
      }

      case 'completeTask': {
        const opts = { id: route.id };
        if (url.searchParams.has('project')) {
          const v = url.searchParams.get('project');
          opts.project = v === '' ? null : v;
        }
        const result = tasks.completeTask(opts);
        if (result.error) {
          sendJson(res, 404, result);
        } else {
          sendJson(res, 200, result);
        }
        break;
      }

      case 'updateTask': {
        const body = await readBody(req);
        const result = tasks.updateTask({ id: route.id, ...body });
        if (result.error) {
          sendJson(res, 404, result);
        } else {
          sendJson(res, 200, result);
        }
        break;
      }

      case 'githubMilestones': {
        if (!github.isConfigured()) {
          sendJson(res, 503, { error: 'GitHub integration not configured' });
          break;
        }
        const project = url.searchParams.get('project') || null;
        const milestones = await github.getUpcomingMilestones(project);
        sendJson(res, 200, { milestones });
        break;
      }

      case 'calendarDay': {
        if (!google.isAuthorized()) {
          sendJson(res, 503, { error: 'Google not authorized' });
          break;
        }
        const dayEvents = await google.getCalendarEvents(1);
        sendJson(res, 200, { events: formatCalendarEvents(dayEvents) });
        break;
      }

      case 'calendarWeek': {
        if (!google.isAuthorized()) {
          sendJson(res, 503, { error: 'Google not authorized' });
          break;
        }
        const weekEvents = await google.getCalendarEvents(7);
        sendJson(res, 200, { events: formatCalendarEvents(weekEvents) });
        break;
      }

      case 'deleteTask': {
        const del = { id: route.id };
        if (url.searchParams.has('project')) {
          const v = url.searchParams.get('project');
          del.project = v === '' ? null : v;
        }
        const result = tasks.deleteTask(del);
        if (result.error) {
          sendJson(res, 404, result);
        } else {
          sendJson(res, 200, result);
        }
        break;
      }

      // ── Settings ──────────────────────────────────────────────────────────

      case 'settingsGet': {
        const all = settings.getAll();
        if (_appState) all.quiet_until = _appState.quietUntil || null;
        sendJson(res, 200, all);
        break;
      }

      case 'settingsSet': {
        const body = await readBody(req);
        if (!body.key || body.value === undefined) { sendJson(res, 400, { error: 'key and value required' }); break; }
        if (body.key === 'briefing_time' && _rescheduleBriefing) _rescheduleBriefing(body.value);
        settings.set(body.key, body.value);
        sendJson(res, 200, { ok: true });
        break;
      }

      case 'settingsBatch': {
        const body = await readBody(req);
        if (!body.settings || typeof body.settings !== 'object') { sendJson(res, 400, { error: 'settings object required' }); break; }
        for (const [k, v] of Object.entries(body.settings)) {
          if (k === 'briefing_time' && _rescheduleBriefing) _rescheduleBriefing(v);
          settings.set(k, v);
        }
        sendJson(res, 200, { ok: true });
        break;
      }

      case 'quietSet': {
        const body = await readBody(req);
        if (!_appState || !_saveState) { sendJson(res, 503, { error: 'App state not available' }); break; }
        if (body.until === null || body.until === '') {
          _appState.quietUntil = null;
        } else if (body.until) {
          _appState.quietUntil = new Date(body.until).toISOString();
          _appState.silenceDaysCount = 0;
          _appState.silenceLevel = 0;
        }
        _saveState(_appState);
        sendJson(res, 200, { ok: true, quiet_until: _appState.quietUntil });
        break;
      }

      // ── Chats ─────────────────────────────────────────────────────────────

      case 'chatsGet': {
        sendJson(res, 200, { chats: chatMonitor.listChats() });
        break;
      }

      case 'chatsAdd': {
        const body = await readBody(req);
        if (!body.chat_id || !body.name) { sendJson(res, 400, { error: 'chat_id and name required' }); break; }
        chatMonitor.addChat({ chat_id: Number(body.chat_id), name: body.name, type: body.type || 'personal', category: body.category || null, project: body.project || null });
        sendJson(res, 201, { ok: true });
        break;
      }

      case 'chatsDelete': {
        chatMonitor.removeChat(route.chatId);
        sendJson(res, 200, { ok: true });
        break;
      }

      // ── Projects ──────────────────────────────────────────────────────────

      case 'projectsList': {
        const rows = db.prepare("SELECT id, name, display_name, status, description FROM projects WHERE status != 'archived' ORDER BY name").all();
        sendJson(res, 200, { projects: rows });
        break;
      }

      case 'projectsCreate': {
        const body = await readBody(req);
        if (!body.name) { sendJson(res, 400, { error: 'name required' }); break; }
        try {
          db.prepare("INSERT INTO projects (name, display_name, description) VALUES (?, ?, ?)").run(body.name, body.display_name || body.name, body.description || null);
          const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(body.name);
          sendJson(res, 201, row);
        } catch (e) {
          sendJson(res, 409, { error: e.message });
        }
        break;
      }

      case 'projectsPatch': {
        const body = await readBody(req);
        const allowed = ['display_name', 'description', 'status', 'github_repo'];
        const sets = [];
        const vals = [];
        for (const k of allowed) {
          if (body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(body[k]); }
        }
        if (sets.length === 0) { sendJson(res, 400, { error: 'Nothing to update' }); break; }
        sets.push("updated_at = datetime('now')");
        vals.push(route.id);
        db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        sendJson(res, 200, { ok: true });
        break;
      }

      case 'projectParamsGet': {
        const rows = db.prepare('SELECT key, value FROM project_params WHERE project_id = ?').all(route.id);
        sendJson(res, 200, { params: Object.fromEntries(rows.map(r => [r.key, r.value])) });
        break;
      }

      case 'projectParamsSet': {
        const body = await readBody(req);
        if (!body.key) { sendJson(res, 400, { error: 'key required' }); break; }
        db.prepare('INSERT OR REPLACE INTO project_params (project_id, key, value) VALUES (?, ?, ?)').run(route.id, body.key, body.value ?? null);
        sendJson(res, 200, { ok: true });
        break;
      }

      // ── Contacts ─────────────────────────────────────────────────────────

      case 'contactsList': {
        const rows = db.prepare('SELECT * FROM contacts ORDER BY name').all();
        sendJson(res, 200, { contacts: rows });
        break;
      }

      case 'contactsCreate': {
        const body = await readBody(req);
        if (!body.name) { sendJson(res, 400, { error: 'name required' }); break; }
        const r = db.prepare("INSERT INTO contacts (name, role, company, telegram, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(body.name, body.role || null, body.company || null, body.telegram || null, body.email || null, body.phone || null, body.notes || null);
        sendJson(res, 201, { id: r.lastInsertRowid });
        break;
      }

      case 'contactsPatch': {
        const body = await readBody(req);
        const allowed = ['name', 'role', 'company', 'telegram', 'email', 'phone', 'notes'];
        const sets = []; const vals = [];
        for (const k of allowed) { if (body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(body[k]); } }
        if (sets.length === 0) { sendJson(res, 400, { error: 'Nothing to update' }); break; }
        sets.push("updated_at = datetime('now')"); vals.push(route.id);
        db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        sendJson(res, 200, { ok: true });
        break;
      }

      case 'contactsDelete': {
        db.prepare('DELETE FROM contacts WHERE id = ?').run(route.id);
        sendJson(res, 200, { ok: true });
        break;
      }

      case 'contactProjectsGet': {
        const rows = db.prepare('SELECT p.* FROM projects p JOIN project_contacts pc ON p.id = pc.project_id WHERE pc.contact_id = ?').all(route.id);
        sendJson(res, 200, { projects: rows });
        break;
      }

      case 'contactProjectsAdd': {
        const body = await readBody(req);
        if (!body.project_id) { sendJson(res, 400, { error: 'project_id required' }); break; }
        try {
          db.prepare('INSERT OR IGNORE INTO project_contacts (contact_id, project_id, role_in_project) VALUES (?, ?, ?)').run(route.id, body.project_id, body.role_in_project || null);
          sendJson(res, 201, { ok: true });
        } catch (e) { sendJson(res, 409, { error: e.message }); }
        break;
      }

      case 'contactProjectsRemove': {
        db.prepare('DELETE FROM project_contacts WHERE contact_id = ? AND project_id = ?').run(route.id, route.pid);
        sendJson(res, 200, { ok: true });
        break;
      }

      case 'emailAccountsList': {
        const accounts = db.prepare("SELECT id, label, email, type, account_type, enabled, credentials FROM email_accounts ORDER BY id").all().map(a => {
          let creds_info = null;
          let gmail_authorized = false;
          if (a.credentials) {
            try {
              const c = JSON.parse(a.credentials);
              creds_info = { host: c.host || '', port: c.port || 993, user: c.user || '', smtp_host: c.smtp_host || '', smtp_port: c.smtp_port || '', has_password: !!c.password };
              if (a.type === 'gmail') gmail_authorized = !!(c.access_token);
            } catch {}
          }
          return { id: a.id, label: a.label, email: a.email, type: a.type, account_type: a.account_type, enabled: a.enabled, creds_info, gmail_authorized };
        });
        sendJson(res, 200, { accounts, google_authorized: google.isAuthorized() });
        break;
      }

      case 'emailAccountsCreate': {
        const body = await readBody(req);
        if (!body.label || !body.email || !body.type) {
          sendJson(res, 400, { error: 'label, email, and type are required' }); break;
        }
        const credentials = body.credentials ? JSON.stringify(body.credentials) : null;
        const result = db.prepare(
          "INSERT INTO email_accounts (label, email, type, account_type, enabled, credentials) VALUES (?, ?, ?, ?, 1, ?)"
        ).run(body.label, body.email, body.type, body.account_type || 'personal', credentials);
        sendJson(res, 201, { id: result.lastInsertRowid });
        break;
      }

      case 'emailAccountsPatch': {
        const body = await readBody(req);
        const allowed = ['label', 'email', 'type', 'enabled', 'account_type'];
        const sets = [];
        const vals = [];
        for (const k of allowed) {
          if (body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(body[k]); }
        }
        if (body.credentials !== undefined) {
          // If _keep_password is set, merge with existing credentials to preserve password
          if (body.credentials._keep_password) {
            delete body.credentials._keep_password;
            const existing = db.prepare('SELECT credentials FROM email_accounts WHERE id = ?').get(route.id);
            if (existing && existing.credentials) {
              try {
                const old = JSON.parse(existing.credentials);
                if (old.password) body.credentials.password = old.password;
              } catch {}
            }
          }
          sets.push('credentials = ?'); vals.push(JSON.stringify(body.credentials));
        }
        if (sets.length === 0) { sendJson(res, 400, { error: 'Nothing to update' }); break; }
        sets.push("updated_at = datetime('now')");
        vals.push(route.id);
        db.prepare(`UPDATE email_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        if (body.enabled !== undefined && _rescheduleEmailPoll) {
          const interval = parseInt(settings.get('email_poll_interval') || '30', 10);
          _rescheduleEmailPoll(interval);
        }
        sendJson(res, 200, { ok: true });
        break;
      }

      case 'emailAccountsDelete': {
        db.prepare('DELETE FROM email_accounts WHERE id = ?').run(route.id);
        sendJson(res, 200, { ok: true });
        break;
      }

      case 'emailAccountsTest': {
        const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(route.id);
        if (!account) { sendJson(res, 404, { error: 'Account not found' }); break; }
        if (account.type === 'gmail') {
          let creds;
          try { creds = account.credentials ? JSON.parse(account.credentials) : null; } catch {}
          const ok = !!(creds && creds.access_token);
          sendJson(res, 200, { ok, message: ok ? 'Gmail OAuth подключён' : 'Gmail не авторизован — пройди OAuth для этого ящика' });
          break;
        }
        // IMAP test
        let creds;
        try { creds = JSON.parse(account.credentials); } catch { sendJson(res, 200, { ok: false, message: 'Не заданы учётные данные (host, user, password)' }); break; }
        if (!creds || !creds.host || !creds.user || !creds.password) { sendJson(res, 200, { ok: false, message: 'Неполные учётные данные — нужны host, user, password' }); break; }
        try {
          const Imap = require('imap');
          const result = await new Promise((resolve, reject) => {
            const conn = new Imap({ user: creds.user, password: creds.password, host: creds.host, port: creds.port || 993, tls: creds.tls !== false, tlsOptions: { rejectUnauthorized: false }, connTimeout: 10000, authTimeout: 8000 });
            conn.once('ready', () => { conn.end(); resolve({ ok: true, message: `IMAP подключён к ${creds.host}` }); });
            conn.once('error', (err) => { resolve({ ok: false, message: `Ошибка: ${err.message}` }); });
            conn.connect();
          });
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 200, { ok: false, message: `Ошибка: ${err.message}` });
        }
        break;
      }

      case 'emailAccountAuthUrl': {
        const account = db.prepare('SELECT id, email, type FROM email_accounts WHERE id = ?').get(route.id);
        if (!account) { sendJson(res, 404, { error: 'Account not found' }); break; }
        if (account.type !== 'gmail') { sendJson(res, 400, { error: 'Only Gmail accounts support OAuth' }); break; }
        try {
          const url = google.getAuthUrl();
          sendJson(res, 200, { url, email: account.email });
        } catch (err) {
          sendJson(res, 503, { error: 'Google credentials not configured' });
        }
        break;
      }

      case 'emailAccountAuthCode': {
        const account = db.prepare('SELECT id, email, type FROM email_accounts WHERE id = ?').get(route.id);
        if (!account) { sendJson(res, 404, { error: 'Account not found' }); break; }
        if (account.type !== 'gmail') { sendJson(res, 400, { error: 'Only Gmail accounts support OAuth' }); break; }
        const body = await readBody(req);
        if (!body.code) { sendJson(res, 400, { error: 'code is required' }); break; }
        try {
          const tokens = await google.saveTokenForAccount(body.code);
          db.prepare("UPDATE email_accounts SET credentials = ?, bootstrapped = 0, updated_at = datetime('now') WHERE id = ?")
            .run(JSON.stringify(tokens), route.id);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 200, { ok: false, error: err.message });
        }
        break;
      }

      case 'googleAuthUrl': {
        try {
          const authUrl = google.getAuthUrl();
          sendJson(res, 200, { url: authUrl, authorized: google.isAuthorized() });
        } catch (err) {
          sendJson(res, 503, { error: 'Google credentials not configured' });
        }
        break;
      }

      case 'googleAuthCode': {
        const body = await readBody(req);
        if (!body.code) { sendJson(res, 400, { error: 'code is required' }); break; }
        try {
          await google.saveToken(body.code);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 200, { ok: false, error: err.message });
        }
        break;
      }

      case 'systemStatus': {
        const { exec } = require('child_process');
        const sh = (cmd) => new Promise(resolve =>
          exec(cmd, { timeout: 5000 }, (_, stdout, stderr) =>
            resolve((stdout || '').trim() || (stderr || '').trim())
          )
        );
        const [active, since, errCount] = await Promise.all([
          sh('systemctl is-active snezhanna'),
          sh('systemctl show snezhanna --property=ActiveEnterTimestamp --value'),
          sh('journalctl -u snezhanna --since "10 min ago" --no-pager -q 2>/dev/null | grep -ic "error\\|fatal\\|uncaught" || echo 0')
        ]);
        sendJson(res, 200, {
          active: active === 'active',
          since: since || null,
          recentErrors: parseInt(errCount, 10) || 0
        });
        break;
      }

      case 'systemRestart': {
        const { exec } = require('child_process');
        exec('sudo systemctl restart snezhanna', { timeout: 10000 }, (err) => {
          sendJson(res, 200, { ok: !err, error: err ? err.message : null });
        });
        break;
      }

      case 'systemStart': {
        const { exec } = require('child_process');
        exec('sudo systemctl start snezhanna', { timeout: 10000 }, (err) => {
          sendJson(res, 200, { ok: !err, error: err ? err.message : null });
        });
        break;
      }

      case 'systemUpdate': {
        const { exec } = require('child_process');
        exec('nohup bash /opt/snezhanna/scripts/update.sh > /tmp/snezhanna-update.log 2>&1 &', { timeout: 5000 }, (err) => {
          sendJson(res, 200, { ok: !err, started: true });
        });
        break;
      }
    }
  } catch (e) {
    console.error('[API] Handler error:', e.message);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

let server = null;

function start() {
  server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`[API] Server listening on port ${PORT}`);
  });
  server.on('error', (e) => {
    console.error('[API] Server error:', e.message);
  });
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { start, stop, setApiContext };
