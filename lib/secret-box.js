'use strict';

// AES-256-GCM encryption for secrets stored in SQLite (currently: email account
// credentials). Values are stored with an `enc:v1:` prefix; anything without
// that prefix is treated as legacy plaintext and passed through on decrypt —
// this makes migration lazy and safe: old rows keep working, and every write
// re-encrypts, so plaintext rows age out of backups naturally.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const hex = process.env.CREDENTIALS_KEY;
  if (!hex) return null;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('CREDENTIALS_KEY must be a 64-character hex string (32 bytes) — check .env');
  }
  return Buffer.from(hex, 'hex');
}

function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

function encrypt(plaintext) {
  const key = getKey();
  if (!key) throw new Error('CREDENTIALS_KEY not set in .env — cannot store email credentials. Generate one with: openssl rand -hex 32');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

function decrypt(stored) {
  if (!isEncrypted(stored)) return stored; // legacy plaintext passthrough
  const key = getKey();
  if (!key) throw new Error('CREDENTIALS_KEY not set in .env — cannot read encrypted email credentials');
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const authTag = raw.subarray(raw.length - TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN, raw.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted };
