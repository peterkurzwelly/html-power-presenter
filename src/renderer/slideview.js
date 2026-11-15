// slideview.js — en ruta som visar en slide ur ett levande deck, skalad för att passa.
//
// Decket laddas i en iframe i slidens egen storlek (t.ex. 1600×900) och skalas med
// CSS. Decket har en egen origin (hpres://deck) skild från appen (hpres://app), så
// deckets skript kommer inte åt appen. Appen och kontrollern i decket pratar bara
// via postMessage: appen skickar kommandon, kontrollern svarar och skickar händelser.

import { cleanInfo } from './deckinfo.mjs';

const DECK_ORIGINS = new Set(['hpres://deck', 'hpres://source']);

// Samma dokument och samma version? Jämför sökväg (oberoende av kodning) och hp/rev,
// så att ett sent 'ready' från förra laddningen inte tas för den nya.
const sameDoc = (a, b) => {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && decodeURIComponent(x.pathname) === decodeURIComponent(y.pathname)
      && x.searchParams.get('hp') === y.searchParams.get('hp') && x.searchParams.get('rev') === y.searchParams.get('rev');
  } catch (_) { return false; }
};

export class SlideView {
  constructor(host, { mode = 'main', interactive = true } = {}) {
    this.host = host;
    this.mode = mode;
    this.ready = false;
    this.info = null;
    this.url = null;
    this.index = -1;
    this.size = { w: 1920, h: 1080 };
    this.scale = 1;
    this.editing = false;
    this.selection = null;
    this.handlers = {};
    this._tok = 0;
    this._calls = new Map();
    this._nextCall = 1;
    this._onReady = null;
    this._pending = null; // { resolve, timer } för laddningen som pågår

    host.classList.add('sv');
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'sv-frame';
    this.iframe.setAttribute('scrolling', 'no');
    // Decket får köra skript och behålla sin egen origin, men inte navigera appfönstret.
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals');
    this.iframe.setAttribute('allow', 'fullscreen; autoplay');
    if (!interactive) { this.iframe.tabIndex = -1; this.iframe.classList.add('sv-inert'); }
    host.appendChild(this.iframe);

    this._onMessage = this._onMessage.bind(this);
    window.addEventListener('message', this._onMessage);
    this.ro = new ResizeObserver(() => this.relayout());
    this.ro.observe(host);
  }

  on(name, fn) { this.handlers[name] = fn; return this; }

  _emit(name, ...a) { const fn = this.handlers[name]; if (fn) fn(...a, this); }

  // Bara meddelanden från vår egen iframe, från en deck-origin, med vårt format.
  _onMessage(e) {
    if (e.source !== this.iframe.contentWindow || !DECK_ORIGINS.has(e.origin)) return;
    const m = e.data;
    if (!m || m.hp !== 1 || typeof m.type !== 'string') return;
    if (m.type === 'reply') {
      const p = this._calls.get(m.id);
      if (p) { this._calls.delete(m.id); if (m.error) p.reject(new Error(String(m.error))); else p.resolve(m.result); }
      return;
    }
    if (m.type !== 'event') return;
    const d = m.data;
    switch (m.name) {
      case 'ready': if (this._onReady) this._onReady(d); break;
      case 'key': this._emit('key', d); break;
      case 'edit': this._emit('edit', d); break;
      case 'editBegin': this._emit('editBegin', d); break;
      case 'select': this.selection = d || null; this._emit('select', this.selection); break;
      case 'editing': this.editing = !!d; break;
      case 'requestDelete': this._emit('requestDelete'); break;
      default: break;
    }
  }

  // Skicka ett kommando till kontrollern och vänta på svaret.
  call(method, ...args) {
    if (!this.ready) return Promise.resolve(undefined);
    const id = this._nextCall++;
    const target = this.iframe.contentWindow;
    const origin = new URL(this.url).origin;
    return new Promise((resolve, reject) => {
      this._calls.set(id, { resolve, reject });
      target.postMessage({ hp: 1, type: 'call', id, method, args }, origin);
      setTimeout(() => { if (this._calls.has(id)) { this._calls.delete(id); resolve(undefined); } }, 5000);
    });
  }

  // En laddning som ersätts av en nyare (eller av unload) avslutas direkt med null.
  _settlePending() {
    const p = this._pending;
    this._pending = null;
    this._onReady = null;
    if (p) { clearTimeout(p.timer); p.resolve(null); }
  }

  async load(url, index = 0) {
    this._settlePending();
    const tok = ++this._tok;
    this.ready = false;
    this.info = null;
    this.url = url;
    this.index = -1;
    this.editing = false;
    this.selection = null;
    this._calls.forEach((p) => p.resolve(undefined));
    this._calls.clear();
    this.host.classList.add('sv-loading');
    this.iframe.style.width = '1920px';
    this.iframe.style.height = '1080px';
    const sep = url.includes('?') ? '&' : '?';
    const src = url + sep + 'slide=' + index;

    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (tok !== this._tok) return;
        this._pending = null;
        this._onReady = null;
        reject(new Error('Decket svarade inte (ingen kontroller).'));
      }, 20000);
      this._pending = { resolve, timer };
      this._onReady = (d) => {
        if (tok !== this._tok || !d || typeof d.href !== 'string' || !sameDoc(d.href, url)) return;
        clearTimeout(timer);
        this._pending = null;
        this._onReady = null;
        resolve({ info: d.info });
      };
      this.iframe.src = src;
    });
    if (!raw || tok !== this._tok) return null;
    const info = cleanInfo(raw.info);

    this.ready = true;
    this.info = info;
    this.size = info.size;
    this.index = info.index;
    this.relayout();
    this.host.classList.remove('sv-loading');
    return info;
  }

  show(i) {
    if (!this.ready || !this.info) return;
    const n = this.info.count;
    this.index = Math.max(0, Math.min(n - 1, i | 0));
    this.call('show', this.index);
  }

  relayout() {
    const { w, h } = this.size;
    const cw = this.host.clientWidth;
    const ch = this.host.clientHeight;
    if (!cw || !ch) return;
    const s = Math.min(cw / w, ch / h);
    this.scale = s;
    const f = this.iframe.style;
    f.width = w + 'px';
    f.height = h + 'px';
    f.transform = `translate(-50%, -50%) scale(${s})`;
    this.call('setScale', s);
  }

  // Omvandlar en rektangel i slidens koordinater till koordinater i appfönstret.
  toHost(rect) {
    const fr = this.iframe.getBoundingClientRect();
    return {
      left: fr.left + rect.left * this.scale,
      top: fr.top + rect.top * this.scale,
      width: rect.width * this.scale,
      height: rect.height * this.scale,
    };
  }

  focus() { try { this.iframe.contentWindow.focus(); } catch (_) {} }

  unload() {
    this._settlePending();
    this._tok++;
    this.ready = false;
    this.info = null;
    this.url = null;
    this.editing = false;
    this.selection = null;
    this.iframe.src = 'about:blank';
  }
}
