'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));

const REPO = (config.github && config.github.self_repo) || 'morshin/snezhanna';
const INSTANCE_NAME = path.basename(path.join(__dirname, '..'));

// ── GitHub App auth ──────────────────────────────────────────────────────────

let _cachedToken = null;
let _tokenExpiry = 0;

function readPrivateKey() {
  // Support key stored as a file path or inline (with literal \n)
  const keyFile = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (keyFile) return fs.readFileSync(keyFile, 'utf8');
  return (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

function isAppConfigured() {
  return !!(process.env.GITHUB_APP_ID && (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_FILE));
}

function isConfigured() {
  return isAppConfigured() || !!(process.env.GITHUB_ISSUES_TOKEN || process.env.GITHUB_TOKEN);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJWT() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = readPrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: String(appId) })));
  const data = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  return `${data}.${base64url(signer.sign(privateKey))}`;
}

async function getInstallationToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 5 * 60 * 1000) return _cachedToken;

  const jwt = makeJWT();

  // Resolve installation ID for this specific repo
  const installation = await githubApiRequest('GET', `/repos/${REPO}/installation`, null, jwt);
  const tokenData    = await githubApiRequest('POST', `/app/installations/${installation.id}/access_tokens`, {}, jwt);

  _cachedToken = tokenData.token;
  _tokenExpiry = new Date(tokenData.expires_at).getTime();
  console.log('[GithubIssues] Installation token refreshed, expires:', tokenData.expires_at);
  return _cachedToken;
}

async function getBearerToken() {
  if (isAppConfigured()) return await getInstallationToken();
  return process.env.GITHUB_ISSUES_TOKEN || process.env.GITHUB_TOKEN;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

function githubApiRequest(method, endpoint, body, bearerOverride) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;

    const doRequest = (token) => {
      const options = {
        hostname: 'api.github.com',
        path: endpoint,
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
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
            if (res.statusCode >= 400) reject(new Error(`GitHub API ${res.statusCode}: ${data.message || 'unknown'}`));
            else resolve(data);
          } catch (e) { reject(new Error('GitHub API parse error: ' + e.message)); }
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    };

    if (bearerOverride) {
      doRequest(bearerOverride);
    } else {
      getBearerToken().then(doRequest).catch(reject);
    }
  });
}

// ── Screenshot upload ────────────────────────────────────────────────────────

async function uploadScreenshot(base64, mimeType) {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${timestamp}.${ext}`;
  const filePath = `_screenshots/${filename}`;

  await githubApiRequest('PUT', `/repos/${REPO}/contents/${filePath}`, {
    message: `chore: add issue screenshot ${filename}`,
    content: base64
  });

  return `https://raw.githubusercontent.com/${REPO}/master/${filePath}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a GitHub issue in the bot's own repository.
 * Authenticates via GitHub App (preferred) or GITHUB_ISSUES_TOKEN / GITHUB_TOKEN fallback.
 */
async function createIssue({ title, body, labels, imageBase64, imageMimeType }) {
  if (!isConfigured()) return { error: 'GitHub App or token not configured' };

  let issueBody = (body || '') + `\n\n---\n_Отправлено через Снежанну (инстанс: ${INSTANCE_NAME})_`;

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

  const result = await githubApiRequest('POST', `/repos/${REPO}/issues`, {
    title,
    body: issueBody,
    ...(labels && labels.length ? { labels } : {})
  });

  return { issue_number: result.number, url: result.html_url, title: result.title };
}

module.exports = { createIssue, isConfigured };
