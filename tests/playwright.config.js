// Cross-browser test run for the Sinless app. See tests/README.md.
//
// One suite, five engines/form factors. The point is not to re-test the rules
// (the QA pass docs do that) but to catch anything that behaves differently
// between Chromium, Firefox (Gecko) and Safari (WebKit): parse errors, CSS or
// DOM APIs one engine lacks, downloads, storage, the service worker.
const { defineConfig, devices } = require("@playwright/test");

const PORT = 8754;

module.exports = defineConfig({
  testDir: "./browser",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,                       // a failure is a finding, not a flake to paper over
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}/`,
    // Off by default: a test that wants the service worker opts in. Left on,
    // a cached copy from an earlier test could stand in for the file under test.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 13"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    // The app is static files; serve the repo root exactly as production does.
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ..`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "ignore",            // http.server logs every request there
  },
});
