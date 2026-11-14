// slideview.js — en ruta som visar en slide ur ett levande deck, skalad för att passa.
//
// Decket laddas i en iframe i slidens egen storlek (t.ex. 1600×900) och skalas med
// CSS. Iframen har samma origin som appen, så vi pratar direkt med kontrollern
// (window.__hp) inuti.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class SlideView {
  constructor(host, { mode = 'main', interactive = true } = {}) {
    this.host = host;
    this.mode = mode;
    this.api = null;
    this.info = null;
    this.url = null;
    this.index = -1;
    this.size = { w: 1920, h: 1080 };
    this.scale = 1;
    this.handlers = {};
    this._tok = 0;

    host.classList.add('sv');
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'sv-frame';
    this.iframe.setAttribute('scrolling', 'no');
    if (!interactive) { this.iframe.tabIndex = -1; this.iframe.classList.add('sv-inert'); }
    host.appendChild(this.iframe);

    this.ro = new ResizeObserver(() => this.relayout());
    this.ro.observe(host);
  }

  on(name, fn) { this.handlers[name] = fn; return this; }

  async load(url, index = 0) {
    const tok = ++this._tok;
    this.api = null;
    this.info = null;
    this.url = url;
    this.index = -1;
    this.host.classList.add('sv-loading');
    this.iframe.style.width = '1920px';
    this.iframe.style.height = '1080px';
    const sep = url.includes('?') ? '&' : '?';
    await new Promise((resolve) => {
      this.iframe.addEventListener('load', resolve, { once: true });
      this.iframe.src = url + sep + 'slide=' + index;
    });
    if (tok !== this._tok) return null;

    const started = Date.now();
    let api = null;
    while (Date.now() - started < 20000) {
      if (tok !== this._tok) return null;
      try {
        const w = this.iframe.contentWindow;
        if (w && w.__hp && w.__hp.ready) { api = w.__hp; break; }
      } catch (_) { /* annan origin – ska inte hända */ }
      await wait(40);
    }
    if (!api) throw new Error('Decket svarade inte (ingen kontroller).');

    this.api = api;
    api.onKey = (k) => this.handlers.key && this.handlers.key(k, this);
    api.onEdit = (e) => this.handlers.edit && this.handlers.edit(e, this);
    api.onSelect = (s) => this.handlers.select && this.handlers.select(s, this);
    api.onRequestDelete = () => this.handlers.requestDelete && this.handlers.requestDelete(this);

    this.info = api.info();
    this.size = this.info.size;
    this.index = api.index;
    this.relayout();
    this.host.classList.remove('sv-loading');
    return this.info;
  }

  show(i) {
    if (!this.api) return;
    this.index = this.api.show(i);
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
    if (this.api) this.api.setScale(s);
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
    this._tok++;
    this.api = null;
    this.info = null;
    this.url = null;
    this.iframe.src = 'about:blank';
  }
}
