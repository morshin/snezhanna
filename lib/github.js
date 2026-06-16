'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const config = require('./config');

const TZ = config.timezone || 'Europe/Madrid';

function milestoneWindowDays() {
  const gh = config.github || {};
  const n = gh.milestone_due_within_days;
  if (typeof n === 'number' && n >= 0) return n;
  return 14;
}

function isConfigured() {
  return !!(process.env.GITHUB_TOKEN && config.github && config.github.repos && config.github.repos.length > 0);
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

function githubGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'snezhanna-bot'
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${body.message || 'unknown error'}`));
          } else {
            resolve(body);
          }
        } catch (e) {
          reject(new Error('GitHub API response parse error: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/** Calendar date YYYY-MM-DD in config timezone */
function dateKeyInTz(isoOrDate, tz) {
  return new Date(isoOrDate).toLocaleDateString('sv-SE', { timeZone: tz });
}

/**
 * Whole-day difference: dueKey minus todayKey (overdue → negative).
 */
function daysFromTodayToDue(dueIso, tz) {
  const dueStr = dateKeyInTz(dueIso, tz);
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
  const dp = dueStr.split('-').map(Number);
  const tp = todayStr.split('-').map(Number);
  const dueUtc = Date.UTC(dp[0], dp[1] - 1, dp[2]);
  const todayUtc = Date.UTC(tp[0], tp[1] - 1, tp[2]);
  return Math.round((dueUtc - todayUtc) / 86400000);
}

function milestoneIsUpcoming(m, withinDays, tz) {
  if (!m.due_on) return false;
  const d = daysFromTodayToDue(m.due_on, tz);
  return d <= withinDays;
}

// ── Milestones (open, due date within window or overdue) ───────────────────

async function getRepoMilestones(repoEntry) {
  const repo = typeof repoEntry === 'string' ? repoEntry : repoEntry.repo;
  const project = typeof repoEntry === 'object' ? repoEntry.project : null;
  const within = milestoneWindowDays();

  try {
    const items = await githubGet(
      `/repos/${repo}/milestones?state=open&per_page=50&sort=due_on&direction=asc`
    );
    const tz = TZ;
    return items
      .filter(m => milestoneIsUpcoming(m, within, tz))
      .map(m => {
        const daysUntilDue = daysFromTodayToDue(m.due_on, tz);
        return {
          number: m.number,
          title: m.title,
          repo,
          project: project || null,
          url: m.html_url,
          due_on: m.due_on,
          due_date: dateKeyInTz(m.due_on, tz),
          days_until_due: daysUntilDue,
          open_issues_count: m.open_issues_count,
          closed_issues_count: m.closed_issues_count,
          description: m.description || null,
          updated_at: m.updated_at || null
        };
      });
  } catch (e) {
    console.error(`[GitHub] Failed to fetch milestones for ${repo}:`, e.message);
    return [];
  }
}

/**
 * Open milestones that have a due date and are either overdue or due within
 * `github.milestone_due_within_days` (default 14) in `config.timezone`.
 */
async function getUpcomingMilestones(filterProject) {
  if (!isConfigured()) return [];

  const repos = config.github.repos;
  const results = await Promise.all(repos.map(r => getRepoMilestones(r)));
  const flat = results.flat();

  if (filterProject) {
    return flat.filter(m => m.project === filterProject);
  }
  return flat;
}

module.exports = {
  isConfigured,
  getUpcomingMilestones,
  milestoneWindowDays
};
