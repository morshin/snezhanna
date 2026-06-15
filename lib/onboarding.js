'use strict';

const fs = require('fs');
const path = require('path');
const google = require('./google');
const settings = require('./settings');
const state = require('./state');

// ── Helpers ───────────────────────────────────────────────────────────────────

function kb(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

function ob(step, value) {
  return `ob:${step}:${value}`;
}

// ── Integration check ─────────────────────────────────────────────────────────

function runIntegrationCheck(msg) {
  const anthropicOk = !!process.env.ANTHROPIC_API_KEY;
  const googleOk = google.isAuthorized();
  const openaiOk = !!process.env.OPENAI_API_KEY;

  const fromUser = msg && msg.from;
  const username = fromUser && fromUser.username ? `@${fromUser.username}` : null;
  const fullName = fromUser ? [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') : null;
  const ownerEnv = (process.env.TELEGRAM_ALLOWED_USER_ID || '').replace('@', '');
  const accessLabel = username || ownerEnv;
  const nameLabel = fullName ? ` _(${fullName})_` : '';

  const lines = [
    `🔍 *Проверка подключений*\n`,
    `${anthropicOk ? '✅' : '❌'} Claude AI — ${anthropicOk ? 'готов' : 'не настроен'}`,
  ];

  if (googleOk) {
    lines.push('✅ Google Calendar — авторизован');
    lines.push('✅ Google Gmail — авторизован');
    lines.push('✅ Google Drive — подключён');
  } else {
    lines.push('⚠️ Google — *не авторизован*');
  }

  lines.push(`${openaiOk ? '✅' : '⚠️'} OpenAI — ${openaiOk ? 'готов' : 'нет _(голос недоступен)_'}`);
  lines.push(`\n🔒 Доступ: только для ${accessLabel}${nameLabel}`);

  return { text: lines.join('\n'), googleOk, anthropicOk };
}

// ── Step definitions ──────────────────────────────────────────────────────────

const STEPS = [
  'check',
  'name',
  'bot_persona',
  'identity',
  'traits',
  'style',
  'briefing',
  'briefing_time',
  'checkin',
  'weekends',
  'email',
  'github',
  'strava',
  'chats',
];

function nextStep(currentStep, appState) {
  const idx = STEPS.indexOf(currentStep);
  if (idx < 0) return 'name';
  const candidate = STEPS[idx + 1];
  if (!candidate) return null;

  // Пропустить briefing_time если брифинг выключен
  if (candidate === 'briefing_time' && settings.get('briefing_enabled') === 'false') {
    return nextStep('briefing_time', appState);
  }

  // Пропустить weekends если и брифинг и чекин выключены
  if (candidate === 'weekends') {
    const bOff = settings.get('briefing_enabled') === 'false';
    const cOff = settings.get('checkin_enabled') === 'false';
    if (bOff && cOff) return nextStep('weekends', appState);
  }

  return candidate;
}

async function sendStep(bot, chatId, step, ctx) {
  const name = ctx.name || settings.get('preferred_name') || '';

  switch (step) {
    case 'name':
      // Question already embedded in start() and resumeAfterGoogleAuth()
      break;

    case 'bot_persona':
      await bot.sendMessage(chatId,
        `${name ? `${name}, ` : ''}как представить ассистента — пол и возраст?`,
        kb([
          [
            { text: '👩 Женщина, ~25 лет',  callback_data: ob('bot_persona', 'female_young')  },
            { text: '👨 Мужчина, ~25 лет',  callback_data: ob('bot_persona', 'male_young')    },
          ],
          [
            { text: '👩‍🦱 Женщина, ~40 лет', callback_data: ob('bot_persona', 'female_mature') },
            { text: '✏️ Описать вручную',   callback_data: ob('bot_persona', 'custom')        },
          ],
        ])
      );
      break;

    case 'identity':
      await bot.sendMessage(chatId,
        `${name ? `${name}, ` : ''}каким должен быть твой ассистент?`,
        kb([
          [
            { text: '😊 Дружелюбный и живой',  callback_data: ob('identity', 'friendly')  },
            { text: '💼 Деловой и чёткий',     callback_data: ob('identity', 'business')  },
          ],
          [
            { text: '🧊 Нейтральный',           callback_data: ob('identity', 'neutral')   },
            { text: '✏️ Опишу сам',             callback_data: ob('identity', 'custom')    },
          ],
        ])
      );
      break;

    case 'traits':
      await bot.sendMessage(chatId,
        `Перечисли 2–5 черт характера, которые хочешь видеть в ассистенте — через запятую.\n\n_Например: честность, прямолинейность, лёгкий юмор, любопытство_`,
        { parse_mode: 'Markdown', ...kb([[
          { text: 'Пропустить', callback_data: ob('traits', 'skip') },
        ]]) }
      );
      break;

    case 'style':
      await bot.sendMessage(chatId,
        `${name ? `Отлично, ${name}! ` : ''}Как будем общаться?`,
        kb([
          [
            { text: 'Неформально, кратко',    callback_data: ob('style', 'informal_concise')  },
            { text: 'Неформально, развёрнуто', callback_data: ob('style', 'informal_detailed') },
          ],
          [
            { text: 'Формально, кратко',    callback_data: ob('style', 'formal_concise')  },
            { text: 'Формально, развёрнуто', callback_data: ob('style', 'formal_detailed') },
          ],
        ])
      );
      break;

    case 'briefing':
      await bot.sendMessage(chatId,
        `Присылать утренний брифинг?\n_(сводка задач, почты и календаря на день)_`,
        { parse_mode: 'Markdown', ...kb([[
          { text: 'Да', callback_data: ob('briefing', 'yes') },
          { text: 'Нет', callback_data: ob('briefing', 'no') },
        ]]) }
      );
      break;

    case 'briefing_time':
      await bot.sendMessage(chatId,
        `В котором часу присылать брифинг?`,
        kb([
          [
            { text: '07:00', callback_data: ob('briefing_time', '07:00') },
            { text: '08:00', callback_data: ob('briefing_time', '08:00') },
            { text: '09:00', callback_data: ob('briefing_time', '09:00') },
          ],
          [
            { text: 'Другое время — напиши сам', callback_data: ob('briefing_time', 'custom') },
          ],
        ])
      );
      break;

    case 'checkin':
      await bot.sendMessage(chatId,
        `Вечерний чекин в 19:00?\n_(короткий итог дня)_`,
        { parse_mode: 'Markdown', ...kb([[
          { text: 'Да', callback_data: ob('checkin', 'yes') },
          { text: 'Нет', callback_data: ob('checkin', 'no') },
        ]]) }
      );
      break;

    case 'weekends':
      await bot.sendMessage(chatId,
        `Брифинг и чекин в выходные тоже?`,
        kb([[
          { text: 'Да', callback_data: ob('weekends', 'yes') },
          { text: 'Только будни', callback_data: ob('weekends', 'no') },
        ]])
      );
      break;

    case 'email':
      await bot.sendMessage(chatId,
        `Как часто проверять почту?`,
        kb([
          [
            { text: 'Каждые 15 мин', callback_data: ob('email', '15') },
            { text: 'Каждые 30 мин', callback_data: ob('email', '30') },
          ],
          [
            { text: 'Раз в час',       callback_data: ob('email', '60')  },
            { text: 'Не проверять',    callback_data: ob('email', '0')   },
          ],
        ])
      );
      break;

    case 'github':
      await bot.sendMessage(chatId,
        `Интеграции — добавляют контекст в брифинг.\n\n*GitHub Issues и Milestones?*`,
        { parse_mode: 'Markdown', ...kb([[
          { text: 'Включить',    callback_data: ob('github', 'yes') },
          { text: 'Нет, не нужно', callback_data: ob('github', 'no') },
        ]]) }
      );
      break;

    case 'strava':
      await bot.sendMessage(chatId,
        `*Strava* — тренировки и фитнес-статистика?`,
        { parse_mode: 'Markdown', ...kb([[
          { text: 'Включить',    callback_data: ob('strava', 'yes') },
          { text: 'Нет, не нужно', callback_data: ob('strava', 'no') },
        ]]) }
      );
      break;

    case 'chats':
      await bot.sendMessage(chatId,
        `Мониторинг рабочих и семейных *Telegram-чатов?*\n_(переписка → сводка в брифинге)_`,
        { parse_mode: 'Markdown', ...kb([[
          { text: 'Включить',    callback_data: ob('chats', 'yes') },
          { text: 'Нет, не нужно', callback_data: ob('chats', 'no') },
        ]]) }
      );
      break;
  }
}

const IDENTITY_PRESETS = {
  friendly: 'Общайся живо и тепло, с лёгким юмором и иронией. Будь как умный друг — не зачитывай документы, а разговаривай.',
  business: 'Деловой стиль: чётко, по существу, без лишних слов. Без шуток и неформальностей, только суть.',
  neutral:  'Нейтральный стиль: профессионально и дружелюбно, без излишней фамильярности и без сухости.',
};

const BOT_PERSONA_LABELS = {
  female_young:  'Женщина, ~25 лет',
  male_young:    'Мужчина, ~25 лет',
  female_mature: 'Женщина, ~40 лет',
};

function applyAnswer(step, value, appState) {
  switch (step) {
    case 'bot_persona': {
      const label = BOT_PERSONA_LABELS[value];
      if (label) settings.set('bot_persona', label);
      break;
    }
    case 'traits':
      if (value && value !== 'skip') settings.set('bot_traits', value);
      break;
    case 'identity': {
      const notes = IDENTITY_PRESETS[value];
      if (notes) settings.set('character_notes', notes);
      break;
    }
    case 'style': {
      const [form, style] = value.split('_');
      settings.set('formality', form);
      settings.set('response_style', style === 'concise' ? 'concise' : 'detailed');
      break;
    }
    case 'briefing':
      settings.set('briefing_enabled', value === 'yes' ? 'true' : 'false');
      break;
    case 'briefing_time':
      settings.set('briefing_time', value);
      break;
    case 'checkin':
      settings.set('checkin_enabled', value === 'yes' ? 'true' : 'false');
      break;
    case 'weekends':
      settings.set('weekends_enabled', value === 'yes' ? 'true' : 'false');
      break;
    case 'email':
      settings.set('email_poll_interval', value);
      break;
    case 'github':
      settings.set('github_enabled', value === 'yes' ? 'true' : 'false');
      break;
    case 'strava':
      settings.set('strava_enabled', value === 'yes' ? 'true' : 'false');
      break;
    case 'chats':
      settings.set('chat_monitor_enabled', value === 'yes' ? 'true' : 'false');
      break;
  }
}

function buildSummary() {
  const name = settings.get('preferred_name') || '—';
  const persona = settings.get('bot_persona');
  const traits = settings.get('bot_traits');
  const form = settings.get('formality') === 'formal' ? 'формально' : 'неформально';
  const style = settings.get('response_style') === 'detailed' ? 'развёрнуто' : 'кратко';
  const briefingOn = settings.get('briefing_enabled') !== 'false';
  const briefingTime = settings.get('briefing_time') || '08:00';
  const checkinOn = settings.get('checkin_enabled') !== 'false';
  const weekendsOn = settings.get('weekends_enabled') !== 'false';
  const emailInt = parseInt(settings.get('email_poll_interval') || '30', 10);
  const emailLabel = emailInt === 0 ? 'не проверять' : emailInt < 60 ? `каждые ${emailInt} мин` : 'раз в час';
  const githubOn = settings.get('github_enabled') !== 'false';
  const stravaOn = settings.get('strava_enabled') !== 'false';
  const chatsOn = settings.get('chat_monitor_enabled') === 'true';
  const schedule = weekendsOn ? 'каждый день' : 'будни';

  const charNotes = settings.get('character_notes');

  const lines = [
    `· Обращение: ${name}`,
    persona ? `· Образ бота: ${persona}` : null,
    charNotes ? `· Характер: ${charNotes.slice(0, 60)}${charNotes.length > 60 ? '…' : ''}` : null,
    traits ? `· Черты: ${traits}` : null,
    `· Стиль: ${form}, ${style}`,
    `· Брифинг: ${briefingOn ? `${briefingTime}, ${schedule}` : 'выключен'}`,
    `· Вечерний чекин: ${checkinOn ? `да, ${schedule}` : 'выключен'}`,
    `· Почта: ${emailLabel}`,
    `· GitHub / Strava: ${[githubOn ? 'GitHub' : null, stravaOn ? 'Strava' : null].filter(Boolean).join(', ') || 'отключены'}`,
    `· Мониторинг чатов: ${chatsOn ? 'включён' : 'выключен'}`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function sendFinalMessage(bot, chatId) {
  const summary = buildSummary();

  await bot.sendMessage(chatId,
    `🎉 *Готово! Всё настроено.*\n\n${summary}`,
    { parse_mode: 'Markdown' }
  );

  await new Promise(r => setTimeout(r, 400));

  await bot.sendMessage(chatId,
    `*Что ещё можно настроить в Mini App*\n` +
    `_Кнопка в меню бота_\n\n` +
    `📧 Почтовые ящики — Gmail или корпоративная почта\n` +
    `💬 Рабочие чаты — мониторинг переписки\n` +
    `📁 Проекты — задачи, заметки, брифинг\n` +
    `👤 Контакты — CRM: роль, компания, проекты\n` +
    `⚙️ Расписание — время брифинга, тихий режим\n\n` +
    `Всё готово — напиши что-нибудь 👋`,
    { parse_mode: 'Markdown' }
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

async function start(bot, chatId, msg, appState, config) {
  const assistantName = (config && config.user && config.user.assistant_name) || 'Ассистент';

  // ── Welcome banner ────────────────────────────────────────────────────────
  await bot.sendMessage(chatId,
    `✨ *${assistantName}* — твой персональный ИИ-ассистент\n\n` +
    `Вот что я умею:\n` +
    `🗓 Слежу за календарём и встречами\n` +
    `📬 Читаю и резюмирую почту\n` +
    `✅ Веду задачи и проекты\n` +
    `☀️ Присылаю утренний брифинг\n` +
    `💬 Отвечаю на любые вопросы\n\n` +
    `_Сейчас проверю подключения..._`,
    { parse_mode: 'Markdown' }
  );

  // ── Animated check: "loading" → edit to results ───────────────────────────
  await bot.sendChatAction(chatId, 'typing');
  const loadingMsg = await bot.sendMessage(chatId, '⏳ _Проверяю..._', { parse_mode: 'Markdown' });
  await new Promise(r => setTimeout(r, 1200));

  const { text: checkText, googleOk } = runIntegrationCheck(msg);
  await bot.editMessageText(checkText, {
    chat_id: chatId,
    message_id: loadingMsg.message_id,
    parse_mode: 'Markdown'
  });

  if (!googleOk) {
    await new Promise(r => setTimeout(r, 500));
    const authUrl = google.getAuthUrl();
    await bot.sendMessage(chatId,
      `⚠️ *Google не авторизован*\n\n` +
      `Это нужно для Calendar, Gmail и Drive.\n\n` +
      `*Как подключить:*\n` +
      `1\\. Нажми кнопку ниже — откроется браузер\n` +
      `2\\. Войди в свой Google\\-аккаунт\n` +
      `3\\. Разреши доступ ко всем запрошенным правам\n` +
      `4\\. В адресной строке скопируй значение после \`code=\`\n` +
      `   _выглядит как:_ \`4/0AX4XfWg\\.\\.\\.\\.\`\n` +
      `5\\. Отправь мне: \`/auth КОД\``,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔗 Открыть Google →', url: authUrl }
          ]]
        }
      }
    );
    appState.onboarding_step = 'waiting_google';
    state.save(appState);
    return;
  }

  // ── Transition straight into first question ───────────────────────────────
  await new Promise(r => setTimeout(r, 600));
  await bot.sendMessage(chatId,
    `Отлично, всё подключено! Настроим бота под тебя — займёт пару минут.\n\n*Как тебя называть?*\n_Можно через запятую — все желаемые обращения: Ира, Ирок, Иришка_`,
    { parse_mode: 'Markdown' }
  );

  appState.onboarding_step = 'name';
  state.save(appState);
}

async function resumeAfterGoogleAuth(bot, chatId, appState, config) {
  await bot.sendMessage(chatId,
    `✅ *Google авторизован!*\n\nКалендарь, почта и Drive подключены. Продолжим настройку.\n\n*Как тебя называть?*\n_Можно через запятую — все желаемые обращения: Ира, Ирок, Иришка_`,
    { parse_mode: 'Markdown' }
  );
  appState.onboarding_step = 'name';
  state.save(appState);
}

async function handleMessage(bot, msg, appState) {
  const chatId = msg.chat.id;
  const step = appState.onboarding_step;
  const text = (msg.text || '').trim();
  const name = settings.get('preferred_name') || '';

  if (step === 'waiting_google' || step === 'check') {
    // Waiting for /auth — handled in index.js; ignore regular messages
    await bot.sendMessage(chatId, `Сначала авторизуй Google — отправь /status для получения ссылки.`);
    return;
  }

  if (step === 'name') {
    if (!text || text.startsWith('/')) {
      await bot.sendMessage(chatId, `Напиши своё имя — как тебя называть.`);
      return;
    }
    const name = text.slice(0, 40);
    settings.set('preferred_name', name);
    appState.onboarding_step = nextStep('name', appState);
    state.save(appState);
    await sendStep(bot, chatId, appState.onboarding_step, { name });
    return;
  }

  if (step === 'bot_persona_custom') {
    if (!text || text.startsWith('/')) {
      await bot.sendMessage(chatId, `Опиши пол и возраст ассистента, например: «Женщина, ~30 лет»`);
      return;
    }
    settings.set('bot_persona', text.slice(0, 100));
    appState.onboarding_step = nextStep('bot_persona', appState);
    state.save(appState);
    await sendStep(bot, chatId, appState.onboarding_step, { name });
    return;
  }

  if (step === 'identity_custom') {
    if (!text || text.startsWith('/')) {
      await bot.sendMessage(chatId, `Опиши в паре предложений, как должен общаться твой ассистент.`);
      return;
    }
    settings.set('character_notes', text.slice(0, 500));
    appState.onboarding_step = nextStep('identity', appState);
    state.save(appState);
    await sendStep(bot, chatId, appState.onboarding_step, { name });
    return;
  }

  if (step === 'traits') {
    if (!text || text.startsWith('/')) {
      await bot.sendMessage(chatId, `Перечисли черты через запятую или нажми «Пропустить».`);
      return;
    }
    settings.set('bot_traits', text.slice(0, 300));
    appState.onboarding_step = nextStep('traits', appState);
    state.save(appState);
    await sendStep(bot, chatId, appState.onboarding_step, { name });
    return;
  }

  if (step === 'briefing_time_custom') {
    // Custom time input: expect HH:MM
    const timeMatch = text.match(/^(\d{1,2})[:\.](\d{2})$/);
    if (!timeMatch) {
      await bot.sendMessage(chatId, `Введи время в формате ЧЧ:ММ, например 07:30`);
      return;
    }
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      await bot.sendMessage(chatId, `Некорректное время. Введи в формате ЧЧ:ММ, например 07:30`);
      return;
    }
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    applyAnswer('briefing_time', timeStr, appState);
    await bot.sendMessage(chatId, `Отлично, буду присылать в ${timeStr}.`);
    appState.onboarding_step = nextStep('briefing_time', appState);
    state.save(appState);
    await sendStep(bot, chatId, appState.onboarding_step, {});
    return;
  }

  // All other steps use buttons — gently remind
  if (step && step !== null) {
    await bot.sendMessage(chatId, `Нажми одну из кнопок выше 👆`);
  }
}

async function handleCallback(bot, query, appState) {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  if (!data.startsWith('ob:')) return;

  const parts = data.split(':');
  const step = parts[1];
  const value = parts.slice(2).join(':');

  if (appState.onboarding_step !== step) return;

  if (step === 'bot_persona' && value === 'custom') {
    appState.onboarding_step = 'bot_persona_custom';
    state.save(appState);
    await bot.sendMessage(chatId, `Опиши пол и возраст ассистента, например: «Женщина, ~30 лет»`);
    return;
  }

  if (step === 'traits' && value === 'skip') {
    const next = nextStep('traits', appState);
    appState.onboarding_step = next;
    state.save(appState);
    if (!next) { await finishOnboarding(bot, chatId, appState); return; }
    await sendStep(bot, chatId, next, {});
    return;
  }

  if (step === 'identity' && value === 'custom') {
    appState.onboarding_step = 'identity_custom';
    state.save(appState);
    await bot.sendMessage(chatId, `Опиши в паре предложений, как должен общаться твой ассистент.`);
    return;
  }

  if (value === 'custom') {
    // Special case: custom briefing time
    appState.onboarding_step = 'briefing_time_custom';
    state.save(appState);
    await bot.sendMessage(chatId, `Введи время в формате ЧЧ:ММ, например 07:30`);
    return;
  }

  if (step === 'chats' && value === 'yes') {
    applyAnswer('chats', 'yes', appState);
    await bot.sendMessage(chatId,
      `Ок, функция включена. Добавить конкретные чаты — в Mini App (Настройки → раздел «Чаты»).\n\n` +
      `Чтобы узнать числовой ID нужного чата — перешли любое сообщение из него боту @userinfobot`,
      kb([[{ text: 'Понятно, продолжим', callback_data: ob('chats_ack', 'ok') }]])
    );
    appState.onboarding_step = 'chats_ack';
    state.save(appState);
    return;
  }

  if (step === 'chats_ack') {
    // Proceed to finish
    await finishOnboarding(bot, chatId, appState);
    return;
  }

  if (step === 'github_relay_ack') {
    const next = nextStep('github', appState);
    appState.onboarding_step = next || null;
    state.save(appState);
    if (!next) { await finishOnboarding(bot, chatId, appState); return; }
    await sendStep(bot, chatId, next, {});
    return;
  }

  applyAnswer(step, value, appState);

  // After enabling GitHub: if Telegram relay group is configured, prompt to add this bot to it
  if (step === 'github' && value === 'yes' && process.env.ZHORA_REPORT_CHAT) {
    await bot.sendMessage(chatId,
      `✅ GitHub включён.\n\n` +
      `*Один важный шаг для создания issues из чата:*\n` +
      `Этот бот должен быть добавлен в группу-ретранслятор Жоры \\(ZHORA\\_REPORT\\_CHAT\\)\\.\n\n` +
      `Попроси администратора добавить этого бота в группу \\— без этого команда «создать issue» не сработает\\.\n\n` +
      `_Это одноразовый шаг при деплое каждого нового инстанса\\._`,
      {
        parse_mode: 'MarkdownV2',
        ...kb([[{ text: 'Понятно, продолжим', callback_data: ob('github_relay_ack', 'ok') }]])
      }
    );
    appState.onboarding_step = 'github_relay_ack';
    state.save(appState);
    return;
  }

  const next = nextStep(step, appState);

  if (!next) {
    await finishOnboarding(bot, chatId, appState);
    return;
  }

  appState.onboarding_step = next;
  state.save(appState);
  await sendStep(bot, chatId, next, {});
}

async function finishOnboarding(bot, chatId, appState) {
  appState.onboarding_completed = true;
  appState.onboarding_step = null;
  state.save(appState);
  await sendFinalMessage(bot, chatId);
  console.log('[Onboarding] Completed for chatId:', chatId);
}

async function restart(bot, chatId, msg, appState, config) {
  appState.onboarding_completed = false;
  appState.onboarding_step = null;
  state.save(appState);
  console.log('[Onboarding] Restarted for chatId:', chatId);
  await start(bot, chatId, msg, appState, config);
}

module.exports = { start, restart, handleMessage, handleCallback, resumeAfterGoogleAuth };
