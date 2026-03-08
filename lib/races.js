'use strict';

const fs = require('fs');
const path = require('path');
const diskLog = require('./disk-log');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const AGENT_MOUNT = config.yadisk.agent_mount;
const RACES_DIR = path.join(AGENT_MOUNT, 'fitness', 'races');

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function createRace({ name, sport, date, location }) {
  if (!name || !date) {
    return { error: 'Необходимы как минимум name и date' };
  }

  const slug = slugify(name);
  if (!slug) {
    return { error: 'Не удалось создать slug из названия' };
  }

  // Normalize date to YYYY-MM-DD
  let dateStr;
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) throw new Error('Invalid date');
    dateStr = d.toISOString().slice(0, 10);
  } catch {
    return { error: `Некорректная дата: ${date}` };
  }

  const folderName = `${dateStr}_${slug}`;
  const folderPath = path.join(RACES_DIR, folderName);

  if (fs.existsSync(folderPath)) {
    return { error: `Старт "${folderName}" уже существует` };
  }

  const createdAt = new Date().toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/Madrid'
  });

  const sportStr = sport || '—';
  const locationStr = location || '—';

  const readme = `# ${name}

| | |
|---|---|
| **Sport** | ${sportStr} |
| **Date** | ${dateStr} |
| **Location** | ${locationStr} |
| **Status** | 🎯 Planned |
| **Created** | ${createdAt} |

## Description


## Links

- [ ] Official website
- [ ] Results page

## Notes

`;

  const plan = `# Training Plan — ${name}

## Goal


## Key Training Blocks

| Week | Focus | Volume |
|------|-------|--------|
| | | |

## Checkpoints

## Peak Load (X weeks before race)

`;

  const gear = `# Gear — ${name}

## Mandatory Checklist

- [ ]
- [ ]

## Nutrition & Hydration

## Transition Bag

`;

  const result = `# Result — ${name}

_Fill in after finishing_

## Finish Time

## Splits

## How It Felt

## What to Improve

`;

  try {
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, 'README.md'), readme, 'utf8');
    fs.writeFileSync(path.join(folderPath, 'plan.md'), plan, 'utf8');
    fs.writeFileSync(path.join(folderPath, 'gear.md'), gear, 'utf8');
    fs.writeFileSync(path.join(folderPath, 'result.md'), result, 'utf8');
  } catch (err) {
    return { error: `Не удалось создать файлы: ${err.message}` };
  }

  diskLog.log('Создан старт', `${folderName}`);
  console.log(`[Races] Created race: ${folderPath}`);

  return {
    created: true,
    path: `fitness/races/${folderName}`,
    folder: folderName,
    files: ['README.md', 'plan.md', 'gear.md', 'result.md'],
    race: { name, sport: sportStr, date: dateStr, location: locationStr }
  };
}

module.exports = { createRace };
