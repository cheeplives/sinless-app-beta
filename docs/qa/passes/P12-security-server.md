# P12 — Server-side security (CHECKLIST ONLY — DO NOT RUN UNPROMPTED)

> **Do not execute any case in this document without the owner explicitly asking
> for this pass to be run, in this session.**
>
> Every case here touches the **live deployed site** at
> `https://www.discreteinfinity.com/sinless/` — real accounts, real data, real
> logs. Several require signing in as two different people. Probing a live host
> is not something to do because a test document exists.
>
> If you reached this file by working through the pass list in order: **stop and
> mark the whole pass BLOCKED** with the reason "not authorised this session".
> That is the correct outcome, not a failure.

**Effort when authorised:** 20 min. **Fixture:** none.

The backend is optional. With no `/api` present — GitHub Pages, a local
`http.server` — the app runs local-only and none of this applies. A live
penetration test was done on 2026-07-23 and its findings fixed; this pass
re-verifies that surface rather than exploring for new ground.

## Before running anything

1. Confirm the owner asked for it, in this session, naming this pass.
2. Confirm the target host with them. Never point these at a host they did not
   name.
3. Read-only checks (§1) are safe. **Sections 2 and 3 require two real accounts
   and involve authenticated requests — get explicit approval for those
   separately.**
4. Never attempt to bypass a control that fails. Record it and stop.

---

## §1 — Read-only surface checks

These are unauthenticated GETs. They confirm nothing is exposed that should not
be. Substitute the host the owner named.

### P12-001: The git directory is not served
- **Check:**

      curl -sI https://HOST/sinless/.git/HEAD | head -1

- **Expected:** `404`. Anything else means the repository is downloadable,
  which exposes the full source and history.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-002: The config file is denied
- **Check:**

      curl -sI https://HOST/sinless/api/config.php | head -1

- **Expected:** `403` or `404` — never `200`, and never PHP source in the body.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-003: The API returns JSON, not source
- **Check:**

      curl -s https://HOST/sinless/api/auth/me.php | head -c 200

- **Expected:** a JSON body. If you see `<?php`, PHP is not executing and every
  secret in `config.php` is readable.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-004: Security headers and CSP are present
- **Check:**

      curl -sI https://HOST/sinless/ | grep -iE "content-security-policy|strict-transport|x-content-type|x-frame|referrer-policy"

- **Expected:** a CSP with `script-src 'self'` and **no** `'unsafe-inline'` in
  `script-src`; plus HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and a Referrer-Policy.
- **Note:** `style-src` legitimately carries `'unsafe-inline'` (the `el()` helper
  sets inline styles) and `img-src` carries `data:` (character portraits).
  Neither is a finding.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-005: API responses are not cacheable
- **Check:**

      curl -sI https://HOST/sinless/api/auth/me.php | grep -i cache-control

- **Expected:** `no-store`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-006: Unauthenticated requests are refused
- **Check:**

      curl -s -o /dev/null -w "%{http_code}\n" https://HOST/sinless/api/characters.php

- **Expected:** `401` or `403`, never `200` with data.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-007: Directory listing is off
- **Check:**

      curl -s -o /dev/null -w "%{http_code}\n" https://HOST/sinless/api/

- **Expected:** `403` or `404`, never an index of files.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## §2 — Authenticated checks (separate approval required)

Requires being signed in as an approved member. Use the browser's own session;
do not attempt to forge one.

### P12-008: Mutations require the CSRF header
- **Steps:** in the browser console on the live site, issue a `PUT` to
  `api/characters.php?slug=<one of your own>` **without** the `X-CSRF-Token`
  header.
- **Expected:** rejected — `403`. A `200` means the synchroniser token is not
  being enforced.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-009: The shared gallery leaks no identifiers
- **Check:** `GET api/characters.php?public=1` and inspect one row.
- **Expected:** exactly `id`, `name`, `owner` (a display name) and `updated_at`.
  There must be no `email`, `provider`, `provider_user_id`, `avatar_url`,
  `user_id`, or `data`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-010: A private character is not fetchable by id
- **Check:** take the id of one of your **private** characters and request
  `api/characters.php?public_id=<id>`.
- **Expected:** not found. The query is gated on `is_public = 1` in SQL, not
  filtered client-side.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-011: Saving cannot publish a character
- **Check:** `PUT` a character whose `is_public` is 0, with `is_public: 1` in the
  body, then re-read it.
- **Expected:** still private. `PUT` deliberately does not touch `is_public` —
  only the explicit `POST ?slug` toggle does.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-012: Read endpoints are unlimited
- **Check:** issue ~50 rapid `GET api/characters.php?public=1` requests.
- **Expected:** none are rate limited. Limits cover `login`, `callback`,
  authenticated `write` and `admin` only.
- **Note:** JC-015, ruled **A — acceptable**: every reader is an approved member
  already, so unlimited read is fine and nothing changed. Worth revisiting only
  if signup stops being approval-gated, which is the assumption it rests on.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-017: Deleting a shared character is refused by the server
- **Check:** share one of your own characters (☰ menu → Sharing), then issue
  `DELETE api/characters.php?slug=<that slug>` with a valid `X-CSRF-Token`.
  Unshare it and repeat.
- **Expected:** while shared, `409` with `{"error":"shared"}` and the row still
  present on a re-read. Once private, `200` with `{"deleted":true}`.
- **Note:** The client blocks this before it ever leaves the browser, so a
  request only gets here from a stale tab, a client whose sharing flags never
  hydrated, or a hand-rolled call. This is the check that makes the copy
  protection real rather than cosmetic: a member cannot publish a character to
  the gallery and then delete the record other members are reading from.

  A `200` here is a **FAIL** even though the UI would never send it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## §3 — Two-account isolation (separate approval required)

Needs two approved accounts. This is the highest-value check on the server and
also the most intrusive. **Do not improvise it.**

### P12-013: One member cannot read another's private characters
- **Steps:** as account A, note a private character's slug and id. Sign in as
  account B and request it both by `?slug=` and by `?public_id=`.
- **Expected:** both refused. Every private query is scoped `WHERE user_id = ?`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-014: One member cannot write to another's slot
- **Steps:** as account B, `PUT` to a slug that belongs to account A.
- **Expected:** account B gets its **own** character at that slug — the unique
  key is `(user_id, slug)`, so the two never collide. Account A's copy must be
  untouched. Verify by re-reading as A.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-015: Unpublishing a homebrew pack cuts off subscribers
- **Steps:** as A, publish a pack; as B, subscribe; as A, unpublish; as B,
  re-fetch subscriptions.
- **Expected:** the pack stops being served — the subscription join requires
  `is_public = 1`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P12-016: A non-admin cannot reach the admin endpoint
- **Check:** as a non-admin account, `GET api/admin/users.php`.
- **Expected:** `403`. Emails and provider ids appear only behind
  `require_admin()`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

If you ran only §1, say so in the findings file and mark §2 and §3 **BLOCKED —
not authorised**. Partial coverage honestly recorded is worth far more than a
pass someone assumed was complete.

Related reading: `docs/DEPLOY.md` (deployment verification checklist) and
`docs/HOSTING.md` (the security notes this pass re-verifies).
