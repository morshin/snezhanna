# Deploy Snezhanna

Restart the bot service and verify it's running correctly.

## Steps

1. Run `sudo systemctl restart snezhanna` to restart the service.
2. Wait 3 seconds, then run `sudo systemctl status snezhanna` to check the service status.
3. Run `journalctl -u snezhanna -n 30 --no-pager` to show the last 30 log lines.
4. Report:
   - Whether the service started successfully (Active: active (running)).
   - Any errors or warnings in the logs.
   - The startup message timestamp.

If the service failed to start, show the full error from the logs and suggest a fix.
