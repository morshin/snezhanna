'use strict';

// Single choke point for reading/writing email_accounts.credentials — every
// caller goes through here instead of JSON.parse/JSON.stringify directly, so
// encryption (lib/secret-box.js) stays in one place.

const secretBox = require('./secret-box');

// account: a DB row (or any object) with a `.credentials` string column.
function readCredentials(account) {
  if (!account || !account.credentials) return null;
  try {
    return JSON.parse(secretBox.decrypt(account.credentials));
  } catch (e) {
    console.error('[EmailCredentials] Failed to read credentials:', e.message);
    return null;
  }
}

// obj: plain credentials object → returns the string to store in the DB column.
function encodeCredentials(obj) {
  return secretBox.encrypt(JSON.stringify(obj));
}

module.exports = { readCredentials, encodeCredentials };
