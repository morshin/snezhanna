'use strict';

const fs = require('fs');
const path = require('path');

// Файл хранится рядом с .tutor-state.json, доступен обоим процессам (Макс и Жора)
const LANG_FILE = path.join(__dirname, '..', 'lang-week.json');

// Вычисляем ISO-номер недели (YYYY-WNN) для произвольной даты
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // 1=пн ... 7=вс
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // смещаемся к четвергу текущей недели
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getCurrentWeekStr() {
  return getISOWeek(new Date());
}

function load() {
  try {
    if (fs.existsSync(LANG_FILE)) {
      return JSON.parse(fs.readFileSync(LANG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[LangWeek] Failed to load:', e.message);
  }
  // По умолчанию — испанский (как было исторически)
  return { lang: 'es', weekStr: '' };
}

function save(data) {
  try {
    fs.writeFileSync(LANG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[LangWeek] Failed to save:', e.message);
    throw e;
  }
}

// Возвращает текущий язык: 'es' (испанский) или 'ru' (русский)
function getCurrentLang() {
  const data = load();
  return data.lang === 'ru' ? 'ru' : 'es';
}

// Устанавливает язык на текущую неделю (вызывается из Жоры)
function setLang(lang) {
  if (lang !== 'es' && lang !== 'ru') throw new Error('Unknown lang: ' + lang);
  save({ lang, weekStr: getCurrentWeekStr(), setAt: new Date().toISOString() });
  console.log('[LangWeek] Set to:', lang, 'week:', getCurrentWeekStr());
}

module.exports = { getCurrentLang, setLang, getCurrentWeekStr, load };
