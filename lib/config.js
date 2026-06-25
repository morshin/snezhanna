'use strict';
const fs = require('fs');
const path = require('path');

const cfgPath = path.join(__dirname, '../config/nanobot.json');
module.exports = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
