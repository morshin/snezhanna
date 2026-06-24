#!/usr/bin/env python3
"""
Export secrets and config from an existing instance to /root/deploy.local.env.
Used to preserve credentials across teardown/redeploy cycles during debugging.

Usage:
  sudo python3 scripts/export-deploy-secrets.py [/path/to/instance]

Default instance path: directory containing this script's parent (i.e. the repo root).
"""
import json, os, sys

instance_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env_file = os.path.join(instance_dir, '.env')
cfg_file = os.path.join(instance_dir, 'config', 'nanobot.json')
out_file = '/root/deploy.local.env'

if not os.path.exists(env_file):
    print(f'Error: {env_file} not found', file=sys.stderr)
    sys.exit(1)
if not os.path.exists(cfg_file):
    print(f'Error: {cfg_file} not found', file=sys.stderr)
    sys.exit(1)

env = {}
with open(env_file) as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()

with open(cfg_file) as f:
    cfg = json.load(f)

dir_name = os.path.basename(instance_dir)

lines = [
    f'DIR_NAME={dir_name}',
    f'ASSISTANT_NAME={cfg["user"]["assistant_name"]}',
    f'USER_NAME={cfg["user"]["name"]}',
    f'TIMEZONE={cfg["timezone"]}',
    f'PORT={cfg["mini_app"]["port"]}',
    f'GDRIVE_FOLDER={cfg["gdrive"]["root_folder"]}',
    f'DOMAIN=',
    f'ANTHROPIC_API_KEY={env.get("ANTHROPIC_API_KEY", "")}',
    f'TELEGRAM_BOT_TOKEN={env.get("TELEGRAM_BOT_TOKEN", "")}',
    f'TELEGRAM_ALLOWED_USER_ID={env.get("TELEGRAM_ALLOWED_USER_ID", "")}',
    f'GOOGLE_CLIENT_ID={env.get("GOOGLE_CLIENT_ID", "")}',
    f'GOOGLE_CLIENT_SECRET={env.get("GOOGLE_CLIENT_SECRET", "")}',
    f'OPENAI_API_KEY={env.get("OPENAI_API_KEY", "")}',
]

content = '\n'.join(lines) + '\n'
with open(out_file, 'w') as f:
    f.write(content)
os.chmod(out_file, 0o600)

print(f'Written to {out_file}:')
print()
for line in lines:
    if any(line.startswith(k) for k in ('ANTHROPIC', 'TELEGRAM_BOT', 'GOOGLE_CLIENT', 'OPENAI')):
        k, v = line.split('=', 1)
        print(f'  {k}={"*" * 8}{v[-4:] if len(v) > 4 else "****"}')
    else:
        print(f'  {line}')
