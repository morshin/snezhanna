'use strict';

/**
 * IMAP/SMTP adapter.
 * credentials: { host, port, tls, user, password, smtp_host?, smtp_port? }
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const NO_REPLY_DOMAINS = ['noreply', 'no-reply', 'newsletter', 'notifications', 'mailer-daemon', 'donotreply'];

function needsReply(from, subject) {
  const fromLower = (from || '').toLowerCase();
  if (NO_REPLY_DOMAINS.some(d => fromLower.includes(d))) return false;
  if ((subject || '').includes('?')) return true;
  return false;
}

// TLS cert verification is on by default; per-account `allow_invalid_tls: true`
// opts out for servers with a genuinely self-signed/invalid cert (rare, e.g.
// home NAS). `servername` (SNI) must be set explicitly — the `imap` package
// doesn't set it itself, and without it Node's TLS layer fails to verify even
// a perfectly valid cert (reproduced against imap.gmail.com: fails as "self-signed
// certificate" without servername, verifies fine with it).
function imapConfig(credentials) {
  return {
    user: credentials.user,
    password: credentials.password,
    host: credentials.host,
    port: credentials.port || 993,
    tls: credentials.tls !== false,
    tlsOptions: { rejectUnauthorized: credentials.allow_invalid_tls !== true, servername: credentials.host },
    connTimeout: 10000,
    authTimeout: 8000
  };
}

function smtpConfig(credentials) {
  const smtpHost = credentials.smtp_host ||
    (credentials.host.includes('outlook') ? 'smtp.office365.com' :
     credentials.host.replace(/^imap\./, 'smtp.'));
  const smtpPort = credentials.smtp_port || 587;
  return {
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: credentials.user, pass: credentials.password },
    tls: { rejectUnauthorized: credentials.allow_invalid_tls !== true, servername: smtpHost }
  };
}

function openInbox(imap) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) reject(err); else resolve(box);
    });
  });
}

function fetchMessages(imap, uids, markSeen = false) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const f = imap.fetch(uids, { bodies: '', markSeen });
    f.on('message', (msg) => {
      const buffers = [];
      let uid = null;
      msg.on('attributes', (attrs) => { uid = attrs.uid; });
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => buffers.push(chunk));
      });
      msg.once('end', () => {
        messages.push({ uid, buffer: Buffer.concat(buffers) });
      });
    });
    f.once('error', reject);
    f.once('end', () => resolve(messages));
  });
}

async function searchUnread(imap, maxResults) {
  return new Promise((resolve, reject) => {
    imap.search(['UNSEEN'], (err, uids) => {
      if (err) reject(err);
      else resolve((uids || []).slice(-maxResults));
    });
  });
}

async function getMessages(credentials, maxResults = 20, unreadOnly = true) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfig(credentials));

    imap.once('error', (err) => {
      console.error('[IMAP] Connection error:', err.message);
      reject(err);
    });

    imap.once('ready', async () => {
      try {
        await openInbox(imap);
        const uids = await searchUnread(imap, maxResults);
        if (uids.length === 0) { imap.end(); resolve([]); return; }

        const raw = await fetchMessages(imap, uids, false);
        const results = [];
        for (const { uid, buffer } of raw) {
          try {
            const parsed = await simpleParser(buffer);
            const from = parsed.from?.text || '';
            const subject = parsed.subject || '';
            results.push({
              id: String(uid),
              from,
              to: parsed.to?.text || '',
              subject,
              date: (parsed.date || new Date()).toISOString(),
              body: (parsed.text || '').slice(0, 8000),
              unread: true,
              attachments: (parsed.attachments || []).map(a => ({
                filename: a.filename || 'unnamed',
                mimeType: a.contentType,
                size: a.size || 0
              })),
              needsReply: needsReply(from, subject)
            });
          } catch (e) {
            console.error('[IMAP] Parse error for uid', uid, e.message);
          }
        }
        imap.end();
        resolve(results);
      } catch (e) {
        imap.end();
        reject(e);
      }
    });

    imap.connect();
  });
}

async function getMessage(credentials, uid) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfig(credentials));

    imap.once('error', reject);
    imap.once('ready', async () => {
      try {
        await openInbox(imap);
        const raw = await fetchMessages(imap, [Number(uid)], true);
        if (raw.length === 0) { imap.end(); reject(new Error('Message not found')); return; }
        const parsed = await simpleParser(raw[0].buffer);
        const from = parsed.from?.text || '';
        const subject = parsed.subject || '';
        imap.end();
        resolve({
          id: String(uid),
          from,
          to: parsed.to?.text || '',
          subject,
          date: (parsed.date || new Date()).toISOString(),
          body: (parsed.text || '').slice(0, 8000),
          unread: false,
          attachments: (parsed.attachments || []).map(a => ({
            filename: a.filename || 'unnamed',
            mimeType: a.contentType,
            size: a.size || 0
          })),
          needsReply: needsReply(from, subject)
        });
      } catch (e) {
        imap.end();
        reject(e);
      }
    });

    imap.connect();
  });
}

async function createDraft(credentials, to, subject, body, inReplyToId) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfig(credentials));

    imap.once('error', reject);
    imap.once('ready', () => {
      let headers = `To: ${to}\r\nSubject: ${subject}\r\nFrom: ${credentials.user}\r\n`;
      if (inReplyToId) headers += `In-Reply-To: ${inReplyToId}\r\nReferences: ${inReplyToId}\r\n`;
      const raw = headers + '\r\n' + body;
      const buf = Buffer.from(raw);

      imap.append(buf, { mailbox: 'Drafts', flags: ['\\Draft'] }, (err) => {
        imap.end();
        if (err) reject(err);
        else resolve({ draftCreated: true });
      });
    });

    imap.connect();
  });
}

async function sendMessage(credentials, to, subject, body, inReplyToId) {
  const transport = nodemailer.createTransport(smtpConfig(credentials));
  const mailOptions = {
    from: credentials.user,
    to,
    subject,
    text: body
  };
  if (inReplyToId) {
    mailOptions.inReplyTo = inReplyToId;
    mailOptions.references = inReplyToId;
  }
  const info = await transport.sendMail(mailOptions);
  return { messageId: info.messageId };
}

async function markAsRead(credentials, uid) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfig(credentials));

    imap.once('error', reject);
    imap.once('ready', async () => {
      try {
        await openInbox(imap);
        imap.addFlags(Number(uid), ['\\Seen'], (err) => {
          imap.end();
          if (err) reject(err);
          else resolve({ markedAsRead: true, uid });
        });
      } catch (e) {
        imap.end();
        reject(e);
      }
    });

    imap.connect();
  });
}

module.exports = { getMessages, getMessage, createDraft, sendMessage, markAsRead, needsReply };
