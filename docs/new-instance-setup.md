# Настройка нового инстанса бота

Каждый пользователь получает отдельный клон репозитория со своими настройками, данными и личностью бота. Процессы изолированы — данные одного пользователя недоступны другому.

## Предварительные требования

- Node.js 18+
- Telegram бот (создать через @BotFather)
- Anthropic API key (claude.ai/api)
- Google OAuth credentials (Desktop-type) — для Calendar, Gmail, Drive
- Опционально: OpenAI API key (для голосовых сообщений), GitHub token, Strava tokens

## Шаг 1: Клонировать репозиторий

```bash
cd /opt
git clone https://github.com/morshin/snezhanna snezhanna-alex
cd snezhanna-alex
npm install
```

## Шаг 2: Настроить переменные окружения

```bash
cp .env.example .env
nano .env
```

Минимально необходимые переменные:
```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...           # токен нового бота от @BotFather
TELEGRAM_ALLOWED_USER_ID=...     # числовой Telegram ID пользователя
GOOGLE_CLIENT_ID=...             # Google OAuth2 (Desktop-type client)
GOOGLE_CLIENT_SECRET=...
OPENAI_API_KEY=sk-...            # опционально — только для голосовых
```

Если два инстанса на одном VPS — чтобы не конфликтовали файлы авторизации:
```
GOOGLE_TOKEN_FILE=/opt/snezhanna-alex/token.json
GOOGLE_CREDENTIALS_FILE=/opt/snezhanna-alex/credentials.json
STATE_FILE=/opt/snezhanna-alex/.nanobot/state.json
```

## Шаг 3: Настроить конфиг

Отредактировать `config/nanobot.json`:

```json
{
  "user": {
    "name": "Алекс",
    "assistant_name": "Алиса"
  },
  "timezone": "Europe/Moscow",
  "gdrive": {
    "root_folder": "Алиса"
  },
  "mini_app": {
    "port": 3002
  },
  "integrations": {
    "strava": false,
    "github": false,
    "chat_monitor": false
  },
  "chat_monitor": {
    "chats": []
  },
  "github": {
    "milestone_due_within_days": 14,
    "repos": []
  }
}
```

**Важно:** если два инстанса на одном VPS, у каждого должен быть **уникальный порт** (`mini_app.port`).

`gdrive.root_folder` — название корневой папки в Google Drive для этого инстанса. Каждый инстанс должен иметь свою папку.

## Шаг 4: Настроить личность бота

```bash
cp identity/IDENTITY.template.md identity/IDENTITY.md
nano identity/IDENTITY.md
```

Заполнить под нового пользователя: как обращаться, стиль общения, какие возможности включены. Плейсхолдеры `{{USER_NAME}}` и `{{ASSISTANT_NAME}}` будут заменены из `config.user` при старте.

## Шаг 5: Создать systemd-сервис

```bash
sed 's|INSTANCE_NAME|snezhanna-alex|g; s|INSTANCE_DIR|/opt/snezhanna-alex|g' \
  systemd/snezhanna.service.template \
  | sudo tee /etc/systemd/system/snezhanna-alex.service

sudo systemctl daemon-reload
sudo systemctl enable snezhanna-alex
sudo systemctl start snezhanna-alex
```

Проверить логи:
```bash
journalctl -u snezhanna-alex -f
```

## Шаг 6: Авторизовать Google

После первого запуска бот пришлёт ссылку для Google OAuth. Если не прислал — написать `/status`.

1. Перейти по ссылке, дать разрешения (Calendar + Gmail + Drive)
2. Скопировать код из адресной строки
3. Отправить боту: `/auth <код>`

После этого бот создаст структуру папок в Google Drive (`gdrive.root_folder/memory/`, `fitness/`, `backups/` и т.д.) и будет готов к работе.

## Два инстанса на одном VPS

```
/opt/snezhanna/          # Вова (порт 3001, Drive: «Снежанна»)
/opt/snezhanna-alex/     # Алекс (порт 3002, Drive: «Алиса»)
```

Каждый со своим:
- `.env` — credentials Telegram, Anthropic, Google; `GOOGLE_TOKEN_FILE`, `STATE_FILE`
- `config/nanobot.json` — уникальный `mini_app.port`, `user.name`, `gdrive.root_folder`
- `identity/IDENTITY.md` — личность бота
- `data/snezhanna.db` — задачи и проекты (локальная SQLite)
- `token.json` — Google OAuth токен (путь задан через `GOOGLE_TOKEN_FILE`)

## Обновление кода

Каждый клон обновляется независимо:
```bash
cd /opt/snezhanna-alex
git pull
npm install  # если изменились зависимости
sudo systemctl restart snezhanna-alex
```
