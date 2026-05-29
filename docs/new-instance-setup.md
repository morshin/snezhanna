# Настройка нового инстанса бота

Каждый пользователь получает отдельный клон репозитория со своими настройками, данными и личностью бота. Процессы изолированы — данные одного пользователя недоступны другому.

## Предварительные требования

- Node.js 18+
- Telegram бот (создать через @BotFather)
- Anthropic API key (claude.ai/api)
- Опционально: OpenAI API key (для голосовых), Google OAuth credentials, Yandex Disk

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
TELEGRAM_BOT_TOKEN=...        # токен нового бота от @BotFather
TELEGRAM_ALLOWED_USER_ID=...  # числовой Telegram ID пользователя
OPENAI_API_KEY=sk-...         # только если нужны голосовые сообщения
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
  "mini_app": {
    "port": 3002
  },
  "integrations": {
    "google": true,
    "yandex_disk": false,
    "strava": false,
    "github": false,
    "chat_monitor": false
  }
}
```

Важно: если два инстанса на одном VPS, у каждого должен быть **уникальный порт** (`mini_app.port`).

Если Google не нужен — установить `"google": false` и убрать `GOOGLE_CLIENT_ID/SECRET` из `.env`.

## Шаг 4: Настроить личность бота

```bash
cp identity/IDENTITY.template.md identity/IDENTITY.md
nano identity/IDENTITY.md
```

Заполнить `IDENTITY.md` под нового пользователя: как обращаться, стиль общения, что умеет бот. Плейсхолдеры `{{USER_NAME}}` и `{{ASSISTANT_NAME}}` будут заменены из конфига при старте.

## Шаг 5: Настроить очистить chat_monitor и github из конфига

В `config/nanobot.json` очистить:
- `chat_monitor.chats` → пустой массив `[]`
- `github.repos` → пустой массив `[]` (или добавить свои репозитории)
- `index.include_folders` → пустой массив `[]` (если Yandex Disk отключён, не важно)

## Шаг 6: Создать systemd-сервис

```bash
# Создать файл сервиса на основе шаблона
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

## Два инстанса на одном VPS

```
/opt/snezhanna/          # Вова (порт 3001)
/opt/snezhanna-alex/     # Алекс (порт 3002)
```

Каждый со своим:
- `.env` — credentials Telegram, Anthropic, Google
- `config/nanobot.json` — уникальный `mini_app.port`, `user.name`, включённые интеграции
- `identity/IDENTITY.md` — личность и стиль бота
- `data/snezhanna.db` — задачи и проекты
- `token.json` — Google OAuth токен (или указать `GOOGLE_TOKEN_FILE` в `.env`)

## Обновление кода

Каждый клон обновляется независимо:
```bash
cd /opt/snezhanna-alex
git pull
npm install  # если изменились зависимости
sudo systemctl restart snezhanna-alex
```
