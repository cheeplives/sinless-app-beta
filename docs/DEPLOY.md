# Deploying to www.discreteinfinity.com/sinless (SSH + git)

Concrete runbook for a **subpath install** under a fixed document root
(`~/public_html/sinless`), deployed by cloning from GitHub over SSH and updated
with `git pull`. For OAuth app registration and the full config field reference,
see [HOSTING.md](HOSTING.md).

> **How the deploy flows:** nothing is pushed from your laptop to the server. The
> code is on GitHub; the server *pulls* from GitHub. So: push to GitHub (done) →
> `git pull` on the server.

> **Same origin:** the app **and** its `/api` must live on the same host. This
> install keeps both under `https://www.discreteinfinity.com/sinless/`. Don't
> split the static app onto GitHub Pages and the API onto the server — that
> breaks the cookie/CSRF model.

> **Canonical host:** everything is tied to `www.discreteinfinity.com`. If the
> apex `discreteinfinity.com` also serves the site, 301-redirect it to `www` so
> sessions and OAuth stay on one origin.

---

## Prerequisites

- HTTPS working on `www.discreteinfinity.com`.
- A MySQL database + user (from your host's control panel).
- PHP 7.4+ with `pdo_mysql` and `curl` — check on the server: `php -m | grep -Ei 'pdo_mysql|curl'`.
- OAuth app(s) registered (Google and/or GitHub) with the callback set **exactly** to:
  ```
  https://www.discreteinfinity.com/sinless/api/auth/callback.php
  ```

## One-time setup

**1. Clone into the subfolder** (git creates `sinless/`, so don't pre-make it):

```sh
cd ~/public_html
git clone https://github.com/cheeplives/sinless-app-beta.git sinless
cd sinless
```

**2. Create the config** (this file is gitignored — `git pull` never overwrites it):

```sh
cp api/config.example.php api/config.php
chmod 600 api/config.php
nano api/config.php
```

Set at minimum:
- `db` → your MySQL host / name / user / password
- `base_url` → `https://www.discreteinfinity.com/sinless`  *(no trailing slash)*
- `oauth.google` / `oauth.github` → client id + secret (blank a provider to hide its button)
- `admin_identities` → **your** email (or `github:<id>`) so your first login is auto-approved as admin
- `approval_webhook_url` → your Discord/Slack incoming webhook

> **Optional hardening — config above the web root.** Your home dir `~/` is not
> web-served, only `~/public_html` is. To keep the secret entirely out of the
> docroot: `mv api/config.php ~/sinless-config.php`, then edit the top of
> `api/lib.php` so `$__CONFIG_PATH` points at `getenv('HOME') . '/sinless-config.php'`
> (or an absolute path). `git pull` won't fight you because config.php is gone
> from the tree.

**3. Import the database schema** (idempotent — safe to re-run):

```sh
mysql -u YOUR_DB_USER -p YOUR_DB_NAME < db/schema.sql
```

**4. TLS / cookies.** Confirm the site loads over HTTPS. Leave
`session.cookie_secure => true` in config (it's the default).

**5. Web server config.**

- **Apache (cPanel-style hosts):** the bundled `.htaccess` already forces HTTPS
  and sets the security headers, denies `config.php`/SQL/docs, and 404s the
  `.git` directory. It needs `mod_rewrite`, `mod_headers`, `mod_alias`, and
  `AllowOverride All` for the directory (standard on shared hosting). Nothing
  else to do.

- **nginx:** `.htaccess` is **ignored**. Reproduce its protections in your server
  block (adjust the socket/root):

  ```nginx
  # inside server { } for www.discreteinfinity.com
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" always;

  location ~ /\.git      { return 404; }
  location ~ /config\.php$ { return 404; }
  location ~ \.(sql|md|py)$ { return 404; }

  location ~ ^/sinless/.*\.php$ {
    include fastcgi_params;
    fastcgi_pass unix:/run/php/php-fpm.sock;   # your PHP-FPM socket
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
  }
  ```

## Verify (the first real PHP syntax check)

From `~/public_html/sinless`:

```sh
# 1. Syntax-check the backend (never run on a real PHP before this).
find api -name '*.php' -print -exec php -l {} \;

# 2. The auth probe should return JSON, not PHP source or a 500.
curl -s https://www.discreteinfinity.com/sinless/api/auth/me.php
#   → {"error":"not_authenticated","providers":["google", ...]}

# 3. Confirm the repo + secrets are NOT downloadable.
curl -sI https://www.discreteinfinity.com/sinless/.git/HEAD        # → 404
curl -sI https://www.discreteinfinity.com/sinless/api/config.php   # → 403/404 (never contents)
```

Then in a browser at `https://www.discreteinfinity.com/sinless/`:
- Sign in with your `admin_identities` account → the app loads (you're admin).
- Have a second account sign in → they get the **Awaiting approval** screen and
  you get a Discord/Slack ping → open **Admin** → **Approve** → their screen
  unlocks automatically.
- Create a character → a row appears in the `characters` table for your user.
- Spot-check isolation: signed in as the second account, you should see none of
  the first account's characters.

## Updates (ongoing)

```sh
cd ~/public_html/sinless
git pull --ff-only        # or ./deploy.sh  (pull + php -l)
```

- `config.php` is untouched (gitignored).
- App JS/CSS is served **network-first**, so browsers pick up changes on the next
  load. Bump `CACHE_VERSION` in `sw.js` when you want **offline** PWA clients
  force-refreshed (already the project habit).
- If a future change ships a new `db/*.sql`, run it once like step 3.

## Notes

- **Deploying from beta:** the auth backend currently lives on
  `sinless-app-beta`. Once it's proven here, merge beta → the main
  `sinless-app` repo; if you want the server to track that instead, run
  `git remote set-url origin https://github.com/cheeplives/sinless-app.git` in
  the deploy dir (or re-clone).
- **Level-up (optional):** push-to-deploy via a bare repo + `post-receive` hook,
  or a GitHub Actions job that SSHes in and pulls on every push. `git pull` is
  the simplest and is fine to start.
