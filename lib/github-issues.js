'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));

const REPO = (config.github && config.github.self_repo) || 'morshin/snezhanna';

// GITHUB_ISSUES_TOKEN — dedicated token with Issues+Contents write access to self_repo.
// Pre-configured by the developer so tenants on other instances can report issues
// without needing their own access to morshin/snezhanna.
// Falls back to GITHUB_TOKEN on the developer's own instance.
function getToken() {
  return process.env.GITHUB_ISSUES_TOKEN || process.env.GITHUB_TOKEN;
}

function isConfigured() {
  return !!getToken();
}

function githubRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'snezhanna-bot',
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${data.message || 'unknown'}`));
          } else {
            resolve(data);
          }
        } catch (e) {
          reject(new Error('GitHub API parse error: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function uploadScreenshot(base64, mimeType) {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${timestamp}.${ext}`;
  const filePath = `_screenshots/${filename}`;

  await githubRequest('PUT', `/repos/${REPO}/contents/${filePath}`, {
    message: `chore: add issue screenshot ${filename}`,
    content: base64
  });

  return `https://raw.githubusercontent.com/${REPO}/master/${filePath}`;
}

/**
 * Create a GitHub issue in the bot's own repository.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string[]} [opts.labels]
 * @param {string}  [opts.imageBase64]  - base64 image from Telegram
 * @param {string}  [opts.imageMimeType]
 */
async function createIssue({ title, body, labels, imageBase64, imageMimeType }) {
  if (!isConfigured()) return { error: 'GITHUB_TOKEN not configured' };

  const instanceName = require('path').basename(require('path').join(__dirname, '..'));
  let issueBody = (body || '') + `\n\n---\n_Отправлено через Снежанну (инстанс: ${instanceName})_`;

  if (imageBase64 && imageMimeType) {
    try {
      const imageUrl = await uploadScreenshot(imageBase64, imageMimeType);
      issueBody += `\n\n## Скриншот\n\n![screenshot](${imageUrl})`;
      console.log('[GithubIssues] Screenshot uploaded:', imageUrl);
    } catch (e) {
      console.error('[GithubIssues] Screenshot upload failed:', e.message);
      issueBody += `\n\n_Скриншот не удалось загрузить: ${e.message}_`;
    }
  }

  const result = await githubRequest('POST', `/repos/${REPO}/issues`, {
    title,
    body: issueBody,
    ...(labels && labels.length ? { labels } : {})
  });

  return {
    issue_number: result.number,
    url: result.html_url,
    title: result.title
  };
}

module.exports = { createIssue, isConfigured };
