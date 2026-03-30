'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));

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

// ── Issue fetching ───────────────────────────────────────────────────────────

async function getRepoIssues(repoEntry) {
  const repo = typeof repoEntry === 'string' ? repoEntry : repoEntry.repo;
  const project = typeof repoEntry === 'object' ? repoEntry.project : null;

  try {
    const items = await githubGet(`/repos/${repo}/issues?state=open&per_page=50&sort=updated`);
    // Filter out pull requests (GitHub returns PRs in /issues endpoint)
    return items
      .filter(i => !i.pull_request)
      .map(i => ({
        id: i.number,
        title: i.title,
        repo,
        project: project || null,
        url: i.html_url,
        labels: (i.labels || []).map(l => l.name),
        created_at: i.created_at,
        updated_at: i.updated_at,
        assignee: i.assignee ? i.assignee.login : null
      }));
  } catch (e) {
    console.error(`[GitHub] Failed to fetch issues for ${repo}:`, e.message);
    return [];
  }
}

async function getAllOpenIssues(filterProject) {
  if (!isConfigured()) return [];

  const repos = config.github.repos;
  const results = await Promise.all(repos.map(r => getRepoIssues(r)));
  const flat = results.flat();

  if (filterProject) {
    return flat.filter(i => i.project === filterProject);
  }
  return flat;
}

module.exports = { isConfigured, getAllOpenIssues };
