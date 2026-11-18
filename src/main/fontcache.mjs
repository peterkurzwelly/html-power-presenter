// fontcache.mjs — Google Fonts som fungerar utan nät.
//
// De flesta AI-genererade decks hämtar sina typsnitt från fonts.googleapis.com. Utan
// nät (eller på ett trögt hotell- eller konferensnät) faller texten tillbaka på ett
// annat typsnitt och radbryts annorlunda. Därför skriver appen om länkarna i den HTML
// den visar (aldrig i filen) så att de går via hpres://deck/__fonts/…. Första gången
// hämtas typsnitten från nätet och sparas; sedan visas de från den sparade kopian.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CSS_HOST = 'https://fonts.googleapis.com/';
const FILE_HOST = 'https://fonts.gstatic.com/';
const CSS_MAX_AGE = 7 * 24 * 3600e3; // äldre CSS hämtas på nytt när nätet finns
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const MAX_CSS_PER_DOC = 20;   // fler Google Fonts-länkar än så i ett dokument lämnas orörda
const MAX_CACHE_BYTES = 80e6; // typsnittsmappen rensas (äldst först) över den här storleken

// Avkodar HTML-entiteter i ett attributvärde (&amp; &#38; &#038; &#x26; …).
const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
function decodeAttr(v) {
  return v.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));?/gi, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Math.min(0x10ffff, parseInt(dec, 10)));
    if (hex) return String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16)));
    return Object.prototype.hasOwnProperty.call(NAMED, name.toLowerCase()) ? NAMED[name.toLowerCase()] : m;
  });
}

export const isFontCss = (u) => typeof u === 'string' && u.startsWith(CSS_HOST) && u.length < 4000 && u.length > CSS_HOST.length && !/[#\s<>"']/.test(u);
export const isFontFile = (u) => typeof u === 'string' && u.startsWith(FILE_HOST) && u.length < 2000 && !/[#\s<>"']/.test(u);
export const proxyUrl = (origin, kind, url) => `${origin}/__fonts/${kind}?u=${encodeURIComponent(url)}`;

// Element vars innehåll är text eller kod, inte HTML: där skrivs ingenting om.
const RAW = ['script', 'textarea', 'xmp', 'noscript', 'title', 'template', 'iframe', 'noembed', 'noframes', 'plaintext'];

// Skriver om Google Fonts-länkar i <link rel="stylesheet">-taggar och @import i
// <style>-block. Går igenom dokumentet en gång (linjärt), hoppar över kommentarer och
// element med rå text. Returnerar ny HTML och adresserna som hittades.
export function rewriteFontLinks(html, origin) {
  const urls = [];
  const low = html.toLowerCase();
  let out = '';
  let last = 0;
  let pos = 0;
  const tagNameAt = (i) => { const m = /^<\/?([a-z][a-z0-9-]*)/.exec(low.slice(i, i + 20)); return m ? m[1] : ''; };
  while (true) {
    const lt = low.indexOf('<', pos);
    if (lt === -1) break;
    if (low.startsWith('<!--', lt)) {
      const e = low.indexOf('-->', lt + 4);
      if (e === -1) break;
      pos = e + 3;
      continue;
    }
    const name = tagNameAt(lt);
    if (!name || low[lt + 1] === '/') { pos = lt + 1; continue; }
    const gt = low.indexOf('>', lt);
    if (gt === -1) break;
    if (RAW.includes(name)) {
      const e = low.indexOf(`</${name}`, gt);
      if (e === -1) break;
      pos = e + name.length + 2;
      continue;
    }
    if (name === 'link') {
      const tag = html.slice(lt, gt + 1);
      const rel = /\srel\s*=\s*["']?([^"'>]*)/i.exec(tag);
      const isSheet = rel && /\b(stylesheet|preload)\b/i.test(rel[1]);
      const next = isSheet && urls.length < MAX_CSS_PER_DOC ? tag.replace(/(\shref\s*=\s*)(["'])(https:\/\/fonts\.googleapis\.com\/[^"']*)\2/i, (m, pre, q, raw) => {
        const url = decodeAttr(raw);
        if (!isFontCss(url)) return m;
        urls.push(url);
        return `${pre}${q}${proxyUrl(origin, 'css', url)}${q}`;
      }) : tag;
      if (next !== tag) { out += html.slice(last, lt) + next; last = gt + 1; }
      pos = gt + 1;
      continue;
    }
    if (name === 'style') {
      const e = low.indexOf('</style', gt);
      if (e === -1) break;
      const css = html.slice(gt + 1, e);
      const next = rewriteCssImports(css, origin, urls);
      if (next !== css) { out += html.slice(last, gt + 1) + next; last = e; }
      pos = e + 7;
      continue;
    }
    pos = gt + 1;
  }
  out += html.slice(last);
  return { html: out, urls: [...new Set(urls)] };
}

export function rewriteCssImports(css, origin, urls = []) {
  return css.replace(/@import\s+(?:url\(\s*)?(["']?)(https:\/\/fonts\.googleapis\.com\/[^"')\s]+)\1\s*\)?/gi, (m, _q, url) => {
    if (!isFontCss(url) || urls.length >= MAX_CSS_PER_DOC) return m;
    urls.push(url);
    return `@import url("${proxyUrl(origin, 'css', url)}")`;
  });
}

// I en Google Fonts-CSS: låt typsnittsfilerna också gå via appen.
export function rewriteCssFiles(css, origin) {
  return css.replace(/url\(\s*["']?(https:\/\/fonts\.gstatic\.com\/[^"')\s]+)["']?\s*\)/g, (m, url) => (isFontFile(url) ? `url("${proxyUrl(origin, 'file', url)}")` : m));
}

// Typsnittsfilerna i en Google Fonts-CSS. `latinOnly` ger bara latin och latin-ext
// (det svenska behöver), som hämtas i förväg så att de finns även utan nät.
export function fontFilesIn(css, latinOnly = false) {
  const files = [];
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (latinOnly && m[1] && !/^latin(-ext)?$/.test(m[1])) continue;
    for (const u of m[2].matchAll(/url\(\s*["']?(https:\/\/fonts\.gstatic\.com\/[^"')\s]+)["']?\s*\)/g)) files.push(u[1]);
  }
  return [...new Set(files)];
}

// woff2, woff, TrueType eller OpenType: de första byten avgör.
function looksLikeFont(buf) {
  if (!buf || buf.length < 4) return false;
  const tag = buf.subarray(0, 4).toString('latin1');
  return tag === 'wOF2' || tag === 'wOFF' || tag === 'OTTO' || tag === 'true' || buf.readUInt32BE(0) === 0x00010000;
}

export class FontCache {
  constructor(dir, fetchFn, { onChange = () => {} } = {}) {
    this.dir = dir;
    this.fetch = fetchFn;
    this.onChange = onChange;
    this.offline = false; // "Testa utan nät": hämta aldrig från nätet
    this.inflight = new Map();
  }

  _paths(url) {
    const key = sha1(url);
    return { body: path.join(this.dir, key + '.bin'), meta: path.join(this.dir, key + '.json') };
  }

  _read(url) {
    const p = this._paths(url);
    try {
      const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
      if (meta.url !== url) return null;
      return { body: fs.readFileSync(p.body), type: meta.type, savedAt: meta.savedAt };
    } catch { return null; }
  }

  _write(url, body, type) {
    fs.mkdirSync(this.dir, { recursive: true });
    const p = this._paths(url);
    fs.writeFileSync(p.body, body);
    fs.writeFileSync(p.meta, JSON.stringify({ url, type, savedAt: Date.now() }));
    if (!this.prunedAt || Date.now() - this.prunedAt > 60e3) { this.prunedAt = Date.now(); this.prune(); }
  }

  has(url) { return fs.existsSync(this._paths(url).meta); }

  // Högst fyra hämtningar åt gången.
  _slot() {
    if (!this.active) this.active = 0;
    if (!this.waiting) this.waiting = [];
    if (this.active < 4) { this.active++; return Promise.resolve(); }
    return new Promise((r) => this.waiting.push(r)).then(() => { this.active++; });
  }

  _release() {
    this.active = Math.max(0, (this.active || 1) - 1);
    const next = this.waiting && this.waiting.shift();
    if (next) next();
  }

  // Rensar äldsta typsnitten när mappen blir för stor.
  prune(max = MAX_CACHE_BYTES) {
    let files;
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return; }
    const items = files.map((f) => {
      const meta = path.join(this.dir, f);
      const body = meta.replace(/\.json$/, '.bin');
      let size = 0, at = 0;
      try { size = fs.statSync(body).size; at = JSON.parse(fs.readFileSync(meta, 'utf8')).savedAt || 0; } catch (_) {}
      return { meta, body, size, at };
    }).sort((a, b) => b.at - a.at);
    let total = 0;
    for (const it of items) {
      total += it.size;
      if (total > max) { try { fs.unlinkSync(it.body); fs.unlinkSync(it.meta); } catch (_) {} }
    }
  }

  async _download(url, accept) {
    if (this.offline) throw new Error('offline');
    if (this.inflight.has(url)) return this.inflight.get(url);
    const job = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        await this._slot();
        const res = await this.fetch(url, { signal: ctrl.signal, headers: { accept } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        const css = accept.startsWith('text/css');
        const type = (res.headers.get('content-type') || '').split(';')[0].trim() || (css ? 'text/css' : 'font/woff2');
        // Ett nät som svarar med en egen sida (inloggning, filter) ska inte sparas som typsnitt.
        if (css ? !/^text\/css$/i.test(type) || !body.toString('utf8').includes('@font-face') : !looksLikeFont(body)) throw new Error('Svaret var inget typsnitt.');
        this._write(url, body, type);
        return { body, type, savedAt: Date.now() };
      } finally { clearTimeout(t); this.inflight.delete(url); this._release(); }
    })();
    this.inflight.set(url, job);
    return job;
  }

  // CSS: den sparade om den är färsk, annars från nätet (och den sparade om nätet saknas).
  async css(url) {
    if (!isFontCss(url)) throw new Error('Bara Google Fonts.');
    const cached = this._read(url);
    if (cached && (this.offline || Date.now() - cached.savedAt < CSS_MAX_AGE)) {
      // Hämtades inte alla latin-typsnitt förra gången (t.ex. på ett dåligt nät): försök igen.
      if (!this.offline) this.prefetch(cached.body.toString('utf8'));
      return cached;
    }
    try {
      const got = await this._download(url, 'text/css,*/*;q=0.1');
      this.prefetch(got.body.toString('utf8'));
      return got;
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  }

  async file(url) {
    if (!isFontFile(url)) throw new Error('Bara Google Fonts.');
    return this._read(url) || this._download(url, '*/*');
  }

  // Hämtar latin-typsnitten i bakgrunden så att de finns när nätet försvinner.
  prefetch(css) {
    const missing = fontFilesIn(css, true).filter((u) => !this.has(u)).slice(0, 40);
    if (!missing.length || this.offline) return;
    Promise.allSettled(missing.map((u) => this._download(u, '*/*'))).then(() => this.onChange());
  }

  // Hur många av deckets typsnitt-CSS:er (med latin-filer) som finns sparade.
  status(cssUrls) {
    let ready = 0;
    for (const u of cssUrls) {
      const c = this._read(u);
      if (c && fontFilesIn(c.body.toString('utf8'), true).every((f) => this.has(f))) ready++;
    }
    return { count: cssUrls.length, ready };
  }
}
