'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const settings = require('./settings');

const REPO = 'morshin/snezhanna';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getCurrentVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  return pkg.version;
}

// Returns 1 if a > b, -1 if a < b, 0 if equal
function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function githubGet(endpoint) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    const req = https.get({
      hostname: 'api.github.com',
      path: endpoint,
      headers: {
        'User-Agent': 'snezhanna-bot',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Returns all releases newer than currentVersion, sorted oldest→newest
async function getReleasesSince(currentVersion) {
  const data = await githubGet(`/repos/${REPO}/releases?per_page=20`);
  if (!Array.isArray(data)) return [];
  return data
    .filter(r => r.tag_name && compareSemver(r.tag_name.replace(/^v/, ''), currentVersion) > 0)
    .sort((a, b) => compareSemver(a.tag_name.replace(/^v/, ''), b.tag_name.replace(/^v/, '')));
}

// Returns true if we should notify about this version today
function shouldNotify(version) {
  const notifiedTag = settings.get('update_notified_tag');
  const notifiedDate = settings.get('update_notified_date');
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
  return !(notifiedTag === version && notifiedDate === today);
}

function markNotified(version) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
  settings.set('update_notified_tag', version);
  settings.set('update_notified_date', today);
}

async function summarizeChangelog(releases) {
  const combined = releases
    .map(r => `### ${r.tag}\n${r.body || '_(нет описания)_'}`)
    .join('\n\n');
  if (!combined.trim()) return null;

  const isSingle = releases.length === 1;
  const prompt = isSingle
    ? `Это changelog релиза ${releases[0].tag} бота-ассистента Снежанна. Перескажи кратко (2–4 пункта) что нового и что исправлено — простым человеческим языком, без технических деталей. Без преамбулы, сразу пункты с эмодзи.\n\n${combined.slice(0, 3000)}`
    : `Это changelog нескольких обновлений бота-ассистента Снежанна (от старых к новым). Перескажи кратко (3–6 пунктов) самое важное что появилось и что исправлено — простым человеческим языком, без технических деталей. Без преамбулы, сразу пункты с эмодзи.\n\n${combined.slice(0, 3000)}`;

  try {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: 400,
      system: 'Ты помощник. Отвечай только по-русски.',
      messages: [{ role: 'user', content: prompt }]
    });
    return response.content[0]?.text?.trim() || null;
  } catch (e) {
    console.error('[ReleaseCheck] summarize error:', e.message);
    return null;
  }
}

/**
 * Returns { release, summary } if a new release is available and should be announced today,
 * or null otherwise. Marks the version as notified on success.
 * summary covers all intermediate releases between current and latest.
 */
async function checkForUpdate() {
  try {
    const current = getCurrentVersion();
    const releases = await getReleasesSince(current);
    if (!releases.length) return null;

    // Latest release drives the notification header and dedup logic
    const latest = releases[releases.length - 1];
    if (!shouldNotify(latest.version)) return null;

    const summary = await summarizeChangelog(releases);
    markNotified(latest.version);
    return { release: latest, summary };
  } catch (e) {
    console.error('[ReleaseCheck] checkForUpdate error:', e.message);
    return null;
  }
}

module.exports = { checkForUpdate, getCurrentVersion };
