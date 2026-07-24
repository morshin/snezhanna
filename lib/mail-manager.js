'use strict';

const { db } = require('./db');
const gmail = require('./gmail');
const imap = require('./imap');
const emailCredentials = require('./email-credentials');
const classifier = require('./email-classifier');
const archive = require('./archive');

// ── Adapter dispatch ─────────────────────────────────────────────────────────

function getAdapter(account) {
  return account.type === 'imap' ? imap : gmail;
}

function parseCredentials(account) {
  return emailCredentials.readCredentials(account);
}

// ── Message categorization ────────────────────────────────────────────────────

const NO_REPLY_DOMAINS = ['noreply', 'no-reply', 'newsletter', 'notifications', 'mailer-daemon', 'donotreply'];

function isNoReplyDomain(from) {
  const lower = (from || '').toLowerCase();
  return NO_REPLY_DOMAINS.some(d => lower.includes(d));
}

function categorize(message, account) {
  if (message.needsReply) return 'reply_needed';
  const subj = (message.subject || '').toLowerCase();
  if (/встреч|meeting|call|zoom|calendar|invite/.test(subj)) return 'event';
  if (/задач|task|todo|deadline|срок/.test(subj)) return 'task';
  if (/отчёт|report|update|статус|status/.test(subj)) return 'update';
  if (account.account_type !== 'corporate' && isNoReplyDomain(message.from)) return 'info';
  return 'info';
}

function parseEmailDate(raw) {
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date() : d;
}

function detectSubproject(message) {
  try {
    const projects = db.prepare("SELECT name, display_name FROM projects WHERE status = 'active'").all();
    const text = ((message.subject || '') + ' ' + (message.from || '')).toLowerCase();
    for (const p of projects) {
      const name = (p.display_name || p.name).toLowerCase();
      if (text.includes(name)) return p.display_name || p.name;
    }
  } catch {}
  return null;
}

// ── Seen message tracking ─────────────────────────────────────────────────────

function getSeenIds(accountId) {
  const rows = db.prepare('SELECT message_id FROM email_seen WHERE account_id = ?').all(accountId);
  return new Set(rows.map(r => r.message_id));
}

function markSeen(accountId, messageIds) {
  const insert = db.prepare('INSERT OR IGNORE INTO email_seen (account_id, message_id) VALUES (?, ?)');
  const tx = db.transaction((ids) => {
    for (const id of ids) insert.run(accountId, id);
  });
  tx(messageIds);
}

// ── Digest builder ────────────────────────────────────────────────────────────

function buildEmailDigest(account, messages) {
  if (!messages || messages.length === 0) return null;

  const byCategory = {};
  for (const m of messages) {
    if (!byCategory[m.category]) byCategory[m.category] = [];
    byCategory[m.category].push(m);
  }

  const labels = { task: '📋 Задачи', event: '📅 События', update: '📊 Апдейты', info: 'ℹ️ Инфо' };

  let text = `📬 *${account.label}* — ${messages.length} новых:\n`;
  for (const [cat, msgs] of Object.entries(byCategory)) {
    text += `\n${labels[cat] || cat}:\n`;
    for (const m of msgs.slice(0, 5)) {
      text += `• ${m.subject || '(без темы)'} — _${m.from || '?'}_\n`;
    }
    if (msgs.length > 5) text += `  ...и ещё ${msgs.length - 5}\n`;
  }
  return text;
}

// ── Main poll ────────────────────────────────────────────────────────────────

async function pollAll() {
  const accounts = db.prepare("SELECT * FROM email_accounts WHERE enabled = 1").all();
  const results = [];

  for (const account of accounts) {
    try {
      const credentials = parseCredentials(account);
      if (!credentials) {
        console.warn(`[MailManager] Account ${account.id} (${account.email}): missing/invalid credentials`);
        continue;
      }

      const adapter = getAdapter(account);
      const rawMessages = await adapter.getMessages(credentials, 20, true);

      // Bootstrap: first run — just seed seen IDs, no digest
      if (!account.bootstrapped) {
        const ids = rawMessages.map(m => m.id);
        markSeen(account.id, ids);
        db.prepare('UPDATE email_accounts SET bootstrapped = 1 WHERE id = ?').run(account.id);
        console.log(`[MailManager] Bootstrapped account ${account.email} with ${ids.length} seen IDs`);
        results.push({ account, messages: [] });
        continue;
      }

      const seenIds = getSeenIds(account.id);
      const newMessages = rawMessages.filter(m => !seenIds.has(m.id));

      if (newMessages.length === 0) {
        results.push({ account, messages: [] });
        continue;
      }

      // Categorize: Haiku one-shot for the whole batch, regex fallback on failure
      const verdicts = await classifier.classifyMessages(newMessages);
      const categorized = newMessages.map((m, i) => {
        const result = { ...m, accountId: account.id, accountEmail: account.email };
        if (verdicts) {
          result.category = verdicts[i];
          result.needsReply = verdicts[i] === 'reply_needed';
          result.classified = true;
        } else {
          result.category = categorize(m, account);
        }
        if (account.account_type === 'corporate') {
          const sub = detectSubproject(m);
          if (sub) result.subproject = sub;
        }
        return result;
      });

      // Mark as seen
      markSeen(account.id, newMessages.map(m => m.id));

      // Archive full body for long-term search (lib/archive.js). Gmail's
      // getMessages() only returns metadata (body: '') — fetch the full body
      // with markRead: false, since this is a silent background archive, not
      // the user actually reading the email (IMAP already returns full body
      // inline, no extra fetch needed).
      for (const m of categorized) {
        let bodyText = m.body;
        if (!bodyText && account.type !== 'imap') {
          try {
            const full = await adapter.getMessage(credentials, m.id, { markRead: false });
            bodyText = full.body || '';
          } catch (e) {
            console.error(`[MailManager] Failed to fetch full body for archive (${account.email}, ${m.id}):`, e.message);
          }
        }
        archive.addEntry({
          source_type: 'email',
          account_id: account.id,
          chat_name: account.label,
          project: m.subproject || null,
          from_name: m.from,
          subject: m.subject,
          content: bodyText || '',
          message_id: m.id,
          timestamp: parseEmailDate(m.date).toISOString()
        });
      }

      console.log(`[MailManager] ${account.email}: ${newMessages.length} new messages`);
      results.push({ account, messages: categorized });
    } catch (e) {
      console.error(`[MailManager] Error polling ${account.email}:`, e.message);
      results.push({ account, messages: [], error: e.message });
    }
  }

  return results;
}

// ── Per-account operations ────────────────────────────────────────────────────

async function getMessages(accountId, maxResults = 20, unreadOnly = true) {
  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const credentials = parseCredentials(account);
  if (!credentials) throw new Error(`Account ${accountId} has no credentials`);
  return getAdapter(account).getMessages(credentials, maxResults, unreadOnly);
}

async function getMessage(accountId, messageId) {
  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const credentials = parseCredentials(account);
  if (!credentials) throw new Error(`Account ${accountId} has no credentials`);
  return getAdapter(account).getMessage(credentials, messageId);
}

async function createDraft(accountId, to, subject, body, inReplyToId) {
  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const credentials = parseCredentials(account);
  if (!credentials) throw new Error(`Account ${accountId} has no credentials`);
  return getAdapter(account).createDraft(credentials, to, subject, body, inReplyToId);
}

async function sendMessage(accountId, to, subject, body, inReplyToId) {
  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const credentials = parseCredentials(account);
  if (!credentials) throw new Error(`Account ${accountId} has no credentials`);
  return getAdapter(account).sendMessage(credentials, to, subject, body, inReplyToId);
}

module.exports = { pollAll, getMessages, getMessage, createDraft, sendMessage, buildEmailDigest, categorize };
