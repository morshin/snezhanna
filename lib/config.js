'use strict';
const fs = require('fs');
const path = require('path');

const cfgPath   = path.join(__dirname, '../config/nanobot.json');
const localPath = path.join(__dirname, '../config/nanobot.local.json');

function deepMerge(base, override) {
  const result = Object.assign({}, base);
  for (const key of Object.keys(override)) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])
        && base[key]  && typeof base[key]  === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (fs.existsSync(localPath)) {
  cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(localPath, 'utf8')));
}

module.exports = cfg;
