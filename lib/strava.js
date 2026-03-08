'use strict';

const fs = require('fs');
const path = require('path');
const diskLog = require('./disk-log');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const AGENT_MOUNT = config.yadisk.agent_mount;
const WEEKLY_DIR = path.join(AGENT_MOUNT, 'fitness', 'weekly');

// ── Token cache ──────────────────────────────────────────────────────────────

let _cachedToken = null;
let _tokenExpiresAt = 0;

function isConfigured() {
  return !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET && process.env.STRAVA_REFRESH_TOKEN);
}

async function getAccessToken() {
  if (_cachedToken && Date.now() / 1000 < _tokenExpiresAt - 300) {
    return _cachedToken;
  }

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiresAt = data.expires_at;
  console.log('[Strava] Token refreshed, expires at', new Date(_tokenExpiresAt * 1000).toISOString());
  return _cachedToken;
}

// ── API ──────────────────────────────────────────────────────────────────────

async function getActivities(from, to) {
  const token = await getAccessToken();
  const url = `https://www.strava.com/api/v3/athlete/activities?after=${from}&before=${to}&per_page=100`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava API error (${res.status}): ${text}`);
  }

  return await res.json();
}

// ── Calculations ─────────────────────────────────────────────────────────────

function calcWeekTotals(activities) {
  const bySport = {};
  let totalDistance = 0;
  let totalTime = 0;
  let totalElevation = 0;

  for (const a of activities) {
    totalDistance += a.distance || 0;
    totalTime += a.moving_time || 0;
    totalElevation += a.total_elevation_gain || 0;

    const sport = a.type || 'Other';
    if (!bySport[sport]) {
      bySport[sport] = { count: 0, distance_m: 0 };
    }
    bySport[sport].count++;
    bySport[sport].distance_m += a.distance || 0;
  }

  return {
    activities_count: activities.length,
    distance_m: Math.round(totalDistance),
    moving_time_s: Math.round(totalTime),
    elevation_gain_m: Math.round(totalElevation),
    by_sport: bySport
  };
}

// ── ISO week helpers ─────────────────────────────────────────────────────────

function getISOWeekString(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Thursday in current week decides the year
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 4);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getWeekBounds(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Monday
  const day = d.getDay();
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  // Sunday
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { from: monday, to: sunday };
}

function getPrevWeekString(weekStr) {
  // Parse YYYY-Www and go back 7 days from the Monday of that week
  const match = weekStr.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);
  // Find the Monday of that ISO week
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const mondayW1 = new Date(jan4);
  mondayW1.setDate(jan4.getDate() - dayOfWeek + 1);
  const targetMonday = new Date(mondayW1);
  targetMonday.setDate(mondayW1.getDate() + (week - 1) * 7);
  // Go back 7 days
  const prevMonday = new Date(targetMonday);
  prevMonday.setDate(targetMonday.getDate() - 7);
  return getISOWeekString(prevMonday);
}

// ── File I/O ─────────────────────────────────────────────────────────────────

function saveWeekData(weekStr, period, activities, totals) {
  const data = {
    week: weekStr,
    period,
    fetched_at: new Date().toISOString(),
    activities: activities.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      start_date_local: a.start_date_local,
      distance: a.distance,
      moving_time: a.moving_time,
      elapsed_time: a.elapsed_time,
      total_elevation_gain: a.total_elevation_gain,
      average_heartrate: a.average_heartrate,
      max_heartrate: a.max_heartrate,
      suffer_score: a.suffer_score,
      average_speed: a.average_speed,
      average_cadence: a.average_cadence
    })),
    totals
  };

  const jsonPath = path.join(WEEKLY_DIR, `${weekStr}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

  // Generate human-readable summary
  const summary = generateSummary(weekStr, period, activities, totals);
  const mdPath = path.join(WEEKLY_DIR, `${weekStr}-summary.md`);
  fs.writeFileSync(mdPath, summary, 'utf8');

  diskLog.log('Strava sync', `${weekStr} — ${activities.length} activities`);
  console.log(`[Strava] Saved ${weekStr}: ${activities.length} activities`);
}

function generateSummary(weekStr, period, activities, totals) {
  const distKm = (totals.distance_m / 1000).toFixed(1);
  const hours = Math.floor(totals.moving_time_s / 3600);
  const mins = Math.round((totals.moving_time_s % 3600) / 60);

  let md = `# ${weekStr} (${period.from} — ${period.to})\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Activities | ${totals.activities_count} |\n`;
  md += `| Distance | ${distKm} km |\n`;
  md += `| Time | ${hours}h ${mins}m |\n`;
  md += `| Elevation | ${totals.elevation_gain_m} m |\n\n`;

  if (Object.keys(totals.by_sport).length > 0) {
    md += `## By Sport\n\n`;
    for (const [sport, data] of Object.entries(totals.by_sport)) {
      md += `- **${sport}**: ${data.count}x, ${(data.distance_m / 1000).toFixed(1)} km\n`;
    }
    md += '\n';
  }

  if (activities.length > 0) {
    md += `## Activities\n\n`;
    for (const a of activities) {
      const d = (a.distance / 1000).toFixed(1);
      const t = `${Math.floor(a.moving_time / 60)}min`;
      const hr = a.average_heartrate ? ` · HR ${Math.round(a.average_heartrate)}` : '';
      md += `- **${a.name}** (${a.type}) — ${d} km, ${t}${hr}\n`;
    }
  }

  return md;
}

function loadWeekData(weekStr) {
  const jsonPath = path.join(WEEKLY_DIR, `${weekStr}.json`);
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    console.error(`[Strava] Failed to read ${jsonPath}:`, err.message);
    return null;
  }
}

// ── Main sync function ───────────────────────────────────────────────────────

async function syncCurrentWeek() {
  if (!isConfigured()) {
    console.log('[Strava] Not configured (missing env vars), skipping sync');
    return null;
  }

  const now = new Date();
  const weekStr = getISOWeekString(now);
  const { from, to } = getWeekBounds(now);

  const period = {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  };

  console.log(`[Strava] Syncing ${weekStr} (${period.from} — ${period.to})`);

  const fromEpoch = Math.floor(from.getTime() / 1000);
  const toEpoch = Math.floor(to.getTime() / 1000);

  const activities = await getActivities(fromEpoch, toEpoch);
  const totals = calcWeekTotals(activities);
  saveWeekData(weekStr, period, activities, totals);

  return { weekStr, activities, totals };
}

// ── Fitness block for Sunday digest ──────────────────────────────────────────

function buildDigestFitnessBlock() {
  const now = new Date();
  const currentWeek = getISOWeekString(now);
  const prevWeek = getPrevWeekString(currentWeek);

  const currentData = loadWeekData(currentWeek);
  if (!currentData) {
    return null;
  }

  const activitiesSummary = currentData.activities
    .map(a => `${a.name} (${a.type}, ${(a.distance / 1000).toFixed(1)} km)`)
    .join('; ');

  let prevBlock = 'Данных за предыдущую неделю нет.';
  const prevData = prevWeek ? loadWeekData(prevWeek) : null;
  if (prevData) {
    prevBlock = `Предыдущая неделя (${prevWeek}):\n${JSON.stringify(prevData.totals, null, 2)}`;
  }

  return `Проанализируй фитнес Вовы за неделю.

Текущая неделя (${currentWeek}):
${JSON.stringify(currentData.totals, null, 2)}
Тренировки: ${activitiesSummary}

${prevBlock}

Дай:
1. Объём и количество тренировок vs предыдущая неделя — в % и абсолютных цифрах
2. Изменения по видам спорта
3. Твоё честное мнение: продуктивная была неделя, есть ли красные флаги (очень мало тренировок, резкий скачок нагрузки, или стабильная работа)
4. Одну конкретную рекомендацию на следующую неделю

Будь прямой, говори как тренер. 3-5 предложений, без воды.
Отвечай на русском как всегда.`;
}

module.exports = {
  isConfigured,
  getAccessToken,
  getActivities,
  calcWeekTotals,
  saveWeekData,
  loadWeekData,
  getISOWeekString,
  getWeekBounds,
  getPrevWeekString,
  syncCurrentWeek,
  buildDigestFitnessBlock
};
