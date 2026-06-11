# Деплой Snezhanna на новый сервер

Гайд для развёртывания нового инстанса бота (только основной бот, без Max и Жоры) на чистом сервере. Управление сервисом — через Mini App (Settings → раздел «Система»).

---

## Что нужно подготовить заранее (на локальной машине)

- **Telegram-бот**: создать через @BotFather → получить `TELEGRAM_BOT_TOKEN`
- **Telegram ID пользователя**: узнать через @userinfobot → числовой ID
- **Google OAuth credentials**: Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID → тип **Desktop app** → скопировать `Client ID` и `Client Secret`
  - Можно использовать тот же Google Cloud Project, что и у основного инстанса
- **Anthropic API key**: platform.anthropic.com
- **OpenAI API key** _(опционально — только для голосовых сообщений)_
- **Домен** _(опционально — нужен для Mini App)_: DNS A-запись должна указывать на IP сервера. Скрипт выпустит TLS-сертификат через Let's Encrypt автоматически.

---

## Деплой

На сервере должны быть установлены **Node.js 18+** и **git**:

```bash
# Debian/Ubuntu — если ещё не установлен Node.js 18+:
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Затем — одна команда:

```bash
curl -fsSL https://raw.githubusercontent.com/morshin/snezhanna/master/deploy.sh \
  -o /tmp/deploy.sh && sudo bash /tmp/deploy.sh
```

Скрипт запросит:
- Имя каталога, имя бота и пользователя, часовой пояс
- API-ключи: Anthropic, Telegram бот-токен, Telegram ID, Google Client ID + Secret, OpenAI (опционально)

Далее скрипт сам: клонирует последний релиз в `/opt/<имя>/`, генерирует `credentials.json`, настраивает сервис, создаёт systemd-юнит и запускает бота.

**После запуска:** бот пришлёт ссылку для авторизации Google. Перейди по ней, разреши доступ к Calendar + Gmail + Drive, скопируй `code=...` из адресной строки и отправь боту: `/auth <код>`. Онбординг запустится автоматически при первом сообщении.

---

## Mini App

Mini App работает как HTTP-сервер на порту из `nanobot.json`. Telegram требует HTTPS.

**Если указать домен при запуске `deploy.sh`** — скрипт сам установит nginx, выпустит TLS-сертификат через Let's Encrypt и настроит автопродление (`certbot.timer`). DNS A-запись домена должна указывать на IP сервера до запуска скрипта.

**Альтернатива без домена — Cloudflare Tunnel:**

```bash
# см. developers.cloudflare.com/cloudflare-one/connections/connect-networks/
cloudflared tunnel create <имя>
cloudflared tunnel route dns <имя> alice.example.com
# cloudflared service install  — запустить как сервис
```

### Настройка кнопки в BotFather

После того как Mini App доступен по HTTPS-адресу:

1. Открыть @BotFather → `/mybots` → выбрать бота
2. **Bot Settings → Menu Button → Configure Menu Button**
3. Ввести URL: `https://alice.example.com`
4. Ввести текст кнопки: `Открыть` (или любой другой)

После этого кнопка Mini App появится рядом с полем ввода в Telegram.

---

## Обновление

```bash
sudo bash /opt/<имя>/scripts/update.sh
```

---

<details>
<summary>Ручной деплой (пошагово)</summary>

### Шаг 1. Подготовка сервера

```bash
# Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Системный пользователь для сервиса
sudo useradd -r -m -s /bin/bash snezhanna
```

### Шаг 2. Клонировать репозиторий и установить зависимости

```bash
cd /opt
sudo git clone https://github.com/morshin/snezhanna snezhanna
sudo chown -R snezhanna:snezhanna /opt/snezhanna
sudo -u snezhanna bash -c "cd /opt/snezhanna && npm install"
```

### Шаг 3. Скопировать Google credentials

```bash
# С локальной машины на новый сервер
scp credentials.json user@new-server:/opt/snezhanna/credentials.json
sudo chown snezhanna:snezhanna /opt/snezhanna/credentials.json
```

### Шаг 4. Настроить .env

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

### Шаг 5. Настроить config/nanobot.json

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

### Шаг 6. Настроить личность бота

```bash
sudo -u snezhanna cp /opt/snezhanna/identity/IDENTITY.template.md \
                     /opt/snezhanna/identity/IDENTITY.md
sudo nano /opt/snezhanna/identity/IDENTITY.md
```

`{{USER_NAME}}` и `{{ASSISTANT_NAME}}` подставляются автоматически из `config.user` при старте.

### Шаг 7. Создать systemd-сервис

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

### Шаг 8. Настроить sudoers для управления сервисом из Mini App

```bash
printf 'snezhanna ALL=(ALL) NOPASSWD: /bin/systemctl restart snezhanna\nsnezhanna ALL=(ALL) NOPASSWD: /bin/systemctl start snezhanna\n' \
  | sudo tee /etc/sudoers.d/snezhanna-restart
sudo chmod 440 /etc/sudoers.d/snezhanna-restart
```

### Шаг 9. Авторизовать Google

Бот пришлёт ссылку авторизации при первом старте (или написать `/status`):

1. Открыть ссылку из бота
2. Авторизоваться Google-аккаунтом **пользователя** (не основного инстанса!)
3. Разрешить: Calendar + Gmail + Drive
4. Скопировать код из адресной строки (параметр `code=...`)
5. Отправить боту: `/auth <код>`

Бот создаст структуру папок в Google Drive и будет готов к работе.

### Шаг 10. Онбординг

При первом сообщении бот автоматически запустит визард настройки: проверит интеграции, спросит имя, стиль общения, настройки брифинга и чекина. Занимает ~2 минуты.

После онбординга дополнительные настройки доступны в Mini App (кнопка в меню бота).

### Шаг 11. Проверка

```bash
journalctl -u snezhanna -n 100
```

В Mini App → Настройки → раздел **Система**: сервис Active ✅

</details>
