// theme-init.js — applied before first paint so there's no flash of the wrong
// theme. Externalised from an inline <head> script so the page can ship a strict
// Content-Security-Policy (no 'unsafe-inline' for scripts). Loaded synchronously
// in <head>, before the stylesheet, so data-theme is set before layout.
(function () {
  try {
    var t = localStorage.getItem("sinless:theme");
    if (!t) t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* localStorage unavailable — default dark styling still applies */ }
})();
