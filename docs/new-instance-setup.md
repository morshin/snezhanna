# Добавление нового инстанса бота на тот же VPS

Каждый пользователь получает изолированную копию бота: свой каталог `/opt/<имя>`, своего системного пользователя, свой systemd-сервис и свой порт для Mini App.

В примерах ниже имя инстанса — `ira`. Везде подставляй нужное: `eugenio`, `lena` и т.д.

---

## Что нужно подготовить заранее (на локальной машине)

- **Telegram-бот**: создать через @BotFather → получить `TELEGRAM_BOT_TOKEN`
- **Telegram ID пользователя**: узнать через @userinfobot → числовой ID
- **Google OAuth credentials**: Google Cloud Console → Desktop-type OAuth 2.0 Client → скачать `credentials.json`
  - Можно использовать тот же Google Cloud Project, что и у основного инстанса
- **Anthropic API key**: platform.anthropic.com
- **OpenAI API key** _(опционально — только для голосовых сообщений)_

---

## Карта инстансов на сервере

Веди этот список вручную — поможет не запутаться с портами:

| Каталог           | Сервис  | Пользователь | Порт |
|-------------------|---------|--------------|------|
| `/opt/snezhanna`  | `snezhanna` | `snezhanna` | 3001 |
| `/opt/ira`        | `ira`   | `ira`        | 3002 |
| `/opt/eugenio`    | `eugenio` | `eugenio`  | 3003 |

---

## Шаг 1. Создать системного пользователя

```bash
sudo useradd -r -m -s /bin/bash ira
```

---

## Шаг 2. Клонировать репозиторий

```bash
cd /opt
sudo git clone https://github.com/morshin/snezhanna ira
sudo chown -R ira:ira /opt/ira
sudo -u ira bash -c "cd /opt/ira && npm install"
```

---

## Шаг 3. Скопировать Google credentials

```bash
# С локальной машины на сервер
scp credentials.json user@server:/opt/ira/credentials.json
sudo chown ira:ira /opt/ira/credentials.json
```

---

## Шаг 4. Настроить .env

```bash
sudo -u ira cp /opt/ira/.env.example /opt/ira/.env
sudo nano /opt/ira/.env
```

Обязательные:
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

> `GOOGLE_TOKEN_FILE`, `STATE_FILE`, `GOOGLE_CREDENTIALS_FILE` не нужны —
> у каждого инстанса свой каталог, пути по умолчанию не конфликтуют.

---

## Шаг 5. Настроить config/nanobot.json

```bash
sudo -u ira nano /opt/ira/config/nanobot.json
```

```json
{
  "user": {
    "name": "Ира",
    "assistant_name": "Света"
  },
  "timezone": "Europe/Moscow",
  "gdrive": {
    "root_folder": "Света"
  },
  "mini_app": {
    "port": 3002
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

`mini_app.port` — уникальный для каждого инстанса (см. карту выше).  
`gdrive.root_folder` — уникальное имя папки в Google Drive.

---

## Шаг 6. Настроить личность бота

```bash
sudo -u ira cp /opt/ira/identity/IDENTITY.template.md /opt/ira/identity/IDENTITY.md
sudo nano /opt/ira/identity/IDENTITY.md
```

`{{USER_NAME}}` и `{{ASSISTANT_NAME}}` подставляются из `config.user` при старте.

---

## Шаг 7. Создать systemd-сервис

```bash
sed 's|INSTANCE_NAME|ira|g; s|INSTANCE_USER|ira|g; s|INSTANCE_DIR|/opt/ira|g' \
  /opt/snezhanna/systemd/snezhanna.service.template \
  | sudo tee /etc/systemd/system/ira.service

sudo systemctl daemon-reload
sudo systemctl enable ira
sudo systemctl start ira
```

Проверить логи:
```bash
journalctl -u ira -f
```

Ожидаемые строки при успешном старте:
```
[DB] initialized
[API] Server listening on port 3002
[Bot] started
```

(`[GDrive] dirs ok` появится после Google OAuth)

---

## Шаг 8. Настроить sudoers для restart из Mini App

```bash
echo "ira ALL=(ALL) NOPASSWD: /bin/systemctl restart ira" \
  | sudo tee /etc/sudoers.d/ira-restart
sudo chmod 440 /etc/sudoers.d/ira-restart
```

---

## Шаг 9. Авторизовать Google

Бот пришлёт ссылку авторизации при первом старте (или написать `/status`):

1. Открыть ссылку из бота
2. Авторизоваться Google-аккаунтом **пользователя** (не Вовиным!)
3. Разрешить: Calendar + Gmail + Drive
4. Скопировать код из адресной строки (`code=...`)
5. Отправить боту: `/auth <код>`

Бот создаст структуру папок в Google Drive и будет готов к работе.

---

## Шаг 10. Онбординг

При первом сообщении бот автоматически запустит визард: проверит интеграции, спросит имя, стиль общения, расписание брифинга. Занимает ~2 минуты.

---

## Обновление

Каждый инстанс обновляется независимо:

```bash
cd /opt/ira
sudo -u ira git pull
sudo -u ira npm install   # если изменились зависимости
sudo systemctl restart ira
```
