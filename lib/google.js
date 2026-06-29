'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const gmailAdapter = require('./gmail');

const config = require('./config');

const TOKEN_FILE = process.env.GOOGLE_TOKEN_FILE || path.join(__dirname, '../token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive'
];

function makeOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const miniAppUrl = config.mini_app && config.mini_app.url;
  const redirectUri = (config.google && config.google.redirect_uri)
    || process.env.GOOGLE_REDIRECT_URI
    || (miniAppUrl ? `${miniAppUrl}/auth/google/callback` : 'http://localhost');
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getAuth() {
  const auth = makeOAuth2Client();
  if (fs.existsSync(TOKEN_FILE)) {
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  }
  return auth;
}

function isAuthorized() {
  return fs.existsSync(TOKEN_FILE);
}

function getAuthUrl() {
  return makeOAuth2Client().generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
}

async function saveToken(code) {
  const auth = makeOAuth2Client();
  const { tokens } = await auth.getToken(code);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  return tokens;
}

// Returns token object without writing to file (used by multi-account OAuth)
async function saveTokenForAccount(code) {
  const auth = makeOAuth2Client();
  const { tokens } = await auth.getToken(code);
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

// ── Gmail thin wrappers (delegate to lib/gmail.js with token.json credentials) ─

function getTokenCredentials() {
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('Google not authorized — token.json missing');
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

async function getGmailMessages(maxResults = 20, unreadOnly = true) {
  return gmailAdapter.getMessages(getTokenCredentials(), maxResults, unreadOnly);
}

async function createDraft(to, subject, body) {
  return gmailAdapter.createDraft(getTokenCredentials(), to, subject, body, null);
}

// ── Calendar write operations ────────────────────────────────────────────────

async function createEvent(summary, startTime, endTime, description, location, recurrence) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const event = {
    summary,
    start: { dateTime: startTime, timeZone: 'Europe/Madrid' },
    end: { dateTime: endTime, timeZone: 'Europe/Madrid' }
  };
  if (description) event.description = description;
  if (location) event.location = location;
  if (recurrence) event.recurrence = [recurrence];

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event
  });
  return res.data;
}

async function deleteEventSeries(eventId) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const eventRes = await calendar.events.get({ calendarId: 'primary', eventId });
  const masterEventId = eventRes.data.recurringEventId || eventId;

  await calendar.events.delete({ calendarId: 'primary', eventId: masterEventId });
  return { deleted: true, eventId: masterEventId, deletedSeries: true };
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

async function getMessageById(messageId) {
  return gmailAdapter.getMessage(getTokenCredentials(), messageId);
}

async function markAsRead(messageId) {
  return gmailAdapter.markAsRead(getTokenCredentials(), messageId);
}

async function getAttachment(messageId, attachmentId) {
  return gmailAdapter.getAttachment(getTokenCredentials(), messageId, attachmentId);
}

module.exports = {
  isAuthorized,
  getAuth,
  getAuthUrl,
  saveToken,
  saveTokenForAccount,
  getCalendarEvents,
  getUpcomingEvents,
  getGmailMessages,
  createDraft,
  createEvent,
  updateEvent,
  deleteEvent,
  deleteEventSeries,
  getMessageById,
  getAttachment,
  markAsRead
};
