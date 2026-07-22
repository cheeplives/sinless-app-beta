// register-sw.js — service worker registration. Externalised from an inline
// <body> script so the page can ship a strict Content-Security-Policy.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline install is best-effort */ });
}
