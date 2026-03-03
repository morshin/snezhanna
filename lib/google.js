'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_FILE = path.join(__dirname, '../credentials.json');
const TOKEN_FILE = path.join(__dirname, '../token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify'
];

function getAuth() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const creds = raw.installed || raw.web;
  const auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris[0]
  );
  if (fs.existsSync(TOKEN_FILE)) {
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  }
  return auth;
}

function isAuthorized() {
  return fs.existsSync(TOKEN_FILE);
}

function getAuthUrl() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const creds = raw.installed || raw.web;
  const auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris[0]
  );
  return auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
}

async function saveToken(code) {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const creds = raw.installed || raw.web;
  const auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris[0]
  );
  const { tokens } = await auth.getToken(code);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  return tokens;
}

async function getCalendarEvents(daysAhead = 1) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + daysAhead);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });
  return res.data.items || [];
}

async function getUpcomingEvents(minutesAhead) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const future = new Date(now.getTime() + minutesAhead * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });
  return res.data.items || [];
}

async function getGmailMessages(maxResults = 20) {
  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    labelIds: ['INBOX']
  });
  const messages = listRes.data.messages || [];

  const results = [];
  for (const msg of messages.slice(0, 10)) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date']
    });
    const headers = detail.data.payload.headers;
    const get = (name) => (headers.find(h => h.name === name) || {}).value || '';
    results.push({
      id: msg.id,
      from: get('From'),
      subject: get('Subject'),
      date: get('Date'),
      unread: (detail.data.labelIds || []).includes('UNREAD')
    });
  }
  return results;
}

async function createDraft(to, subject, body) {
  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`
  ).toString('base64url');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } }
  });
  return res.data;
}

// ── Calendar write operations ────────────────────────────────────────────────

async function createEvent(summary, startTime, endTime, description, location) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const event = {
    summary,
    start: { dateTime: startTime, timeZone: 'Europe/Madrid' },
    end: { dateTime: endTime, timeZone: 'Europe/Madrid' }
  };
  if (description) event.description = description;
  if (location) event.location = location;

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event
  });
  return res.data;
}

async function updateEvent(eventId, updates) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const patch = {};
  if (updates.summary) patch.summary = updates.summary;
  if (updates.startTime) patch.start = { dateTime: updates.startTime, timeZone: 'Europe/Madrid' };
  if (updates.endTime) patch.end = { dateTime: updates.endTime, timeZone: 'Europe/Madrid' };
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.location !== undefined) patch.location = updates.location;

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    requestBody: patch
  });
  return res.data;
}

async function deleteEvent(eventId) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.delete({
    calendarId: 'primary',
    eventId
  });
  return { deleted: true, eventId };
}

// ── Gmail: full message + mark read ─────────────────────────────────────────

function extractBody(payload) {
  if (!payload) return '';

  // Single-part message
  if (payload.body && payload.body.data) {
    const text = Buffer.from(payload.body.data, 'base64').toString('utf8');
    return text.slice(0, 8000);
  }

  // Multipart: prefer text/plain, fall back to text/html
  if (payload.parts) {
    let plainText = '';
    let htmlText = '';

    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        plainText = Buffer.from(part.body.data, 'base64').toString('utf8');
      } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
        htmlText = Buffer.from(part.body.data, 'base64').toString('utf8');
      } else if (part.parts) {
        // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
        const nested = extractBody(part);
        if (nested) plainText = plainText || nested;
      }
    }

    if (plainText) return plainText.slice(0, 8000);
    if (htmlText) {
      // Strip HTML tags for readable text
      const stripped = htmlText
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      return stripped.slice(0, 8000);
    }
  }

  return '';
}

async function getMessageById(messageId) {
  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const detail = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });

  const headers = detail.data.payload.headers;
  const get = (name) => (headers.find(h => h.name === name) || {}).value || '';
  const body = extractBody(detail.data.payload);

  return {
    id: messageId,
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
    body,
    unread: (detail.data.labelIds || []).includes('UNREAD')
  };
}

async function markAsRead(messageId) {
  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD']
    }
  });
  return { markedAsRead: true, messageId };
}

module.exports = {
  isAuthorized,
  getAuthUrl,
  saveToken,
  getCalendarEvents,
  getUpcomingEvents,
  getGmailMessages,
  createDraft,
  createEvent,
  updateEvent,
  deleteEvent,
  getMessageById,
  markAsRead
};
