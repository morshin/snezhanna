'use strict';

/**
 * Gmail adapter — credentials-based (no file I/O).
 * Accepts a credentials object from email_accounts.credentials (parsed JSON).
 * Returns messages in unified format (see lib/mail-manager.js).
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDENTIALS_FILE = path.join(__dirname, '../credentials.json');

function buildAuth(credentials) {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const creds = raw.installed || raw.web;
  const auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris[0]
  );
  auth.setCredentials(credentials);
  return auth;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractBody(payload) {
  if (!payload) return '';
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8').slice(0, 8000);
  }
  if (payload.parts) {
    let plain = '';
    let html = '';
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        plain = Buffer.from(part.body.data, 'base64').toString('utf8');
      } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
        html = Buffer.from(part.body.data, 'base64').toString('utf8');
      } else if (part.parts) {
        const nested = extractBody(part);
        if (nested) plain = plain || nested;
      }
    }
    if (plain) return plain.slice(0, 8000);
    if (html) {
      return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/\s+/g, ' ')
        .trim().slice(0, 8000);
    }
  }
  return '';
}

const NO_REPLY_DOMAINS = ['noreply', 'no-reply', 'newsletter', 'notifications', 'mailer-daemon', 'donotreply'];

function needsReply(from, subject) {
  const fromLower = (from || '').toLowerCase();
  if (NO_REPLY_DOMAINS.some(d => fromLower.includes(d))) return false;
  if ((subject || '').includes('?')) return true;
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getMessages(credentials, maxResults = 20, unreadOnly = true) {
  const auth = buildAuth(credentials);
  const gmail = google.gmail({ version: 'v1', auth });

  const labelIds = unreadOnly ? ['INBOX', 'UNREAD'] : ['INBOX'];
  const listRes = await gmail.users.messages.list({ userId: 'me', maxResults, labelIds });
  const msgs = listRes.data.messages || [];

  const results = [];
  for (const msg of msgs.slice(0, 20)) {
    const detail = await gmail.users.messages.get({
      userId: 'me', id: msg.id, format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID']
    });
    const headers = detail.data.payload.headers;
    const get = (n) => (headers.find(h => h.name === n) || {}).value || '';
    const from = get('From');
    const subject = get('Subject');
    results.push({
      id: msg.id,
      from,
      to: get('To'),
      subject,
      date: get('Date'),
      body: '',
      unread: (detail.data.labelIds || []).includes('UNREAD'),
      attachments: [],
      needsReply: needsReply(from, subject)
    });
  }
  return results;
}

async function getMessage(credentials, messageId) {
  const auth = buildAuth(credentials);
  const gmail = google.gmail({ version: 'v1', auth });

  const detail = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = detail.data.payload.headers;
  const get = (n) => (headers.find(h => h.name === n) || {}).value || '';
  const body = extractBody(detail.data.payload);

  const attachments = [];
  function collectAttachments(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.body && part.body.attachmentId) {
        attachments.push({ id: part.body.attachmentId, filename: part.filename || 'unnamed', mimeType: part.mimeType, size: part.body.size || 0 });
      }
      if (part.parts) collectAttachments(part.parts);
    }
  }
  collectAttachments(detail.data.payload.parts);

  const wasUnread = (detail.data.labelIds || []).includes('UNREAD');
  if (wasUnread) {
    await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { removeLabelIds: ['UNREAD'] } });
  }

  const from = get('From');
  const subject = get('Subject');
  return {
    id: messageId,
    from,
    to: get('To'),
    subject,
    date: get('Date'),
    body,
    unread: wasUnread,
    attachments,
    needsReply: needsReply(from, subject)
  };
}

async function createDraft(credentials, to, subject, body, inReplyToId) {
  const auth = buildAuth(credentials);
  const gmail = google.gmail({ version: 'v1', auth });

  let headers = `To: ${to}\r\nSubject: ${subject}\r\n`;
  if (inReplyToId) headers += `In-Reply-To: ${inReplyToId}\r\nReferences: ${inReplyToId}\r\n`;
  const raw = Buffer.from(headers + '\r\n' + body).toString('base64url');

  const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return { draftId: res.data.id };
}

async function sendMessage(credentials, to, subject, body, inReplyToId) {
  const auth = buildAuth(credentials);
  const gmail = google.gmail({ version: 'v1', auth });

  let headers = `To: ${to}\r\nSubject: ${subject}\r\n`;
  if (inReplyToId) headers += `In-Reply-To: ${inReplyToId}\r\nReferences: ${inReplyToId}\r\n`;
  const raw = Buffer.from(headers + '\r\n' + body).toString('base64url');

  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { messageId: res.data.id, threadId: res.data.threadId };
}

async function markAsRead(credentials, messageId) {
  const auth = buildAuth(credentials);
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { removeLabelIds: ['UNREAD'] } });
  return { markedAsRead: true, messageId };
}

async function getAttachment(credentials, messageId, attachmentId) {
  const auth = buildAuth(credentials);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  return Buffer.from(res.data.data, 'base64');
}

module.exports = { getMessages, getMessage, createDraft, sendMessage, markAsRead, getAttachment };
