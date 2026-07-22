# Hosting Sinless with logins + cloud character storage

This turns the static app into a multi-user app: players sign in with Google or
GitHub, new accounts wait in an **admin-approval queue**, and each approved user's
characters sync to the server and follow them across devices. The rules engine
still runs in the browser — the server only stores per-user character JSON.

**If you don't do any of this, nothing changes:** with no `/api` backend present
(e.g. GitHub Pages), the app detects that and runs exactly as before — local
`localStorage` only, no login screen.

---

## Requirements

- Shared hosting (or any server) with **PHP 7.4+** (8.x fine) and the `pdo_mysql`
  + `curl` extensions (both are standard).
- A **MySQL** database.
- **HTTPS** on your domain (required for OAuth + secure cookies; most hosts
  include free Let's Encrypt).
- The app served from the domain root (or a subpath) with `/api/*.php` reachable
  at the same origin.

---

## 1. Create the database tables

Import `db/schema.sql` into your database (phpMyAdmin → SQL tab, or CLI):

```
mysql -u <dbuser> -p <dbname> < db/schema.sql
```

## 2. Register the OAuth apps

You need at least one provider. The **Authorization callback URL** for both is:

```
https://YOURDOMAIN/api/auth/callback.php
```

**Google** — [Google Cloud Console](https://console.cloud.google.com/) →
*APIs & Services → Credentials → Create OAuth client ID → Web application*.
Add the callback above as an *Authorized redirect URI*. Configure the OAuth
consent screen (External, add yourself as a test user while unverified). Copy the
**Client ID** and **Client secret**.

**GitHub** — *Settings → Developer settings → OAuth Apps → New OAuth App*.
Set *Authorization callback URL* to the callback above. Copy the **Client ID**
and generate a **Client secret**.

## 3. Configure the server

```
cp api/config.example.php api/config.php
```

Edit `api/config.php`:
- `db` — your MySQL host/name/user/password.
- `base_url` — `https://YOURDOMAIN` (no trailing slash). Used to build the OAuth
  redirect and to keep post-login redirects same-origin.
- `oauth.google` / `oauth.github` — the client id + secret from step 2. Leave a
  provider's `client_id` blank to hide its button.
- `admin_identities` — **add your own** email or `provider:id` here so your first
  sign-in is auto-approved and made admin (that's how you approve everyone else).
- `approval_webhook_url` — a Discord/Slack *incoming webhook* URL (step 5).
- `session.cookie_secure` — leave `true` (HTTPS). Optionally set
  `session.save_path` to a private writable dir outside the web root.

**Keep `config.php` secret.** The bundled `.htaccess` denies web access to it and
`.gitignore` keeps it out of git. Best of all: move it above the web root and
adjust the `require` path at the top of `api/lib.php`.

## 4. Upload the files

Deploy the whole repo to your web root so that `index.html` is at the site root
and `api/`, `static/`, `db/` sit alongside it. Confirm PHP runs (visiting
`https://YOURDOMAIN/api/auth/me.php` should return JSON like
`{"error":"not_authenticated","providers":[...]}`, **not** the PHP source).

The included `.htaccess` forces HTTPS and sets security headers
(HSTS, CSP, nosniff, frame-deny). It needs Apache with `mod_rewrite` + `mod_headers`
(standard on shared hosting). On nginx, replicate those headers + the HTTPS
redirect in your server config, and ensure `config.php` isn't served.

## 5. Signup notifications (Discord/Slack webhook)

- **Discord:** Server Settings → Integrations → Webhooks → New Webhook → copy URL.
- **Slack:** create an Incoming Webhook app → copy URL.

Paste it into `approval_webhook_url`. When a new person signs in and lands in the
pending queue, the server posts a short alert there (fire-and-forget — a slow or
failed webhook never blocks login).

## 6. First run

1. Visit the site → login gate → sign in with the account you listed in
   `admin_identities`. You're auto-approved as **admin**.
2. When a friend signs in, they see an **Awaiting approval** screen and you get a
   webhook ping. Open **Admin** (rail or sheet menu) → **Approve**. Their screen
   unlocks automatically (it polls every 30s).
3. Approved users' characters now save to the server and sync across devices.

---

## Local development

You can run the whole thing locally with PHP's built-in server + a local MySQL:

```
php -S localhost:8000 -t .
```

Register throwaway OAuth apps whose callback is
`http://localhost:8000/api/auth/callback.php`, set `base_url` to
`http://localhost:8000`, and set `session.cookie_secure` to `false` (http). Then
run through the verification checklist in the plan.

## Security notes (already built in)

- All character queries are scoped to the session user (no cross-account access
  by guessing a slug).
- OAuth uses a one-time `state`, TLS-verified token exchange, and **requires a
  verified email**; provider access tokens are never stored.
- Sessions: id regenerated on login, strict mode, Secure/HttpOnly/SameSite=Lax,
  idle + absolute timeouts.
- Mutations require a CSRF token; request bodies are size-capped; the `slug` is
  re-validated server-side.
- Signing out wipes that account's cached characters from the browser (safe on
  shared computers).

## Notes / limits

- **Conflicts** are last-write-wins by edit time — editing the same character on
  two devices at once can lose the older edit. Fine for normal play.
- **Existing local characters** (made before you signed in) stay in the browser's
  local namespace; sign-in starts a fresh per-account cache. Use **Export/Import
  JSON** to move an old local character into your account.
