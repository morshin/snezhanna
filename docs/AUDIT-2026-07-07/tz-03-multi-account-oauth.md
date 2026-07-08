# TZ-03: Multi-account Google OAuth via `state` parameter

**Source:** audit 2026-07, bug #3 (🔴 when connecting a second Gmail) + security finding #5 (CSRF).
**Effort:** ~1-2 evenings. Fixes two problems with one mechanism.

## Problem

There is one `getAuthUrl()` for every OAuth purpose (`lib/google.js:40-42`), and
it always redirects to `/auth/google/callback`. That callback
(`lib/api.js:291-310`) unconditionally calls `google.saveToken(code)`, which
**overwrites the main `token.json`** (`lib/google.js:44-49`).

Consequences when connecting a second Gmail via `/auth2 <id>` (`index.js:649-691`):

1. User opens the auth URL, signs in with the *second* account → Google redirects
   to the callback → callback exchanges the code and clobbers `token.json` with
   the second account's token. The bot's Calendar/Drive/Gmail main identity is
   now silently the wrong account.
2. The instructions tell the user to copy the code and run `/auth2 <id> <code>`,
   but authorization codes are single-use — the callback already consumed it, so
   the manual step fails with `invalid_grant`.

Separately, the callback is unauthenticated and has no anti-CSRF `state`
parameter: anyone who can get the owner to visit a crafted Google consent URL
(or who completes the flow themselves against this redirect URI) can bind the
bot to an attacker-controlled Google account.

## Solution

Thread an opaque, server-generated `state` through the whole flow. The callback
routes the token by `state` and rejects requests without a known one.

### 1. Pending-auth registry (lib/google.js or new `lib/oauth-state.js`)

```js
const pendingAuth = new Map(); // state -> { purpose: 'main' | 'account', accountId?, createdAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function createAuthState(purpose, accountId) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingAuth.set(state, { purpose, accountId, createdAt: Date.now() });
  return state;
}
function consumeAuthState(state) { /* get + delete + TTL check; null if unknown */ }
```

In-memory is fine: a restart mid-auth just means re-requesting the link.
Random 128-bit state doubles as the CSRF token — no signing needed.

### 2. `getAuthUrl({ state })` (lib/google.js)

```js
function getAuthUrl(state) {
  return makeOAuth2Client().generateAuthUrl({
    access_type: 'offline', scope: SCOPES, prompt: 'consent', state
  });
}
```

Callers:
- Main-account flow (`offerGoogleAuth()`, onboarding, `/auth` prompt):
  `getAuthUrl(createAuthState('main'))`.
- `/auth2 <id>` (`index.js:677-689`): `getAuthUrl(createAuthState('account', accountId))`.
  Update the instructions text: no more manual code copying — «нажми ссылку,
  войди под нужным аккаунтом, я подтвержу в чате». Keep `/auth2 <id> <code>` as
  emergency fallback (it uses `saveTokenForAccount`, which doesn't touch
  `token.json`, and is unaffected).

### 3. Callback routing (lib/api.js:291-310)

```js
const state = url.searchParams.get('state');
const pending = consumeAuthState(state);
if (!pending) { sendHtml('❌ Неизвестный или устаревший запрос авторизации. Запроси ссылку у бота заново.'); return; }

if (pending.purpose === 'main') {
  await google.saveToken(code);                    // writes token.json
  if (_onGoogleAuthSuccess) await _onGoogleAuthSuccess();
} else {
  const tokens = await google.saveTokenForAccount(code);   // no file write
  db.prepare("UPDATE email_accounts SET credentials = ?, bootstrapped = 0, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(tokens), pending.accountId);
  if (_onAccountAuthSuccess) await _onAccountAuthSuccess(pending.accountId);  // Telegram confirmation
}
```

- `_onAccountAuthSuccess` — new context hook, mirrors `_onGoogleAuthSuccess`;
  sends «✅ Gmail «label» подключён!» to the owner.
- On success page, say *which* account/purpose was connected — makes the
  wrong-account mistake visible immediately.
- (Optional, recommended) Fetch the authorized email via
  `oauth2.userinfo` or the Gmail profile endpoint and store/compare it with
  `email_accounts.email` — warn if the user signed in with the wrong account.

### 4. Backward compatibility

- `/auth <code-or-url>` emergency fallback keeps working (it bypasses the
  callback entirely).
- Reject callback requests with a missing `state` — after this change every
  legitimate URL carries one.

## Acceptance criteria

1. Connecting a second Gmail end-to-end via `/auth2 <id>` works with **zero
   manual code copying**, and `token.json` is byte-identical before/after.
2. Main-account auth (onboarding and `/auth` link) still works and still
   triggers `resumeAfterGoogleAuth()`.
3. Callback hit with no/unknown/expired `state` → error page, no token written
   anywhere (test with a manually crafted Google consent URL — the CSRF case).
4. Signing in with the wrong Google account during an account flow produces a
   visible warning (if the optional email check is implemented).
5. `journalctl` shows which purpose each callback resolved to.
