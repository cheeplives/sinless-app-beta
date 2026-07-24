// theme-init.js — applied before first paint so there's no flash of the wrong
// theme. Externalised from an inline <head> script so the page can ship a strict
// Content-Security-Policy (no 'unsafe-inline' for scripts). Loaded synchronously
// in <head>, before the stylesheet, so data-theme is set before layout.
(function () {
  try {
    var t = localStorage.getItem("sinless:theme");
    var sc = localStorage.getItem("sinless:scheme");
    // Migrate the retired three-way value: "azure" was a mode, now it's a scheme.
    if (t === "azure") { sc = sc || "azure"; t = "dark"; }
    if (!t) t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.setAttribute("data-scheme", sc || "default");
  } catch (e) { /* localStorage unavailable — default dark styling still applies */ }
})();
