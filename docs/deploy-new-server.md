# Деплой Snezhanna на новый сервер

Гайд для развёртывания нового инстанса бота (только основной бот, без Max и Жоры) на чистом сервере. Управление сервисом — через Mini App (Settings → раздел «Система»).

---

## Что нужно подготовить заранее (на локальной машине)

- **Telegram-бот**: создать через @BotFather → получить `TELEGRAM_BOT_TOKEN`
- **Telegram ID пользователя**: узнать через @userinfobot → числовой ID
- **Google OAuth credentials**: Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID → тип **Desktop app** → скачать `credentials.json`
  - Можно использовать тот же Google Cloud Project, что и у основного инстанса
- **Anthropic API key**: platform.anthropic.com
- **OpenAI API key** _(опционально — только для голосовых сообщений)_

---

## Шаг 1. Подготовка сервера

```bash
# Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Проверить версии
node --version   # >= 18
npm --version

# Системный пользователь для сервиса
sudo useradd -r -m -s /bin/bash snezhanna
```

---

## Шаг 2. Клонировать репозиторий и установить зависимости

```bash
cd /opt
sudo git clone https://github.com/morshin/snezhanna snezhanna
sudo chown -R snezhanna:snezhanna /opt/snezhanna
sudo -u snezhanna bash -c "cd /opt/snezhanna && npm install"
```

---

## Шаг 3. Скопировать Google credentials

```bash
# С локальной машины на новый сервер
scp credentials.json user@new-server:/opt/snezhanna/credentials.json
sudo chown snezhanna:snezhanna /opt/snezhanna/credentials.json
```

---

## Шаг 4. Настроить .env

```bash
sudo -u snezhanna cp /opt/snezhanna/.env.example /opt/snezhanna/.env
sudo nano /opt/snezhanna/.env
```

Заполнить (обязательные):
```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...           # токен нового бота
TELEGRAM_ALLOWED_USER_ID=...     # числовой Telegram ID пользователя
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Опциональные:
```
OPENAI_API_KEY=...               # для голосовых сообщений
```

**Не нужны** на отдельном сервере: `WATCHDOG_BOT_TOKEN`, `GOOGLE_TOKEN_FILE`, `STATE_FILE`, `GOOGLE_CREDENTIALS_FILE`, `TUTOR_BOT_TOKEN`.

---

## Шаг 5. Настроить config/nanobot.json

```bash
sudo nano /opt/snezhanna/config/nanobot.json
```

Ключевые поля:
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
    "port": 3001
  },
  "integrations": {
    "strava": false,
    "github": false,
    "chat_monitor": false
  },
  "github": { "milestone_due_within_days": 14, "repos": [] },
  "chat_monitor": { "chats": [] }
}
```

`gdrive.root_folder` — уникальное имя папки в Google Drive для этого инстанса.

---

## Шаг 6. Настроить личность бота

```bash
sudo -u snezhanna cp /opt/snezhanna/identity/IDENTITY.template.md \
                     /opt/snezhanna/identity/IDENTITY.md
sudo nano /opt/snezhanna/identity/IDENTITY.md
```

`{{USER_NAME}}` и `{{ASSISTANT_NAME}}` подставляются автоматически из `config.user` при старте.

---

## Шаг 7. Создать systemd-сервис

```bash
sed 's|INSTANCE_NAME|snezhanna|g; s|INSTANCE_USER|snezhanna|g; s|INSTANCE_DIR|/opt/snezhanna|g' \
  /opt/snezhanna/systemd/snezhanna.service.template \
  | sudo tee /etc/systemd/system/snezhanna.service

sudo systemctl daemon-reload
sudo systemctl enable snezhanna
sudo systemctl start snezhanna
```

Проверить логи:
```bash
journalctl -u snezhanna -f
```

Ожидаемые строки при успешном старте:
```
[DB] initialized
[GDrive] dirs ok   ← появится после Google OAuth
[API] Server listening on port 3001
[Bot] started
```

---

## Шаг 8. Настроить sudoers для restart из Mini App

```bash
echo "snezhanna ALL=(ALL) NOPASSWD: /bin/systemctl restart snezhanna" \
  | sudo tee /etc/sudoers.d/snezhanna-restart
sudo chmod 440 /etc/sudoers.d/snezhanna-restart
```

---

## Шаг 9. Авторизовать Google

Бот пришлёт ссылку авторизации при первом старте (или написать `/status`):

1. Открыть ссылку из бота
2. Авторизоваться Google-аккаунтом **пользователя** (не основного инстанса!)
3. Разрешить: Calendar + Gmail + Drive
4. Скопировать код из адресной строки (параметр `code=...`)
5. Отправить боту: `/auth <код>`

Бот создаст структуру папок в Google Drive и будет готов к работе.

---

## Шаг 10. Онбординг

При первом сообщении бот автоматически запустит визард настройки: проверит интеграции, спросит имя, стиль общения, настройки брифинга и чекина. Занимает ~2 минуты.

После онбординга дополнительные настройки доступны в Mini App (кнопка в меню бота).

---

## Шаг 11. Проверка

```bash
journalctl -u snezhanna -n 100
```

В Mini App → Настройки → раздел **Система**: сервис Active ✅

---

## Обновление

```bash
cd /opt/snezhanna
sudo -u snezhanna git pull
sudo -u snezhanna npm install   # если изменились зависимости
sudo systemctl restart snezhanna
```
