'use strict';

const fs   = require('fs');
const path = require('path');

const CFG_FILE  = path.join(__dirname, '..', 'config', 'nanobot.json');
const EXAMPLE   = path.join(__dirname, '..', 'config', 'nanobot.json.example');

exports.description = 'Add github.public_issues_token from nanobot.json.example if missing';

exports.run = function () {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  } catch (e) {
    return { applied: false, message: `nanobot.json not found or invalid: ${e.message}` };
  }

  if (cfg.github && cfg.github.public_issues_token) {
    return { applied: false, message: 'already set' };
  }

  let token = '';
  try {
    const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    token = (example.github && example.github.public_issues_token) || '';
  } catch {
    // example missing — still add the key as empty string
  }

  cfg.github = cfg.github || {};
  cfg.github.public_issues_token = token;
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2) + '\n');

  return { applied: true, message: token ? 'token copied from example' : 'key added (empty — fill manually)' };
};
