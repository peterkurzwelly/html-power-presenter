// versions.mjs — sparar en komprimerad kopia av varje version av ett deck som appen ser.
//
// En kopia tas när filen öppnas, läses in igen, ändras utanför appen (t.ex. när ett
// AI-verktyg skriver om den) och när du sparar. Samma innehåll som senaste kopian
// sparas inte igen. Varje deck får en egen mapp med index.json och .html.gz-filer.
// Gamla kopior rensas: högst `maxPerDeck` stycken och `maxBytesPerDeck` byte per deck.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const REASONS = {
  open: 'Öppnad',
  reload: 'Inläst igen',
  extern: 'Ändrad utanför appen',
  save: 'Sparad',
  restore: 'Återställd',
  'before-restore': 'Före återställning',
};

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

export class Versions {
  constructor(dir, { maxPerDeck = 40, maxBytesPerDeck = 300e6, maxFileBytes = 64e6 } = {}) {
    this.dir = dir;
    this.maxPerDeck = maxPerDeck;
    this.maxBytesPerDeck = maxBytesPerDeck;
    this.maxFileBytes = maxFileBytes;
    this.chains = new Map(); // en kö per deck, så att två kopior aldrig skrivs samtidigt
  }

  // Mappen för ett deck: filnamnet plus en hash av hela sökvägen.
  folderFor(file) {
    let real = path.resolve(file);
    try { real = fs.realpathSync(real); } catch (_) { /* filen kan ha flyttats */ }
    const base = path.basename(real).replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60) || 'deck';
    return path.join(this.dir, `${base}-${sha1(real).slice(0, 10)}`);
  }

  _readIndex(folder) {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(folder, 'index.json'), 'utf8'));
      return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && /^[\w,.-]+$/.test(e.id)) : [];
    } catch { return []; }
  }

  _writeIndex(folder, list) {
    const tmp = path.join(folder, `index.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
    fs.renameSync(tmp, path.join(folder, 'index.json'));
  }

  _queue(folder, fn) {
    const prev = this.chains.get(folder) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(folder, next.catch(() => {}));
    return next;
  }

  // Tar en kopia av filen som den ligger på disk nu. Returnerar posten, eller null om
  // innehållet är samma som senaste kopian (eller filen är för stor).
  // Filen läses direkt (inte när det blir dess tur i kön), så kopian är exakt det som
  // låg på disk när den togs.
  snapshot(file, reason, now = Date.now()) {
    const folder = this.folderFor(file);
    let size;
    try { size = fs.statSync(file).size; } catch { return Promise.resolve(null); }
    if (size > this.maxFileBytes) return Promise.resolve({ skipped: 'size', size });
    let buf;
    try { buf = fs.readFileSync(file); } catch { return Promise.resolve(null); }
    return this._queue(folder, async () => {
      const hash = sha1(buf);
      fs.mkdirSync(folder, { recursive: true });
      const list = this._readIndex(folder);
      if (list[0] && list[0].hash === hash) return null;
      const gz = await gzip(buf, { level: 6 });
      let id = new Date(now).toISOString().replace(/[:]/g, '-').replace('.', ',');
      for (let n = 2; list.some((e) => e.id === id); n++) id = id.replace(/(-\d+)?$/, `-${n}`);
      fs.writeFileSync(path.join(folder, `${id}.html.gz`), gz);
      const entry = { id, at: now, reason: REASONS[reason] ? reason : 'save', size: buf.length, stored: gz.length, hash, name: path.basename(file) };
      list.unshift(entry);
      this._prune(folder, list);
      this._writeIndex(folder, list);
      return entry;
    });
  }

  _prune(folder, list) {
    let bytes = 0;
    const keep = [];
    for (const e of list) {
      const stored = e.stored || e.size || 0;
      if (keep.length < this.maxPerDeck && (keep.length === 0 || bytes + stored <= this.maxBytesPerDeck)) { keep.push(e); bytes += stored; }
      else { try { fs.unlinkSync(path.join(folder, `${e.id}.html.gz`)); } catch (_) {} }
    }
    list.length = 0;
    list.push(...keep);
  }

  list(file) {
    return this._readIndex(this.folderFor(file)).map((e) => ({ ...e, label: REASONS[e.reason] || e.reason }));
  }

  async read(file, id) {
    if (typeof id !== 'string' || !/^[\w,.-]+$/.test(id)) throw new Error('Ogiltig version.');
    const folder = this.folderFor(file);
    if (!this._readIndex(folder).some((e) => e.id === id)) throw new Error('Versionen finns inte längre.');
    return gunzip(fs.readFileSync(path.join(folder, `${id}.html.gz`)));
  }
}
