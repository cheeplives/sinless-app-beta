# Cross-browser tests

Automated checks that the app behaves the same in **Chromium** (Chrome, Edge),
**Firefox** (Gecko) and **WebKit** (Safari, and every browser on iPhone/iPad),
on desktop and phone-sized screens. They complement the manual QA passes in
`docs/qa/`; they don't replace them.

They run on GitHub Actions on every push and pull request
(`.github/workflows/browser-tests.yml`), one job per project:

| Project | Engine | Emulates |
|---|---|---|
| `chromium` | Chromium | desktop Chrome / Edge |
| `firefox` | Gecko | desktop Firefox |
| `webkit` | WebKit | desktop Safari |
| `mobile-safari` | WebKit | iPhone 13 (touch, 390px) |
| `mobile-chrome` | Chromium | Pixel 7 (touch, 412px) |

A failed job uploads a `report-<project>` artifact with the HTML report,
screenshots and a trace (open with `npx playwright show-trace <trace.zip>`).

## What's covered

- **smoke**: every QA fixture opens and every tab of its view renders with no
  script or console error. The hostile-payload fixture must never run a probe.
- **rules-parity**: `RULES.calculate` gives exactly the same result in the
  browser as under Node, for every fixture.
- **files**: Export JSON, Export Markdown and homebrew pack export really
  download (read back and checked); Import JSON round-trips.
- **storage**: a chargen draft survives leaving the page, with `pagehide`
  alone (iOS never sends `beforeunload`); the 7-day-deletion tip appears on
  WebKit only, and once; iOS text fields are 16px.
- **offline**: after one visit the service worker serves the app with the
  network off.

Fixtures are loaded from `docs/qa/fixtures/`. A new fixture there is picked up
by the smoke and parity tests automatically.

## Running locally (needs Node 18+ and Python 3)

```sh
cd tests
npm ci
npx playwright install --with-deps     # first time: downloads the three browsers
npx playwright test                    # all projects
npx playwright test --project=firefox  # one engine
npx playwright show-report             # after a failure
```

The config starts its own `python3 -m http.server` on port 8754 for the repo
root. (On Windows, if `python3` isn't on PATH, start
`python -m http.server 8754` from the repo root first; a server already on that
port is reused.)

None of this is deployed: `.htaccess` returns 404 for `tests/`, and
`node_modules/`, `test-results/` and `playwright-report/` are git-ignored.
