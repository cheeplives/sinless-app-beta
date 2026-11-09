/* kit.js — small shared UI kit, written to be identical in Campaign Chronicle
 * and Sinless: the DOM builder, toasts, tooltips that also work on touch
 * screens, and in-page confirm/prompt/alert dialogs that replace the browser's
 * blocking confirm(), prompt() and alert().
 *
 * Plain script, no build step. Everything hangs off the KIT global (like
 * Sinless's RULES / STORAGE / SYNC) so it never clashes with an app's own names.
 * Styles live in each app's style.css under "kit" (#toast, .tip, #tipbox,
 * dialog.kit-dialog), using the shared token names.
 * All text goes in through textContent, never innerHTML. */
'use strict';

const KIT = (() => {
  // ------------------------------------------------------------ DOM
  /** el('div', { class: 'card', onclick: fn }, 'text', childNode, [more, kids]).
   * null / undefined / false attributes and children are skipped. */
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = !!v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  const $ = (s, root = document) => root.querySelector(s);

  // ------------------------------------------------------------ toast
  /** A short message at the bottom of the screen. bad = true styles it as an error. */
  function toast(msg, bad) {
    let t = $('#toast');
    if (!t) document.body.append(t = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }));
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ''), 3200);
  }

  // ------------------------------------------------------------ tooltips
  // Any element with data-tip shows a tooltip on hover (and on keyboard focus).
  // Touch screens can't hover, so there a tap opens it instead (a second tap
  // closes it), except on links and controls, where a tap does what it always
  // did. The "?" icons from tip() open on tap everywhere. A native title
  // attribute never shows on touch. One floating box, kept inside the viewport.
  /** A small "?" icon that explains the thing next to it. */
  function tip(text) {
    return el('span', { class: 'tip', tabindex: 0, role: 'button', 'aria-label': text, 'data-tip': text,
      onclick: e => { e.preventDefault(); e.stopPropagation(); showTip(e.currentTarget); },
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTip(e.currentTarget); } } }, '?');
  }
  /** Give any element a tooltip. */
  const tipped = (node, text) => { node.dataset.tip = text; return node; };
  let tipBox = null, tipEl = null;
  function showTip(target) {
    if (!tipBox) document.body.append(tipBox = el('div', { id: 'tipbox', role: 'tooltip' }));
    tipEl = target;
    // data-tip-img adds a picture above the text; the box is placed again once it has loaded and has its size.
    const src = target.dataset.tipImg;
    tipBox.replaceChildren(...(src ? [el('img', { src, alt: '', referrerpolicy: 'no-referrer', onload: () => { if (tipEl === target) placeTip(target); } }), el('span', {}, target.dataset.tip)] : [target.dataset.tip]));
    tipBox.className = 'show' + (src ? ' with-img' : '');
    placeTip(target);
  }
  function placeTip(target) {
    const r = target.getBoundingClientRect(), bw = tipBox.offsetWidth, bh = tipBox.offsetHeight;
    const x = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, innerWidth - bw - 8));
    const y = r.bottom + 8 + bh > innerHeight - 8 && r.top - bh - 8 > 0 ? r.top - bh - 8 : r.bottom + 8;
    tipBox.style.left = `${x}px`; tipBox.style.top = `${y}px`;
  }
  function hideTip() { tipEl = null; if (tipBox) tipBox.className = ''; }
  // an open menu's button says nothing more: its tooltip would sit over the menu
  const tipTarget = e => { const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null; return t && t.matches('.kit-menu[open] > summary') ? null : t; };
  const canHover = matchMedia('(hover: hover)');
  const INTERACTIVE = 'a[href], button, input, select, textarea, label, summary, [role=button]';
  document.addEventListener('mouseover', e => {
    if (!canHover.matches) return; // touch: tapped open instead, below (pointerup)
    const t = tipTarget(e);
    if (t) { if (t !== tipEl) showTip(t); } else if (tipEl) hideTip();
  });
  document.addEventListener('focusin', e => { const t = tipTarget(e); if (t && t.matches(':focus-visible')) showTip(t); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('click', e => { if (!tipTarget(e)) hideTip(); });
  // Touch and pen work from pointer events rather than click: iPad Safari sends no click for a tap
  // on plain text or background, and a touch-screen laptop reports it can hover even when tapped.
  document.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse' && !tipTarget(e)) hideTip(); });
  document.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse') return;
    const t = tipTarget(e);
    if (t && !t.closest(INTERACTIVE)) { if (t === tipEl) hideTip(); else showTip(t); } else if (t) hideTip();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', hideTip, true);

  // ------------------------------------------------------------ dialogs
  /** One modal <dialog>. Resolves with the value of the button pressed (the
   * typed text for a prompt), or null when cancelled or dismissed with Escape.
   * List the default button first: Enter submits with it, and the CSS shows
   * the row reversed so it still sits on the right. */
  function dialog({ title, message, buttons, input }) {
    return new Promise(resolve => {
      hideTip();
      const field = input ? el('input', { class: 'kit-dialog-input', value: input.value || '', placeholder: input.placeholder || '', 'aria-label': title || message }) : null;
      const d = el('dialog', { class: 'kit-dialog', 'aria-label': title || message },
        el('form', { method: 'dialog' },
          title ? el('h3', {}, title) : null,
          el('p', { class: 'kit-dialog-msg' }, message),
          field,
          el('div', { class: 'kit-dialog-actions' }, buttons.map(b =>
            el('button', { value: b.value, class: b.cls || '', autofocus: b.focus || null, type: 'submit' }, b.label)))));
      d.addEventListener('close', () => {
        const v = d.returnValue;
        d.remove();
        resolve(v === '' || v === 'cancel' ? null : (field ? field.value : v));
      });
      d.addEventListener('cancel', () => { d.returnValue = 'cancel'; });
      document.body.append(d);
      d.showModal();
      if (field) { field.focus(); field.select(); }
    });
  }
  /** await KIT.confirmDialog('Delete it?', { ok: 'Delete', danger: true }) → true / false */
  async function confirmDialog(message, { title = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
    const v = await dialog({ title, message, buttons: [
      { value: 'ok', label: ok, cls: danger ? 'danger' : 'primary', focus: !danger },
      { value: 'cancel', label: cancel, focus: danger },
    ] });
    return v === 'ok';
  }
  /** await KIT.promptDialog('Name this pack:', { value: 'My Homebrew' }) → the text, or null if cancelled */
  function promptDialog(message, { title = '', value = '', placeholder = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
    return dialog({ title, message, input: { value, placeholder }, buttons: [
      { value: 'ok', label: ok, cls: danger ? 'danger' : 'primary' },
      { value: 'cancel', label: cancel },
    ] });
  }
  /** await KIT.alertDialog('Saved.') — a message that needs reading, not a toast. */
  async function alertDialog(message, { title = '', ok = 'OK' } = {}) {
    await dialog({ title, message, buttons: [{ value: 'ok', label: ok, cls: 'primary', focus: true }] });
  }

  // ------------------------------------------------------------ menu
  /** A small drop-down of actions behind one button (⋯ or ⚙): the things done now and then, kept off the page. The
   * everyday action (Edit, Save, Approve) stays out beside it; the rest, and always Delete, wait inside.
   * KIT.menu({ label: '⋯', ariaLabel: 'More for Waterdeep', tip, items: [button, el('hr'), button], cls, listCls, align: 'right' })
   * returns a <details>. Items that are null or false are skipped, and an <hr> with nothing on one side of it goes too,
   * so a caller lists its items conditionally. It closes when an item is picked, on a click anywhere else, when focus
   * moves out of it (Tab) and on Escape (focus goes back to its button); the arrow keys, Home and End walk its items, and
   * an arrow on the closed button opens it; a list that would run off the edge of the screen opens the other way. Its
   * document listeners exist only while it is open, so nothing is left behind when the page changes. */
  let menuSeq = 0;
  function menu({ label = '⋯', ariaLabel = '', tip: tipText = '', items = [], cls = '', listCls = '', align = 'right' } = {}) {
    // null, false and a divider with nothing on one side of it are dropped, so callers can list items conditionally
    const kids = items.flat(Infinity).filter(Boolean);
    const isHr = n => n instanceof Element && n.tagName === 'HR';
    const clean = [];
    for (const n of kids) { if (isHr(n) && (!clean.length || isHr(clean[clean.length - 1]))) continue; clean.push(n); }
    while (clean.length && isHr(clean[clean.length - 1])) clean.pop();
    // The items keep their own roles (buttons, links, a checkbox): the list is a disclosure of ordinary controls, which a
    // screen reader walks as such, rather than an ARIA menu, whose menuitems would need their own key handling everywhere.
    const id = `kit-menu-${++menuSeq}`;
    const summary = el('summary', { class: 'button small', 'aria-label': ariaLabel || null, 'data-tip': tipText || null, 'aria-expanded': 'false', 'aria-controls': id }, label);
    const list = el('div', { id, class: `kit-menu-list ${listCls}`.trim(), role: 'group' }, clean);
    const d = el('details', { class: `kit-menu kit-menu-${align} ${cls}`.trim() }, summary, list);
    // the items the arrow keys walk: anything in the list that takes focus (buttons, links, a checkbox in a label)
    const focusables = () => [...list.querySelectorAll('button, a[href], input, select, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && !x.closest('[hidden]') && x.offsetParent !== null);
    const focusAt = i => { const f = focusables(); if (f.length) f[(i + f.length) % f.length].focus(); };
    const outside = ev => { if (!d.contains(ev.target)) d.open = false; };
    const keys = ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); d.open = false; summary.focus(); return; }
      if (!d.contains(ev.target)) return;
      const f = focusables(), at = f.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); focusAt(at < 0 ? 0 : at + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); focusAt(at < 0 ? -1 : at - 1); }
      else if (ev.key === 'Home') { ev.preventDefault(); focusAt(0); }
      else if (ev.key === 'End') { ev.preventDefault(); focusAt(-1); }
    };
    // Tab out of the menu closes it (only when focus lands somewhere else: a tap on iPad Safari gives a button no focus,
    // so a bare blur must not close the menu before the tap's click reaches the item)
    const away = ev => { if (ev.relatedTarget && !d.contains(ev.relatedTarget)) d.open = false; };
    // keep the list on screen: a right-aligned list that would run off the left edge opens to the right instead, and the other way round
    const place = () => {
      d.classList.remove('kit-menu-flip');
      const r = list.getBoundingClientRect();
      if ((align === 'right' && r.left < 4 && r.right + (4 - r.left) <= innerWidth) || (align === 'left' && r.right > innerWidth - 4 && r.left - (r.right - innerWidth + 4) >= 0)) d.classList.add('kit-menu-flip');
    };
    d.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', String(d.open));
      if (d.open) { if (tipEl === summary) hideTip(); place(); document.addEventListener('click', outside, true); document.addEventListener('keydown', keys, true); d.addEventListener('focusout', away); }
      else { document.removeEventListener('click', outside, true); document.removeEventListener('keydown', keys, true); d.removeEventListener('focusout', away); }
    });
    // Arrow down on the closed button opens the menu on its first item (Enter and Space open it as a <summary> does)
    summary.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); if (!d.open) d.open = true; focusAt(ev.key === 'ArrowDown' ? 0 : -1); }
    });
    list.addEventListener('click', ev => { if (ev.target.closest('button, a')) d.open = false; });
    return d;
  }

  return { el, $, toast, tip, tipped, showTip, hideTip, dialog, confirmDialog, promptDialog, alertDialog, menu };
})();
