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

module.exports = {
  isAuthorized,
  getAuthUrl,
  saveToken,
  getCalendarEvents,
  getUpcomingEvents,
  getGmailMessages,
  createDraft
};
