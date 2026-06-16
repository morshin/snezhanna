'use strict';

const diskLog = require('./disk-log');
const gdrive = require('./gdrive');

const config = require('./config');

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function createRace({ name, sport, date, location }) {
  if (!name || !date) {
    return { error: 'Необходимы как минимум name и date' };
  }

  const slug = slugify(name);
  if (!slug) {
    return { error: 'Не удалось создать slug из названия' };
  }

  let dateStr;
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) throw new Error('Invalid date');
    dateStr = d.toISOString().slice(0, 10);
  } catch {
    return { error: `Некорректная дата: ${date}` };
  }

  const folderName = `${dateStr}_${slug}`;
  const folderPath = `fitness/races/${folderName}`;

  const createdAt = new Date().toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: config.timezone
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
    await gdrive.writeFile(`${folderPath}/README.md`, readme);
    await gdrive.writeFile(`${folderPath}/plan.md`, plan);
    await gdrive.writeFile(`${folderPath}/gear.md`, gear);
    await gdrive.writeFile(`${folderPath}/result.md`, result);
  } catch (err) {
    return { error: `Не удалось создать файлы: ${err.message}` };
  }

  diskLog.log('Создан старт', folderName);
  console.log(`[Races] Created race: ${folderPath}`);

  return {
    created: true,
    path: folderPath,
    folder: folderName,
    files: ['README.md', 'plan.md', 'gear.md', 'result.md'],
    race: { name, sport: sportStr, date: dateStr, location: locationStr }
  };
}

module.exports = { createRace };
