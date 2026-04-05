'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');
const tasksMerge = require('./tasks-merge');
const google = require('./google');
const github = require('./github');

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

module.exports = { start, stop };
