// controller.js — körs inuti varje deck (laddas först i <head>).
//
// Decket körs med sina egna skript, men kontrollern bestämmer vilken slide som
// syns: den hittar slide-elementen, tar över tangentbordet så decket inte
// bläddrar själv, och visar en slide i taget i en ruta av slidens egen storlek
// (t.ex. 1600×900). Appen skalar sedan rutan utifrån.
//
// Lägen (?hp=…): main (normalvyn, redigerbar), audience (publik, med ljud),
// current/next (presentatörsvyn), thumb (miniatyrer: inga animationer).

(function () {
  'use strict';
  if (window.__hp) return;

  const params = new URLSearchParams(location.search);
  // Adressen decket laddades med. Decket kan ändra sin adress (history.replaceState)
  // innan vi är klara, men appen känner igen laddningen på den här.
  const BOOT_HREF = location.href;
  const MODE = params.get('hp') || 'main';
  const MUTED = MODE !== 'audience';
  const STILL = MODE === 'thumb' || MODE === 'next';

  const SELECTORS = [
    'deck-stage > section',
    '.reveal .slides > section',
    '.slides > section',
    'section.slide',
    'div.slide',
    '.slide',
    '[data-slide]',
    'body > section',
    'main > section',
    '.step',
    'body > article',
    'section', // sista utvägen: föräldern med flest <section>-barn blir scenen
  ];
  const ACTIVE_CANDIDATES = ['on', 'active', 'current', 'present', 'visible', 'is-active', 'is-current', 'shown', 'show', 'selected'];
  const NOTE_SELECTOR = 'aside.notes, .speaker-notes, [data-notes], aside[class*="note"]';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'BASE']);

  const hp = window.__hp = {
    mode: MODE,
    ready: false,
    index: -1,
    slides: [],
    size: { w: 1920, h: 1080 },
    activeClasses: [],
    strategy: '',
    whole: false,
    edit: false,
    editing: false,
    scale: 1,
  };

  /* ------------------------------------------------------------ meddelanden */

  // Decket har en egen origin. Appen (hpres://app) är vår förälder och vi pratar
  // bara via postMessage. Kommandon tas bara emot från föräldern på appens origin.
  const APP_ORIGIN = 'hpres://app';
  const host = window.parent !== window ? window.parent : null;
  const emit = (name, data) => { if (host) host.postMessage({ hp: 1, type: 'event', name, data }, APP_ORIGIN); };

  const CALLS = {
    show: (i) => hp.show(i),
    setScale: (s) => hp.setScale(s),
    setEdit: (on) => hp.setEdit(on),
    commit: () => hp.commit(),
    deselect: () => hp.deselect(),
    selectParent: () => hp.selectParent(),
    editSelected: () => hp.editSelected(),
    removeById: (id) => hp.removeById(id),
    execUndo: (redo) => hp.execUndo(redo),
    cancelEdit: (id) => hp.cancelEdit(id),
    info: () => hp.info(),
  };

  window.addEventListener('message', (e) => {
    if (!host || e.source !== host || e.origin !== APP_ORIGIN) return;
    const m = e.data;
    if (!m || m.hp !== 1 || m.type !== 'call' || !Object.prototype.hasOwnProperty.call(CALLS, m.method)) return;
    e.stopImmediatePropagation();
    let result, error;
    try { result = CALLS[m.method].apply(null, Array.isArray(m.args) ? m.args : []); }
    catch (err) { error = String(err && err.message || err); }
    const reply = (r) => host.postMessage({ hp: 1, type: 'reply', id: m.id, result: r === undefined ? null : r, error }, APP_ORIGIN);
    if (result && typeof result.then === 'function') result.then(reply, (err) => { error = String(err); reply(null); });
    else reply(result);
  }, true);

  /* --------------------------------------------------------------- tangenter */

  const pick = (e) => ({ key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat });
  const NAV_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', ' ', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Enter', 'Tab']);

  // Fält där man skriver text. Kryssrutor, radioknappar och reglage räknas inte: där ska
  // piltangenter och en presentationsklicker fortfarande byta slide.
  const ownField = (t) => t && t.nodeType === 1 && !t.closest('[data-hp-ui]')
    && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
      || (t.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|color|file|image)$/i.test(t.type)));

  ['keydown', 'keyup', 'keypress'].forEach((type) => {
    window.addEventListener(type, (e) => {
      // Skriver du i ett fält som decket själv har (ett formulär, en kodruta) får decket
      // tangenterna som vanligt. Esc tar dig ändå ut ur fältet.
      if (!hp.editing && ownField(e.target)) {
        if (e.key !== 'Escape') return;
        // Esc lämnar fältet (men avslutar inte presentationen).
        e.preventDefault(); e.stopImmediatePropagation();
        if (type === 'keydown') e.target.blur();
        return;
      }
      if (hp.editing) {
        if (type === 'keydown' && editKey(e)) { e.preventDefault(); }
        e.stopImmediatePropagation(); // decket får inte se tangenterna, men texten skrivs ändå
        return;
      }
      e.stopImmediatePropagation();
      if (type !== 'keydown') return;
      if (hp.edit && selectionKey(e)) { e.preventDefault(); return; }
      if (NAV_KEYS.has(e.key) && !e.metaKey && !e.ctrlKey) e.preventDefault();
      emit('key', pick(e));
    }, true);
  });

  /* ------------------------------------------------------------------- media */

  if (MUTED) {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.muted = true;
      if (STILL) { return Promise.resolve(); }
      return play.apply(this, arguments);
    };
    document.addEventListener('play', (e) => {
      const m = e.target;
      if (!(m instanceof HTMLMediaElement)) return;
      m.muted = true;
      if (STILL) m.pause();
    }, true);
  }

  function mediaIn(el) { return el ? Array.from(el.querySelectorAll('video, audio')) : []; }

  function onSlideMedia(prev, cur) {
    mediaIn(prev).forEach((m) => { try { m.pause(); m.currentTime = 0; } catch (_) {} });
    mediaIn(cur).forEach((m) => {
      if (MUTED) m.muted = true;
      if (STILL) { m.autoplay = false; try { m.pause(); } catch (_) {} return; }
      if (m.hasAttribute('autoplay')) { const p = m.play(); if (p && p.catch) p.catch(() => {}); }
    });
  }

  /* -------------------------------------------------------------- uppdelning */

  function detect() {
    // Appen skickar regeln som hittade slidesen förra gången (samma fil). Har decket bara
    // en slide kvar, t.ex. efter att du tagit bort de andra, gäller den regeln ändå.
    const prev = params.get('hpsel');
    if (prev && (SELECTORS.includes(prev) || /^[a-z][\w-]*\.[\w-]+$/.test(prev))) {
      const one = Array.from(document.querySelectorAll(prev)).filter((el) => !el.closest('template'));
      if (one.length === 1) return { els: one, strategy: prev };
    }
    for (const sel of SELECTORS) {
      let els = Array.from(document.querySelectorAll(sel)).filter((el) => !el.closest('template'));
      if (els.length < 2) continue;

      // Decket kan ha klonat slides (egen miniatyrvy). Föredra källans element.
      const withId = els.filter((el) => el.hasAttribute('data-hp-id'));
      if (withId.length >= 2) els = withId;

      // Ta bort kandidater som ligger inuti andra kandidater.
      const set = new Set(els);
      els = els.filter((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });

      // Den förälder som har flest slides som barn är "scenen".
      const groups = new Map();
      els.forEach((el) => { const g = groups.get(el.parentElement) || []; g.push(el); groups.set(el.parentElement, g); });
      let best = [];
      groups.forEach((g) => { if (g.length > best.length) best = g; });
      if (best.length >= 2 && best.length >= els.length * 0.5) els = best;
      else {
        const seen = new Set();
        els = els.filter((el) => { const id = el.getAttribute('data-hp-id'); if (!id) return true; if (seen.has(id)) return false; seen.add(id); return true; });
      }
      if (els.length < 2) continue;

      if (sel.includes('reveal')) {
        els = els.flatMap((el) => { const nested = Array.from(el.children).filter((c) => c.tagName === 'SECTION'); return nested.length ? nested : [el]; });
      }
      return { els, strategy: sel };
    }
    return detectGeneric() || { els: [document.body], strategy: 'hela sidan', whole: true };
  }

  // Sista utväg: syskon med samma tagg och klass som antingen är stora eller visas
  // en i taget (resten dolda), t.ex. <div class="page"> eller <article class="frame">.
  function detectGeneric() {
    let best = null;
    for (const parent of document.querySelectorAll('body, body *')) {
      if (SKIP_TAGS.has(parent.tagName) || parent.closest('template, svg')) continue;
      const groups = new Map();
      for (const k of parent.children) {
        const cls = k.classList[0];
        if (!cls || SKIP_TAGS.has(k.tagName)) continue;
        const key = k.tagName.toLowerCase() + '.' + cls;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(k);
      }
      groups.forEach((g, key) => {
        if (g.length < 2 || (best && g.length <= best.els.length)) return;
        const hidden = g.filter(isHidden);
        const big = g.filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 300 && r.height >= 200; });
        const oneAtATime = hidden.length >= g.length - 1 && hidden.length > 0;
        if (oneAtATime || big.length === g.length) best = { els: g, strategy: key };
      });
    }
    return best;
  }

  function isHidden(el) {
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0;
  }

  // Övergångar (t.ex. opacity .4s) gör att en slide fortfarande ser dold ut direkt
  // efter att klassen lagts till. Stäng av dem medan vi mäter.
  function withoutMotion(fn) {
    const s = document.createElement('style');
    s.setAttribute('data-hp-ui-style', '');
    s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    (document.head || document.documentElement).appendChild(s);
    try { return fn(); } finally { s.remove(); }
  }

  function detectActiveClasses(els) {
    return withoutMotion(() => detectActiveClassesNow(els));
  }

  function detectActiveClassesNow(els) {
    const hidden = els.find(isHidden);
    if (!hidden) return [];
    // Klasser som den synliga sliden har men den dolda saknar är bäst att prova först.
    const visible = els.find((el) => !isHidden(el));
    const order = [];
    if (visible) visible.classList.forEach((c) => { if (!hidden.classList.contains(c) && ACTIVE_CANDIDATES.includes(c)) order.push(c); });
    ACTIVE_CANDIDATES.forEach((c) => { if (!order.includes(c)) order.push(c); });
    const ariaWas = hidden.getAttribute('aria-hidden');
    hidden.setAttribute('aria-hidden', 'false');
    try {
      for (const cls of order) {
        if (hidden.classList.contains(cls)) continue;
        hidden.classList.add(cls);
        const ok = !isHidden(hidden);
        hidden.classList.remove(cls);
        if (ok) return [cls];
      }
    } finally {
      if (ariaWas === null) hidden.removeAttribute('aria-hidden'); else hidden.setAttribute('aria-hidden', ariaWas);
    }
    return [];
  }

  function measure(els) {
    const ds = document.querySelector('deck-stage[width][height]');
    if (ds) {
      const w = parseInt(ds.getAttribute('width'), 10), h = parseInt(ds.getAttribute('height'), 10);
      if (w > 100 && h > 100) return { w, h };
    }
    const meta = document.querySelector('meta[name="slide-size"], meta[name="hp:size"]');
    if (meta) {
      const m = /(\d+)\s*[x×]\s*(\d+)/.exec(meta.content || '');
      if (m) return { w: +m[1], h: +m[2] };
    }
    const tryEl = (el) => {
      const w = el.offsetWidth, h = el.offsetHeight;
      if (w < 320 || h < 180) return null;
      const ratio = h / w;
      if (ratio < 0.3 || ratio > 1.6) return null;
      if (Math.abs(w - innerWidth) <= 2 && Math.abs(h - innerHeight) <= 2) return { w: 1920, h: 1080, responsive: true };
      return { w, h };
    };
    for (const el of els.slice(0, 6)) {
      if (isHidden(el)) continue;
      const r = tryEl(el);
      if (r) return r;
    }
    // Ingen synlig — tvinga fram den första och mät.
    const el = els[0];
    const prev = el.getAttribute('style');
    hp.activeClasses.forEach((c) => el.classList.add(c));
    if (getComputedStyle(el).display === 'none') el.style.setProperty('display', 'block', 'important');
    const r = tryEl(el);
    if (prev === null) el.removeAttribute('style'); else el.setAttribute('style', prev);
    return r || { w: 1920, h: 1080, responsive: true };
  }

  /* -------------------------------------------------------- titlar & anteckn. */

  function textBlock(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    c.querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6').forEach((b) => b.append('\n'));
    c.querySelectorAll('li').forEach((li) => li.prepend('• '));
    return (c.textContent || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function jsonNotes() {
    const s = document.querySelector('script#speaker-notes, script[type="application/json"][id*="note"]');
    if (!s) return null;
    try {
      const v = JSON.parse(s.textContent);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.notes)) return v.notes;
      if (v && Array.isArray(v.slides)) return v.slides.map((x) => (x && (x.notes || x.note)) || '');
    } catch (_) {}
    return null;
  }

  function notesOf(el, i, fromJson) {
    let t = el.getAttribute('data-notes') || '';
    if (!t) {
      const n = el.querySelector(NOTE_SELECTOR);
      if (n) t = n.getAttribute('data-notes') || textBlock(n);
    }
    if (!t && fromJson && fromJson[i] != null) t = String(fromJson[i]);
    return t.trim();
  }

  function titleOf(el, i) {
    const attr = el.getAttribute('aria-label') || el.getAttribute('data-screen-label') || el.getAttribute('data-title') || el.getAttribute('title');
    if (attr) return attr.trim();
    const h = el.querySelector('h1, h2, h3, header, .title');
    const t = h ? (h.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return t.slice(0, 80) || `Slide ${i + 1}`;
  }

  /* -------------------------------------------------------------- isolering */

  function installStyle() {
    const css = `
html.hp-iso, html.hp-iso body { overflow: hidden !important; }
html.hp-iso [data-hp-slide]:not([data-hp-cur]) { display: none !important; }
html.hp-iso [data-hp-cur] {
  position: fixed !important; inset: 0 auto auto 0 !important; left: 0 !important; top: 0 !important;
  width: var(--hp-w) !important; height: var(--hp-h) !important; min-width: 0 !important; min-height: 0 !important;
  max-width: none !important; max-height: none !important; margin: 0 !important;
  transform: none !important; translate: none !important; scale: none !important; rotate: none !important; zoom: 1 !important;
  visibility: visible !important; opacity: 1 !important; z-index: 2147483000 !important; box-sizing: border-box !important;
  content-visibility: visible !important;
}
html.hp-iso [data-hp-anc] {
  transform: none !important; translate: none !important; scale: none !important; rotate: none !important; zoom: 1 !important;
  filter: none !important; backdrop-filter: none !important; perspective: none !important; contain: none !important;
  will-change: auto !important; visibility: visible !important; opacity: 1 !important; content-visibility: visible !important;
}
html.hp-iso [data-hp-hide] { visibility: hidden !important; pointer-events: none !important; }
html.hp-iso [data-hp-cur] :is(aside.notes, .speaker-notes) { display: none !important; }
html.hp-still *, html.hp-still *::before, html.hp-still *::after {
  animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
  transition: none !important; caret-color: transparent !important;
}
html.hp-edit [data-hp-cur], html.hp-edit [data-hp-cur] * { -webkit-user-select: text !important; user-select: text !important; }
html.hp-edit [data-hp-cur] * { cursor: default; }
html.hp-edit [data-hp-cur] [contenteditable] { cursor: text; outline: none !important; }
html.hp-edit [data-hp-cur] .hp-text { cursor: text; }
html.hp-edit [data-hp-cur] *, html.hp-edit [data-hp-cur] *::before, html.hp-edit [data-hp-cur] *::after {
  animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition: none !important;
}
[data-hp-ui] { position: fixed; pointer-events: none; z-index: 2147483647; box-sizing: border-box; display: none; border-radius: 3px; }
`;
    const style = document.createElement('style');
    style.setAttribute('data-hp-ui-style', '');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function clearMarks() {
    document.querySelectorAll('[data-hp-anc]').forEach((el) => el.removeAttribute('data-hp-anc'));
    document.querySelectorAll('[data-hp-hide]').forEach((el) => el.removeAttribute('data-hp-hide'));
  }

  // Markera vägen upp från sliden, och dölj allt annat på vägen (deckets egna knappar m.m.).
  function markPath(slide) {
    clearMarks();
    const path = [];
    for (let el = slide.parentElement; el && el !== document.documentElement; el = el.parentElement) path.push(el);
    const onPath = new Set(path);
    path.forEach((el) => {
      if (el !== document.body) el.setAttribute('data-hp-anc', '');
      if (getComputedStyle(el).display === 'none') el.style.setProperty('display', 'block', 'important');
      for (const kid of el.children) {
        if (onPath.has(kid) || kid.hasAttribute('data-hp-slide') || kid.hasAttribute('data-hp-ui') || SKIP_TAGS.has(kid.tagName)) continue;
        kid.setAttribute('data-hp-hide', '');
      }
    });
  }

  // Webbkomponenter (t.ex. <deck-stage>) som lägger slides i en <slot> har egen
  // skalning och egna knappar i sitt shadow DOM. Neutralisera skalningen och dölj
  // allt där inne som inte leder till sloten.
  const patchedRoots = new WeakSet();
  function patchShadow(slide) {
    for (let el = slide.parentElement; el; el = el.parentElement) {
      const root = el.shadowRoot;
      if (!root || patchedRoots.has(root)) continue;
      patchedRoots.add(root);
      const s = document.createElement('style');
      s.textContent = `
* { transform: none !important; translate: none !important; scale: none !important; zoom: 1 !important;
  filter: none !important; contain: none !important; perspective: none !important; will-change: auto !important; }
:not(slot):not(:has(slot)):not(style) { visibility: hidden !important; pointer-events: none !important; }
::slotted([data-hp-cur]) { display: block !important; visibility: visible !important; opacity: 1 !important; }`;
      root.appendChild(s);
    }
  }

  let guarding = false;
  const guard = new MutationObserver(() => {
    if (guarding || hp.index < 0) return;
    guarding = true;
    try { applyClasses(); } finally { Promise.resolve().then(() => { guarding = false; }); }
  });

  function applyClasses() {
    hp.slides.forEach((s, j) => {
      const cur = j === hp.index;
      hp.activeClasses.forEach((c) => { if (s.classList.contains(c) !== cur) s.classList.toggle(c, cur); });
      if (cur && s.hasAttribute('data-hp-cur') === false) s.setAttribute('data-hp-cur', '');
      if (!cur && s.hasAttribute('data-hp-cur')) s.removeAttribute('data-hp-cur');
      const aria = cur ? 'false' : 'true';
      if (s.getAttribute('aria-hidden') !== aria) s.setAttribute('aria-hidden', aria);
    });
  }

  hp.show = function (i) {
    if (hp.whole) { hp.index = 0; return 0; }
    i = Math.max(0, Math.min(hp.slides.length - 1, i | 0));
    if (i === hp.index) return i;
    commitEditing();
    clearSelection();
    const prev = hp.slides[hp.index];
    const cur = hp.slides[i];
    hp.index = i;
    guarding = true;
    applyClasses();
    markPath(cur);
    patchShadow(cur);
    if (getComputedStyle(cur).display === 'none') cur.style.setProperty('display', 'block', 'important');
    Promise.resolve().then(() => { guarding = false; });
    onSlideMedia(prev, cur);
    try { cur.dispatchEvent(new CustomEvent('hp:show', { bubbles: true, detail: { index: i } })); } catch (_) {}
    return i;
  };

  // För miniatyrer: visa sliden och vänta tills bilder och layout är klara.
  hp.prepareCapture = async function (i) {
    hp.show(i);
    const imgs = Array.from(hp.slides[hp.index].querySelectorAll('img'));
    await Promise.race([
      Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); })))),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    await Promise.all(imgs.map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
    await new Promise((r) => setTimeout(r, 90));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  };

  hp.info = function () {
    const fromJson = jsonNotes();
    return {
      count: hp.slides.length,
      size: hp.size,
      strategy: hp.strategy,
      whole: hp.whole,
      activeClasses: hp.activeClasses,
      title: document.title,
      titles: hp.slides.map(titleOf),
      notes: hp.whole ? [''] : hp.slides.map((s, i) => notesOf(s, i, fromJson)),
      // För att flytta slides i källfilen:
      ids: hp.whole ? [] : hp.slides.map((s) => s.getAttribute('data-hp-id')),
      siblings: !hp.whole && hp.slides.every((s) => s.parentElement === hp.slides[0].parentElement),
      slideTag: hp.whole ? '' : mostCommon(hp.slides.map((s) => s.tagName.toLowerCase())),
      commonClasses: hp.whole ? [] : commonClasses(hp.slides),
      jsonNotes: !!fromJson,
    };
  };

  function mostCommon(list) {
    const n = new Map();
    list.forEach((x) => n.set(x, (n.get(x) || 0) + 1));
    let best = '', c = 0;
    n.forEach((v, k) => { if (v > c) { best = k; c = v; } });
    return best;
  }

  function commonClasses(slides) {
    if (!slides.length) return [];
    let common = Array.from(slides[0].classList);
    slides.forEach((s) => { common = common.filter((c) => s.classList.contains(c)); });
    return common.filter((c) => !hp.activeClasses.includes(c) && !/^hp-/.test(c));
  }

  /* ------------------------------------------- stilar för import till annat deck */

  // När en slide kopieras till ett deck med annan design tar vi med de CSS-regler
  // från det här decket som faktiskt träffar sliden. Körs i miniatyrfönstret för
  // källdecket, där webbläsaren redan har tolkat all CSS.
  const INHERITED = /^(--|color$|font|line-height$|letter-spacing$|word-spacing$|text-(align|indent|transform|shadow|rendering|wrap)|white-space$|direction$|hyphens$|quotes$|list-style|cursor$|tab-size$|-webkit-font-smoothing$|font-feature|font-variant)/;
  const DYNAMIC = /::?(before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button)\b|:(hover|focus|focus-visible|focus-within|active|visited|target|checked|disabled|enabled)\b/g;

  function splitSelectors(text) {
    const out = []; let depth = 0, cur = '';
    for (const ch of text) {
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function testable(sel) { return sel.replace(DYNAMIC, '').replace(/\(\s*\)/g, '').trim() || '*'; }

  function ancestorsOf(el) { const a = []; for (let p = el.parentElement; p; p = p.parentElement) a.push(p); return a; }

  hp.collectStyles = function (ids) {
    const rules = [];
    const links = [];
    for (const sheet of Array.from(document.styleSheets)) {
      const node = sheet.ownerNode;
      if (!node || (node.hasAttribute && node.hasAttribute('data-hp-ui-style'))) continue;
      let list;
      try { list = sheet.cssRules; } catch (_) { if (sheet.href) links.push(sheet.href); continue; }
      for (const r of Array.from(list)) rules.push(r);
    }
    document.querySelectorAll('link[rel~="stylesheet"][href]').forEach((l) => { if (!links.includes(l.href) && !/^hpres:/.test(l.href)) links.push(l.href); });

    return ids.map((id) => {
      const slide = document.querySelector(`[data-hp-id="${id}"]`);
      if (!slide) return null;
      // Visa sliden först, så att regler som .slide.on … träffar den.
      const idx = hp.slides.indexOf(slide);
      if (idx >= 0) hp.show(idx);
      const ancestors = ancestorsOf(slide);
      const scoped = [];
      const inherit = [];
      const hoisted = [];

      // 'inside' = träffar något inuti sliden, 'root' = bara själva slide-elementet,
      // 'ancestor' = bara element ovanför sliden (då ärvs bara t.ex. typsnitt och färg).
      const classify = (selText) => {
        let inside = false, root = false, ancestor = false;
        for (const sel of splitSelectors(selText)) {
          const t = testable(sel);
          try {
            if (slide.querySelector(t)) inside = true;
            else if (slide.matches(t)) root = true;
            else if (ancestors.some((a) => a.matches(t))) ancestor = true;
          } catch (_) { inside = true; } // okänd syntax: ta hellre med
        }
        return inside ? 'inside' : root ? 'root' : ancestor ? 'ancestor' : null;
      };
      // På själva slide-elementet styr det mottagande decket placering och synlighet.
      const ROOT_SKIP = /^(position|inset|top|right|bottom|left|width|height|min-|max-|margin|transform|translate|scale|rotate|opacity|visibility|z-index|transition|zoom|content-visibility|will-change|contain|float|clear)/;
      const declsOf = (style, keep) => {
        const out = [];
        for (let i = 0; i < style.length; i++) {
          const prop = style[i];
          if (keep(prop)) out.push(`${prop}: ${style.getPropertyValue(prop)}${style.getPropertyPriority(prop) ? ' !important' : ''}`);
        }
        return out;
      };
      // I det mottagande decket ligger sliden i en ram (scope-roten). Delar av en
      // selektor som träffar element ovanför sliden här (t.ex. .stage i
      // ".stage .slide h2", eller html/body) byts mot :scope.
      const COMB = new Set([' ', '>', '+', '~']);
      const tokens = (sel) => {
        const toks = []; let cur = '', depth = 0;
        for (const ch of sel.trim()) {
          if (ch === '(' || ch === '[') depth++;
          if (ch === ')' || ch === ']') depth--;
          if (depth === 0 && /[\s>+~]/.test(ch)) {
            if (cur) { toks.push(cur); cur = ''; }
            const last = toks[toks.length - 1];
            if (/\s/.test(ch)) { if (last && !COMB.has(last)) toks.push(' '); }
            else if (last === ' ') toks[toks.length - 1] = ch; else toks.push(ch);
            continue;
          }
          cur += ch;
        }
        if (cur) toks.push(cur);
        while (toks.length && COMB.has(toks[toks.length - 1])) toks.pop();
        return toks;
      };
      const scopeOne = (sel) => {
        sel = sel.replace(/(^|[\s>+~(,])(:root|html|body)(?![\w-])/g, '$1:scope');
        const toks = tokens(sel);
        let cut = -1;
        for (let i = 0; i < toks.length - 2; i += 2) {
          const prefix = toks.slice(0, i + 1).join('');
          if (prefix === ':scope') { cut = i; continue; }
          try { if (ancestors.some((a) => a.matches(testable(prefix)))) cut = i; } catch (_) { /* ogiltig del */ }
        }
        return cut < 0 ? sel : ':scope' + toks.slice(cut + 1).join('');
      };
      const rewrite = (sel) => splitSelectors(sel).map(scopeOne).join(', ');

      const walk = (list, out, inheritOut) => {
        for (const r of Array.from(list)) {
          if (r instanceof CSSStyleRule) {
            const kind = classify(r.selectorText);
            if (kind === 'inside') {
              const brace = r.cssText.indexOf('{');
              out.push(rewrite(r.selectorText) + ' ' + r.cssText.slice(brace));
            } else if (kind === 'root') {
              const decls = declsOf(r.style, (prop) => !ROOT_SKIP.test(prop));
              if (decls.length) out.push(rewrite(r.selectorText) + ' { ' + decls.join('; ') + ' }');
            } else if (kind === 'ancestor') {
              const decls = declsOf(r.style, (prop) => INHERITED.test(prop));
              if (decls.length) inheritOut.push(decls.join('; '));
            }
          } else if (r.cssRules && (r instanceof CSSMediaRule || r instanceof CSSSupportsRule || (window.CSSContainerRule && r instanceof CSSContainerRule) || (window.CSSLayerBlockRule && r instanceof CSSLayerBlockRule))) {
            const inner = [], innerInherit = [];
            walk(r.cssRules, inner, innerInherit);
            const prelude = r.cssText.slice(0, r.cssText.indexOf('{')).trim();
            if (innerInherit.length) inner.unshift(':scope { ' + innerInherit.join('; ') + ' }');
            if (inner.length) out.push(prelude + ' {\n' + inner.join('\n') + '\n}');
          } else if (r instanceof CSSFontFaceRule || r instanceof CSSKeyframesRule || (window.CSSPropertyRule && r instanceof CSSPropertyRule)) {
            hoisted.push(r);
          }
        }
      };
      walk(rules, scoped, inherit);

      // Ta bara med typsnitt och animationer som de medtagna reglerna använder.
      const used = scoped.join('\n') + inherit.join(';');
      const keep = hoisted.filter((r) => {
        if (r instanceof CSSFontFaceRule) { const fam = (r.style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim(); return fam && used.includes(fam); }
        if (r instanceof CSSKeyframesRule) return used.includes(r.name);
        return true;
      }).map((r) => r.cssText);

      return { id, hoisted: keep, inherit: inherit.join('; '), scoped, links };
    });
  };

  hp.setScale = function (s) { hp.scale = s || 1; drawBoxes(); };

  /* -------------------------------------------------------------- redigering */

  let editingEl = null;
  let selected = null;
  let selKind = null;
  let hoverBox = null;
  let selBox = null;

  function makeBox(color, dashed) {
    const b = document.createElement('div');
    b.setAttribute('data-hp-ui', '');
    b.style.border = `2px ${dashed ? 'dashed' : 'solid'} ${color}`;
    document.documentElement.appendChild(b);
    return b;
  }

  function placeBox(box, el, pad) {
    if (!box) return;
    if (!el || !el.isConnected) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    const bw = Math.max(1.5, 2 / hp.scale);
    const p = (pad || 3) / hp.scale;
    box.style.borderWidth = bw + 'px';
    box.style.left = (r.left - p) + 'px';
    box.style.top = (r.top - p) + 'px';
    box.style.width = (r.width + 2 * p) + 'px';
    box.style.height = (r.height + 2 * p) + 'px';
    box.style.display = 'block';
  }

  function drawBoxes() {
    if (selBox) placeBox(selBox, selected);
  }

  const curSlide = () => hp.slides[hp.index];

  function hasOwnText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }

  // Det textblock ett klick hamnar i: närmaste element med egen text, uppklättrat
  // genom inline-element (så ett ord i <b> redigeras som hela stycket).
  function textBlockFor(start) {
    const slide = curSlide();
    if (!slide || !start || !slide.contains(start)) return null;
    let el = start.nodeType === 3 ? start.parentElement : start;
    while (el && el !== slide && !hasOwnText(el)) el = el.parentElement;
    if (!el || el === slide) return null;
    while (el.parentElement && el.parentElement !== slide && getComputedStyle(el).display === 'inline') el = el.parentElement;
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
    if (/^(SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION)$/.test(el.tagName)) return null;
    if (!el.hasAttribute('data-hp-id')) return null; // skapat av deckets skript — finns inte i källan
    return el;
  }

  function elementFor(start) {
    const slide = curSlide();
    let el = start && (start.nodeType === 3 ? start.parentElement : start);
    while (el && el !== slide && !el.hasAttribute('data-hp-id')) el = el.parentElement;
    if (!el || el === slide || !slide.contains(el)) return null;
    return el;
  }

  function stackAt(x, y) {
    const slide = curSlide();
    return document.elementsFromPoint(x, y).filter((el) => slide && slide.contains(el) && el !== slide && !el.hasAttribute('data-hp-ui'));
  }

  function describe(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('');
    return tag + cls;
  }

  function report() {
    if (!selected || !selected.isConnected) { emit('select', null); return; }
    const r = selected.getBoundingClientRect();
    emit('select', {
      kind: selKind,
      id: selected.getAttribute('data-hp-id'),
      label: describe(selected),
      text: (selected.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      canParent: !!(selected.parentElement && selected.parentElement !== curSlide() && elementFor(selected.parentElement)),
      editable: !!textBlockFor(selected) && textBlockFor(selected) === selected,
    });
  }

  function select(el, kind) {
    selected = el || null;
    selKind = el ? kind : null;
    if (!selBox) selBox = makeBox('#3b82f6', false);
    selBox.style.borderColor = kind === 'text' ? '#3b82f6' : '#f59e0b';
    drawBoxes();
    report();
  }

  function clearSelection() {
    selected = null; selKind = null;
    if (selBox) selBox.style.display = 'none';
    if (hoverBox) hoverBox.style.display = 'none';
    report();
  }

  function clean(el) {
    const c = el.cloneNode(true);
    c.removeAttribute && c.removeAttribute('contenteditable');
    c.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    c.querySelectorAll('[data-hp-anc],[data-hp-hide],[data-hp-cur],[data-hp-slide]').forEach((n) => {
      n.removeAttribute('data-hp-anc'); n.removeAttribute('data-hp-hide'); n.removeAttribute('data-hp-cur'); n.removeAttribute('data-hp-slide');
    });
    c.querySelectorAll('[data-hp-ui]').forEach((n) => n.remove());
    return c.innerHTML;
  }

  function beginEdit(block, x, y) {
    commitEditing();
    editingEl = block;
    block.__hpOrig = clean(block);
    block.__hpHadSpell = block.getAttribute('spellcheck');
    block.setAttribute('contenteditable', 'plaintext-only');
    block.setAttribute('spellcheck', 'false');
    hp.editing = true;
    emit('editing', true);
    // Appen kontrollerar att texten ser ut som i källfilen (inte ändrad av skript).
    emit('editBegin', { id: block.getAttribute('data-hp-id'), html: block.__hpOrig });
    block.focus({ preventScroll: true });
    if (x != null) placeCaret(block, x, y);
    else {
      const r = document.createRange(); r.selectNodeContents(block); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    select(block, 'text');
  }

  // Lägger markören där du klickade, även om något genomskinligt ligger ovanpå texten.
  function placeCaret(block, x, y) {
    const lifted = [];
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === block || block.contains(el) || el === document.documentElement || el === document.body) break;
      lifted.push([el, el.style.getPropertyValue('pointer-events'), el.style.getPropertyPriority('pointer-events')]);
      el.style.setProperty('pointer-events', 'none', 'important');
    }
    const range = document.caretRangeFromPoint(x, y);
    lifted.forEach(([el, v, p]) => { if (v) el.style.setProperty('pointer-events', v, p); else el.style.removeProperty('pointer-events'); if (!el.getAttribute('style')) el.removeAttribute('style'); });
    const s = getSelection();
    s.removeAllRanges();
    if (range && block.contains(range.startContainer)) s.addRange(range);
    else { const r = document.createRange(); r.selectNodeContents(block); r.collapse(false); s.addRange(r); }
  }

  function commitEditing() {
    const el = editingEl;
    if (!el) return;
    editingEl = null;
    hp.editing = false;
    emit('editing', false);
    el.removeAttribute('contenteditable');
    if (el.__hpHadSpell == null) el.removeAttribute('spellcheck'); else el.setAttribute('spellcheck', el.__hpHadSpell);
    let html = clean(el);
    // plaintext-only lämnar ibland ett <br> på slutet när man raderat allt.
    if (/<br>$/.test(html) && !/<br\s*\/?>$/.test(el.__hpOrig || '')) html = html.replace(/<br>$/, '');
    try { getSelection().removeAllRanges(); } catch (_) {}
    if (html !== el.__hpOrig) {
      emit('edit', { id: el.getAttribute('data-hp-id'), html, orig: el.__hpOrig, slide: hp.index });
    }
    el.__hpOrig = undefined;
  }

  function editKey(e) {
    if (e.key === 'Escape' || e.key === 'Tab') {
      const el = editingEl;
      commitEditing();
      if (el) select(el, 'element');
      return true;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { const el = editingEl; commitEditing(); if (el) select(el, 'element'); return true; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { commitEditing(); return false; }
    return false;
  }

  function selectionKey(e) {
    if (!selected) return false;
    if (e.key === 'Backspace' || e.key === 'Delete') { if (selKind !== 'text') emit('requestDelete'); return true; }
    if (e.key === 'Escape') { clearSelection(); return true; }
    if (e.key === 'Enter') { const b = textBlockFor(selected); if (b === selected) beginEdit(b); return true; }
    if (e.key === 'ArrowUp' && e.altKey) { hp.selectParent(); return true; }
    return false;
  }

  hp.selectParent = function () {
    if (!selected) return;
    commitEditing();
    const p = elementFor(selected.parentElement);
    if (p) select(p, 'element');
  };

  hp.commit = function () { commitEditing(); };

  // Avbryt redigeringen och återställ texten (när den inte går att spara säkert).
  hp.cancelEdit = function (id) {
    const el = editingEl;
    if (!el || el.getAttribute('data-hp-id') !== String(id)) return;
    editingEl = null;
    hp.editing = false;
    emit('editing', false);
    el.removeAttribute('contenteditable');
    if (el.__hpHadSpell == null) el.removeAttribute('spellcheck'); else el.setAttribute('spellcheck', el.__hpHadSpell);
    if (clean(el) !== el.__hpOrig) el.innerHTML = el.__hpOrig;
    el.__hpOrig = undefined;
    try { getSelection().removeAllRanges(); } catch (_) {}
    select(el, 'element');
  };
  hp.deselect = function () { commitEditing(); clearSelection(); };
  hp.editSelected = function () { if (selected) { const b = textBlockFor(selected); if (b) beginEdit(b); } };
  hp.selectedId = function () { return selected ? selected.getAttribute('data-hp-id') : null; };
  hp.removeById = function (id) {
    document.querySelectorAll(`[data-hp-id="${id}"]`).forEach((n) => n.remove());
    clearSelection();
  };
  hp.execUndo = function (redo) { document.execCommand(redo ? 'redo' : 'undo'); };

  hp.setEdit = function (on) {
    on = !!on;
    if (on === hp.edit) return;
    if (!on) { commitEditing(); clearSelection(); }
    hp.edit = on;
    document.documentElement.classList.toggle('hp-edit', on);
  };

  document.addEventListener('mousemove', (e) => {
    if (!hp.edit) return;
    if (!hoverBox) hoverBox = makeBox('rgba(59,130,246,.55)', true);
    const stack = stackAt(e.clientX, e.clientY);
    let target = null;
    for (const el of stack) { target = textBlockFor(el); if (target) break; }
    if (!target && e.altKey) target = elementFor(stack[0]);
    if (!target || target === selected || target === editingEl) { hoverBox.style.display = 'none'; return; }
    placeBox(hoverBox, target, 2);
  }, true);

  document.addEventListener('mouseleave', () => { if (hoverBox) hoverBox.style.display = 'none'; }, true);

  document.addEventListener('mousedown', (e) => {
    if (!hp.edit || e.button !== 0) return;
    const slide = curSlide();
    if (!slide) return;
    e.stopImmediatePropagation();
    const stack = stackAt(e.clientX, e.clientY);

    // Klick inuti texten du redan redigerar: låt webbläsaren sköta markören.
    if (editingEl && stack[0] && editingEl.contains(stack[0])) return;

    if (e.altKey) {
      e.preventDefault();
      commitEditing();
      const el = elementFor(stack[0]);
      if (el) select(el, 'element'); else clearSelection();
      return;
    }

    let block = null;
    for (const el of stack) { block = textBlockFor(el); if (block) break; }
    e.preventDefault();
    if (block) {
      if (block === editingEl) { placeCaret(block, e.clientX, e.clientY); return; }
      beginEdit(block, e.clientX, e.clientY);
      return;
    }
    commitEditing();
    const el = elementFor(stack[0]);
    if (el) select(el, 'element'); else clearSelection();
  }, true);

  ['click', 'dblclick', 'auxclick', 'contextmenu', 'pointerup', 'mouseup', 'touchstart', 'dragstart'].forEach((type) => {
    document.addEventListener(type, (e) => {
      if (!hp.edit) return;
      e.stopImmediatePropagation();
      if (type === 'click' || type === 'dragstart' || type === 'auxclick') {
        if (!(editingEl && editingEl.contains(e.target))) e.preventDefault();
        else if (type === 'dragstart') e.preventDefault();
      }
    }, true);
  });

  window.addEventListener('resize', drawBoxes);
  // Klick utanför sliden (verktygsrad, meny, annat fönster): spara textändringen.
  // Byter du program mitt i en text sparas den, och markeringen tas bort så att ⌫
  // när du kommer tillbaka inte tar bort hela elementet.
  window.addEventListener('blur', () => {
    const was = editingEl;
    commitEditing();
    if (was && selected === was) clearSelection();
  });
  // Ramen och verktygsraden följer med när texten växer eller krymper.
  document.addEventListener('input', () => { if (editingEl) { drawBoxes(); report(); } }, true);

  /* -------------------------------------------------------------------- start */

  function init() {
    if (hp.ready) return;
    installStyle();
    const found = detect();
    hp.strategy = found.strategy;
    hp.whole = !!found.whole;
    hp.slides = found.els;

    if (STILL) document.documentElement.classList.add('hp-still');

    if (!hp.whole) {
      hp.activeClasses = detectActiveClasses(hp.slides);
      hp.size = withoutMotion(() => measure(hp.slides));
      document.documentElement.style.setProperty('--hp-w', hp.size.w + 'px');
      document.documentElement.style.setProperty('--hp-h', hp.size.h + 'px');
      hp.slides.forEach((s) => s.setAttribute('data-hp-slide', ''));
      document.documentElement.classList.add('hp-iso');
      // Pausa all media som decket kan ha startat; show() startar rätt slides media.
      document.querySelectorAll('video, audio').forEach((m) => { if (MUTED) m.muted = true; try { m.pause(); } catch (_) {} });
      hp.slides.forEach((s) => guard.observe(s, { attributes: true, attributeFilter: ['class', 'aria-hidden'] }));
      const start = parseInt(params.get('slide') || '0', 10) || 0;
      hp.index = -1;
      hp.show(start);
    } else {
      hp.size = { w: 1920, h: 1080 };
      hp.index = 0;
    }
    hp.ready = true;
    emit('ready', { href: BOOT_HREF, info: Object.assign(hp.info(), { index: hp.index }) });
  }

  // Publikfönstret: dölj muspekaren när den står still.
  if (MODE === 'audience') {
    let idle;
    const wake = () => {
      document.documentElement.classList.remove('hp-idle');
      clearTimeout(idle);
      idle = setTimeout(() => document.documentElement.classList.add('hp-idle'), 1800);
    };
    document.addEventListener('mousemove', wake, true);
    const s = document.createElement('style');
    s.setAttribute('data-hp-ui-style', '');
    s.textContent = 'html.hp-idle, html.hp-idle * { cursor: none !important; }';
    (document.head || document.documentElement).appendChild(s);
    wake();
  }

  function boot() { setTimeout(init, 30); }
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
})();
