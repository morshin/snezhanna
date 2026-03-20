# Deploy Snezhanna

Restart one or all bot services and verify they are running correctly.

## Deploy all services

```bash
sudo systemctl restart snezhanna tutor zhora
```

## Deploy a specific service

```bash
sudo systemctl restart snezhanna   # main bot
sudo systemctl restart tutor       # Max tutor bot
sudo systemctl restart zhora       # watchdog
```

## Steps

1. Restart the target service(s).
2. Wait 3 seconds, then check status. **Do not use `sudo` here** — on this host `systemctl status` is allowed for user `vova`; `sudo` would require NOPASSWD rules for every argv variant (`--no-pager`, unit list). Use `--no-pager` for non-interactive output:
   ```bash
   systemctl status snezhanna tutor zhora --no-pager
   ```
3. Show the last 30 log lines for the restarted service(s):
   ```bash
   journalctl -u snezhanna -n 30 --no-pager
   journalctl -u tutor -n 30 --no-pager
   journalctl -u zhora -n 30 --no-pager
   ```
4. Report:
   - Whether each service started successfully (`Active: active (running)`).
   - Any errors or warnings in the logs.
   - The startup message timestamp.

If a service failed to start, show the full error from the logs and suggest a fix.
