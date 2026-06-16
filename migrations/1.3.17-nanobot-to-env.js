'use strict';

/**
 * Migrate config/nanobot.json tenant overrides → .env
 *
 * Before v1.3.17, tenants stored instance-specific settings in
 * config/nanobot.json (gitignored after this version). This migration
 * reads that file (if it exists) and writes any non-default values
 * into .env so nothing is lost after the file stops being read.
 */

const fs   = require('fs');
const path = require('path');

const ROOT         = path.join(__dirname, '..');
const NANOBOT_JSON = path.join(ROOT, 'config', 'nanobot.json');
const ENV_FILE     = path.join(ROOT, '.env');

// Mapping: nanobot.json path → { envKey, default }
// Only fields that tenants commonly customise per-instance.
const MAPPINGS = [
  { get: c => c.user?.assistant_name,             envKey: 'ASSISTANT_NAME',      def: 'Снежанна'           },
  { get: c => c.user?.name,                       envKey: 'USER_NAME',           def: 'шеф'                },
  { get: c => c.gdrive?.root_folder,              envKey: 'GDRIVE_ROOT_FOLDER',  def: 'Снежанна'           },
  { get: c => c.timezone,                         envKey: 'TIMEZONE',            def: 'Europe/Madrid'      },
  { get: c => c.model,                            envKey: 'CLAUDE_MODEL',        def: 'claude-sonnet-4-6'  },
  { get: c => c.max_tokens,                       envKey: 'CLAUDE_MAX_TOKENS',   def: 4096                 },
  { get: c => c.mini_app?.port,                   envKey: 'MINI_APP_PORT',       def: 3001                 },
  { get: c => c.database?.path,                   envKey: 'DATABASE_PATH',       def: 'data/snezhanna.db'  },
  { get: c => c.github?.self_repo,                envKey: 'GITHUB_SELF_REPO',    def: 'morshin/snezhanna'  },
  { get: c => c.github?.milestone_due_within_days, envKey: 'GITHUB_MILESTONE_DAYS', def: 14               },
  { get: c => c.github?.repos?.length
      ? JSON.stringify(c.github.repos) : undefined, envKey: 'GITHUB_REPOS',      def: undefined            },
  { get: c => c.integrations?.strava === false ? 'false' : undefined,
                                                   envKey: 'INTEGRATIONS_STRAVA', def: undefined           },
  { get: c => c.integrations?.github === false ? 'false' : undefined,
                                                   envKey: 'INTEGRATIONS_GITHUB', def: undefined           },
  { get: c => c.integrations?.chat_monitor === false ? 'false' : undefined,
                                                   envKey: 'INTEGRATIONS_CHAT_MONITOR', def: undefined     },
];

exports.description = 'Migrate config/nanobot.json tenant values → .env';

exports.run = async function () {
  if (!fs.existsSync(NANOBOT_JSON)) {
    return { applied: false, message: 'config/nanobot.json not found — nothing to migrate' };
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(NANOBOT_JSON, 'utf8'));
  } catch (e) {
    return { applied: false, message: `Could not parse nanobot.json: ${e.message}` };
  }

  // Read current .env content
  let envContent = '';
  try { envContent = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* .env missing — unlikely */ }

  const added = [];

  for (const { get, envKey, def } of MAPPINGS) {
    const val = get(cfg);
    // Skip if value is undefined, null, or matches the default (not a tenant override)
    if (val === undefined || val === null) continue;
    if (String(val) === String(def)) continue;

    // Skip if already set in .env
    if (new RegExp(`^${envKey}=`, 'm').test(envContent)) continue;

    envContent += `\n${envKey}=${val}`;
    added.push(envKey);
  }

  if (!added.length) {
    return { applied: false, message: 'all values already in .env or match defaults' };
  }

  fs.writeFileSync(ENV_FILE, envContent);
  return { applied: true, message: `added to .env: ${added.join(', ')}` };
};
