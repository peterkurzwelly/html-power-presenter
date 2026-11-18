// deckstore.mjs — håller källtexten för det öppna decket och gör exakta ändringar i den.
//
// Idé: när en fil öppnas läggs ett attribut data-hp-id="N" in i varje elements
// starttagg i <body>. Den märkta texten ("inst") är det som visas i appen, så varje
// element i den levande sidan kan kopplas tillbaka till sin plats i källan.
//
// En textändring ersätter bara innehållet mellan elementets start- och sluttagg i
// den märkta texten. Vid sparning tas exakt de insatta attributen bort igen, så
// allt utanför det du ändrat förblir byte för byte identiskt med originalfilen.
//
// Slides flyttas, dupliceras, tas bort och infogas som hela block ("bitar"): sliden
// plus HTML-kommentarerna precis före den. Det som står mellan bitarna (oftast
// bara radbrytningar) ligger kvar på sin plats.

import fs from 'node:fs';
import path from 'node:path';
import { parse, parseFragment, serialize } from 'parse5';

const ID_ATTR = 'data-hp-id';
const ID_TOKEN = / data-hp-id="\d+"/g;
const MAX_UNDO = 40;

/* ------------------------------------------------------------- märkning */

// Lägger in data-hp-id i varje element under rötterna. Returnerar ny text och nästa lediga id.
function addIds(src, roots, startId) {
  const inserts = [];
  let next = startId;
  const visit = (node) => {
    for (const child of node.childNodes || []) {
      if (!child.tagName) continue;
      const loc = child.sourceCodeLocation && child.sourceCodeLocation.startTag;
      if (loc && !hasAttr(child, ID_ATTR)) {
        let at = loc.endOffset - 1; // pekar på '>'
        if (src[at] === '>') {
          // "/>" är självstängande bara efter blanksteg eller citattecken; i
          // src=a.png/ hör snedstrecket till värdet. Viktigt för SVG-element.
          const attrLocs = Object.values(child.sourceCodeLocation.attrs || {});
          const lastAttrEnd = attrLocs.reduce((m, a) => Math.max(m, a.endOffset), 0);
          if (src[at - 1] === '/' && lastAttrEnd < at) at -= 1;
          inserts.push({ at, text: ` ${ID_ATTR}="${next++}"` });
        }
      }
      visit(child);
      if (child.content) visit(child.content); // <template>
    }
  };
  roots.forEach(visit);

  inserts.sort((a, b) => a.at - b.at);
  let out = '';
  let last = 0;
  for (const ins of inserts) {
    out += src.slice(last, ins.at) + ins.text;
    last = ins.at;
  }
  return { text: out + src.slice(last), next };
}

export function instrument(src) {
  const body = findBody(parse(src, { sourceCodeLocationInfo: true }));
  return addIds(src, body ? [body] : [], 0).text;
}

// Märker ett HTML-fragment (t.ex. en infogad slide) med id:n från startId.
export function instrumentFragment(html, startId) {
  return addIds(html, [parseFragment(html, { sourceCodeLocationInfo: true })], startId);
}

export function strip(inst) {
  return inst.replace(ID_TOKEN, '');
}

function nextFreeId(inst) {
  let max = -1;
  for (const m of inst.matchAll(/ data-hp-id="(\d+)"/g)) max = Math.max(max, +m[1]);
  return max + 1;
}

function findBody(doc) {
  const html = (doc.childNodes || []).find((n) => n.tagName === 'html');
  return html && (html.childNodes || []).find((n) => n.tagName === 'body');
}

function hasAttr(node, name) {
  return (node.attrs || []).some((a) => a.name === name);
}

// Hittar element per id. `dupes` får id:n som förekommer på flera element, vilket
// händer när HTML:en är felnästlad (t.ex. <a>…<p>…</a>) och parsern klonar element.
function findByIds(inst, ids, dupes = null) {
  const want = new Set(ids.map(String));
  const found = new Map();
  const visit = (node) => {
    for (const child of node.childNodes || []) {
      if (!child.tagName) continue;
      const a = (child.attrs || []).find((x) => x.name === ID_ATTR);
      if (a && want.has(a.value)) {
        if (!found.has(a.value)) found.set(a.value, child);
        else if (dupes) dupes.add(a.value);
      }
      visit(child);
      if (child.content) visit(child.content);
    }
  };
  visit(parse(inst, { sourceCodeLocationInfo: true }));
  return found;
}

function locate(inst, id) {
  const dupes = new Set();
  const node = findByIds(inst, [id], dupes).get(String(id));
  if (!node || !node.sourceCodeLocation || !node.sourceCodeLocation.startTag) return null;
  if (dupes.size) throw new Error('Elementet är felnästlat i källfilen (t.ex. en länk som går över flera stycken) och kan inte ändras säkert här.');
  const loc = node.sourceCodeLocation;
  const innerStart = loc.startTag.endOffset;
  const innerEnd = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
  return { start: loc.startOffset, end: loc.endOffset, innerStart, innerEnd, node };
}

// Så som webbläsaren skulle skriva ut elementets innehåll om inget skript rört det.
function serializedInner(inst, loc) {
  const frag = parseFragment(loc.node, inst.slice(loc.innerStart, loc.innerEnd));
  return serialize(frag);
}

// Element vars innehåll är kod eller rå text: där får en textredigering aldrig ändra något.
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes', 'template', 'textarea', 'title', 'plaintext']);
const textOf = (n) => (n.childNodes || []).map((c) => (c.nodeName === '#text' ? c.value : textOf(c))).join('');

// Elementen (tagg + attribut) i dokumentordning. Ett <br> utan attribut räknas inte;
// för kod- och råtextelement räknas även innehållet.
function skeleton(contextNode, html) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (!c.tagName) continue;
      if (c.tagName === 'br' && !c.attrs.length) continue;
      let sig = c.tagName + ' ' + c.attrs.map((a) => `${a.name}=${a.value}`).sort().join(' ');
      if (RAW_TEXT.has(c.tagName)) sig += '\u0000' + textOf(c.content || c);
      out.push(sig);
      walk(c.content || c);
    }
  };
  walk(parseFragment(contextNode, html));
  return out;
}

const isSubsequence = (a, b) => { let j = 0; for (const x of b) if (x === a[j]) j++; return j === a.length; };

// En textredigering (contenteditable="plaintext-only") kan bara ändra text, ta bort
// element och lägga till <br>. Allt annat avvisas, så att ett skript i decket inte kan
// få appen att skriva in egen kod i filen.
function checkTextEdit(contextNode, before, after) {
  if (RAW_TEXT.has(contextNode.tagName)) throw new Error('Det här elementet innehåller kod och kan inte redigeras här.');
  if (serialize(parseFragment(contextNode, after)) !== after) throw new Error('Ändringen innehöll mer än text och sparades inte.');
  if (!isSubsequence(skeleton(contextNode, after), skeleton(contextNode, before))) throw new Error('Ändringen lade till element och sparades inte.');
}

/* ---------------------------------------------------------------- slides */

const isBlank = (n) => n.nodeName === '#text' && !/\S/.test(n.value);
const isComment = (n) => n.nodeName === '#comment';

// Bitarna för slides med de här id:na (i dokumentordning). Varje bit är sliden
// plus kommentarer direkt före den. Kräver att alla slides har samma förälder.
export function slideChunks(inst, ids) {
  const nodes = findByIds(inst, ids);
  const list = ids.map((id) => nodes.get(String(id)));
  if (list.some((n) => !n || !n.sourceCodeLocation)) throw new Error('Hittade inte alla slides i källfilen. Läs in filen igen (⌘R).');
  const parent = list[0].parentNode;
  if (list.some((n) => n.parentNode !== parent)) throw new Error('Slidesen ligger inte i samma behållare i källfilen, så de kan inte flyttas här.');
  const kids = parent.childNodes;
  const chunks = list.map((n) => {
    let lead = n.sourceCodeLocation.startOffset;
    for (let i = kids.indexOf(n) - 1; i >= 0; i--) {
      const k = kids[i];
      if (isComment(k)) { lead = k.sourceCodeLocation.startOffset; continue; }
      if (isBlank(k)) continue;
      break;
    }
    return { start: lead, end: n.sourceCodeLocation.endOffset };
  });
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].start < chunks[i - 1].end) throw new Error('Slidesens ordning i källfilen stämmer inte. Läs in filen igen (⌘R).');
  }
  return chunks;
}

// Området med slides som en lista: texts[i] är slide i (med kommentarerna före),
// gaps[i] är texten mellan slide i och i+1. Text i mellanrummen (skript, dolda slides,
// annat innehåll) slängs eller kopieras aldrig: den följer med när listan ändras.
function region(inst, ids) {
  const chunks = slideChunks(inst, ids);
  const texts = chunks.map((c) => inst.slice(c.start, c.end));
  const gaps = [];
  for (let i = 1; i < chunks.length; i++) gaps.push(inst.slice(chunks[i - 1].end, chunks[i].start));
  const ws = gaps.find(blank) ?? guessSep(inst, chunks[0]);
  return { inst, chunks, texts, gaps, ws };
}

const blank = (t) => !/\S/.test(t);

// Skriver tillbaka området. lead/tail är text som hamnar direkt före första / efter sista sliden.
function joinRegion(r, texts, gaps, lead = '', tail = '') {
  let body = texts[0];
  for (let i = 1; i < texts.length; i++) body += gaps[i - 1] + texts[i];
  return r.inst.slice(0, r.chunks[0].start) + lead + body + tail + r.inst.slice(r.chunks[r.chunks.length - 1].end);
}

// Två mellanrum blir ett när sliden mellan dem tas bort. '' = kanten (före första /
// efter sista sliden), där omgivande text redan har sitt radbyte och sin indrag.
function mergeGaps(a, b) {
  if (blank(a) && blank(b)) return a === '' || b === '' ? '' : a;
  if (blank(a)) return a === '' ? b.replace(/^\s+/, '') : b;
  if (blank(b)) return b === '' ? a.replace(/\s+$/, '') : a;
  return a.replace(/\s+$/, '') + b;
}

// Tar bort slides med de här indexen. Allt annat, även text mellan slidesen, blir kvar.
function removeFromRegion(r, drop) {
  const texts = r.texts.slice();
  const edges = ['', ...r.gaps, ''];
  for (const i of [...drop].sort((x, y) => y - x)) {
    texts.splice(i, 1);
    edges.splice(i, 2, mergeGaps(edges[i], edges[i + 1]));
  }
  return { texts, gaps: edges.slice(1, -1), lead: edges[0], tail: edges[edges.length - 1] };
}

// Lägger in nya slides så att de hamnar före slide `slot` (slot = antal → sist).
// Text mellan slide slot-1 och slot stannar direkt efter slot-1.
function insertIntoRegion(r, slot, newTexts) {
  const n = r.texts.length;
  const texts = r.texts.slice();
  const edges = ['', ...r.gaps, ''];
  texts.splice(slot, 0, ...newTexts);
  const fresh = newTexts.map(() => r.ws);
  if (slot === n) edges.splice(slot, 1, r.ws, ...fresh.slice(1), ''); // sist
  else edges.splice(slot, 1, edges[slot], ...fresh); // först eller mitt i
  return { texts, gaps: edges.slice(1, -1), lead: edges[0], tail: edges[edges.length - 1] };
}

const writeRegion = (r, res) => joinRegion(r, res.texts, res.gaps, res.lead, res.tail);

// Indraget radbyte som står före den första sliden, t.ex. "\n\n  ".
function guessSep(inst, chunk) {
  const before = inst.slice(Math.max(0, chunk.start - 200), chunk.start);
  const m = /(\n[ \t]*)$/.exec(before);
  return m ? '\n' + m[1] : '\n';
}

/* ----------------------------------------------------- anteckningar i JSON */

// Samma regler som controller.jsonNotes(): <script id="speaker-notes"> (vilken typ som
// helst) eller <script type="application/json" id="…note…">, med en lista, {notes: […]}
// eller {slides: [{notes}]}.
function jsonNotesBlock(inst) {
  // Första <script> i dokumentordning som är #speaker-notes, eller application/json med
  // "note" i id:t (som querySelector i kontrollern). Kommentarer och <template> räknas inte.
  let found = null;
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (found) return;
      if (c.tagName === 'template') continue;
      if (c.tagName === 'script' && c.sourceCodeLocation && c.sourceCodeLocation.endTag) {
        const attr = (name) => { const a = c.attrs.find((x) => x.name === name); return a ? a.value : null; };
        const id = attr('id');
        if (id === 'speaker-notes' || (attr('type') === 'application/json' && id && id.includes('note'))) { found = c; return; }
      }
      if (c.childNodes) walk(c);
    }
  };
  walk(parse(inst, { sourceCodeLocationInfo: true }));
  if (!found) return null;
  const start = found.sourceCodeLocation.startTag.endOffset;
  const end = found.sourceCodeLocation.endTag.startOffset;
  let value;
  try { value = JSON.parse(inst.slice(start, end)); } catch { return null; }
  if (Array.isArray(value)) return { start, end, value, list: value, shape: 'array' };
  if (value && Array.isArray(value.notes)) return { start, end, value, list: value.notes, shape: 'notes' };
  if (value && Array.isArray(value.slides)) return { start, end, value, list: value.slides, shape: 'slides' };
  return null;
}

// JSON i en <script> får inte innehålla </script eller <!--, då tar elementet slut för tidigt.
const scriptSafe = (json) => json.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\u0021--');

function writeJsonNotes(inst, block, list) {
  const old = inst.slice(block.start, block.end);
  const lead = /^\s*/.exec(old)[0];
  const trail = /\s*$/.exec(old)[0];
  const multiline = /\n/.test(old.trim());
  let body;
  if (block.shape === 'array') {
    body = multiline ? '[\n' + list.map((x) => JSON.stringify(x)).join(',\n') + '\n]' : JSON.stringify(list);
  } else {
    const value = { ...block.value, [block.shape]: list };
    body = multiline ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  }
  return inst.slice(0, block.start) + lead + scriptSafe(body) + trail + inst.slice(block.end);
}

// Kör en ändring av anteckningslistan, om decket har en. Listan räknas per slide: är den
// kortare än antalet slides fylls den ut för ändringen, och extra poster i slutet behålls.
// `make(note)` gör en ny post för en infogad slide.
function withJsonNotes(inst, count, change) {
  const block = jsonNotesBlock(inst);
  if (!block) return inst;
  const list = block.list.slice(0, count);
  const extra = block.list.slice(count);
  const padded = list.length < count;
  while (list.length < count) list.push(null);
  const make = (note) => (block.shape === 'slides' ? (note ? { notes: note } : {}) : (note || ''));
  let next = change(list, make);
  if (padded && !extra.length) while (next.length && next[next.length - 1] == null) next.pop();
  next = next.map((x) => (x === undefined ? null : x));
  return writeJsonNotes(inst, block, next.concat(extra));
}

/* ----------------------------------------------------------------- store */

// Läser filen som UTF-8. Är den något annat (t.ex. Latin-1) visas den ändå, men
// som skrivskyddad, så att å/ä/ö inte förstörs när den sparas.
// En UTF-8-BOM (EF BB BF) tas bort ur texten men kommer ihåg, så att den skrivs tillbaka.
export function readText(file) {
  const bytes = fs.readFileSync(file);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), utf8: true, bom };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), utf8: false, bom: false };
  }
}

export function writeText(file, text, bom = false) {
  fs.writeFileSync(file, (bom ? '\ufeff' : '') + text, 'utf8');
}

// Kopia i säkerhetskopiemappen med ett namn som aldrig skriver över en annan kopia.
export function backupFile(backupDir, file) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace('.', ',').slice(0, 23);
  const ext = path.extname(file);
  const base = `${path.basename(file, ext)}.${stamp}`;
  for (let n = 1; n < 1000; n++) {
    const dest = path.join(backupDir, `${base}${n > 1 ? '-' + n : ''}${ext}`);
    try { fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL); return dest; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  throw new Error('Kunde inte göra en säkerhetskopia.');
}

export class DeckStore {
  constructor({ backupDir }) {
    this.backupDir = backupDir;
    this.path = null;
    this.inst = '';
    this.savedInst = '';
    this.diskText = '';
    this.undoStack = [];
    this.redoStack = [];
    this.rev = 0;
    this.backedUp = false;
    this.readOnly = false;
    this.bom = false;
  }

  get name() { return this.path ? path.basename(this.path) : ''; }
  get dirty() { return this.inst !== this.savedInst; }

  load(p) {
    const { text: src, utf8, bom } = readText(p);
    this.readOnly = !utf8;
    this.bom = bom;
    this.path = path.resolve(p);
    this.diskText = src;
    this.inst = instrument(src);
    this.savedInst = this.inst;
    this.undoStack = [];
    this.redoStack = [];
    this.backedUp = false;
    this.rev += 1;
  }

  close() {
    this.path = null;
    this.inst = this.savedInst = this.diskText = '';
    this.undoStack = [];
    this.redoStack = [];
    this.rev += 1;
  }

  // HTML som serveras till visningsfönstren: märkt text + vår kontroller först i <head>.
  servedHtml(controllerUrl) {
    const tag = `<script src="${controllerUrl}"></script>`;
    const s = this.inst;
    for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
      const m = re.exec(s);
      if (m) return s.slice(0, m.index + m[0].length) + tag + s.slice(m.index + m[0].length);
    }
    return tag + s;
  }

  _commit(next, structural = false) {
    if (next === this.inst) return false;
    this.undoStack.push(this.inst);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.inst = next;
    if (structural) this.rev += 1; // slides har flyttats: vyerna måste laddas om
    return true;
  }

  // Kan texten i elementet redigeras säkert? Bara om det levande elementet (som
  // webbläsaren visar det) är detsamma som i källfilen, dvs. inget skript har ändrat det.
  canEdit(id, liveHtml) {
    const loc = locate(this.inst, id);
    if (!loc) return { ok: false, reason: 'Hittade inte texten i källfilen.' };
    if (serializedInner(this.inst, loc) !== liveHtml) {
      return { ok: false, reason: 'Den här texten ändras av deckets egna skript (t.ex. formler, kodfärgning eller animationer), så den kan inte redigeras här utan att skriptets resultat hamnar i filen. Ändra den i källfilen i stället.' };
    }
    return { ok: true };
  }

  replaceInner(id, html, orig) {
    this._writable();
    const loc = locate(this.inst, id);
    if (!loc) throw new Error('Hittade inte elementet i källfilen.');
    if (orig !== undefined && serializedInner(this.inst, loc) !== orig) {
      throw new Error('Texten hade ändrats av deckets skript, så ändringen sparades inte.');
    }
    checkTextEdit(loc.node, this.inst.slice(loc.innerStart, loc.innerEnd), html);
    const next = this.inst.slice(0, loc.innerStart) + html + this.inst.slice(loc.innerEnd);
    return this._commit(next);
  }

  _writable() {
    if (this.readOnly) throw new Error('Filen är inte sparad som UTF-8, så den öppnades skrivskyddad. Spara om den som UTF-8 för att kunna redigera.');
  }

  remove(id) {
    this._writable();
    const loc = locate(this.inst, id);
    if (!loc) throw new Error('Hittade inte elementet i källfilen.');
    const next = this.inst.slice(0, loc.start) + this.inst.slice(loc.end);
    return this._commit(next);
  }

  // ids = alla slides i nuvarande ordning, order = ny ordning som index (t.ex. [1, 0, 2]).
  reorderSlides(ids, order) {
    this._writable();
    if (order.length !== ids.length || new Set(order).size !== ids.length || order.some((i) => !(i >= 0 && i < ids.length))) {
      throw new Error('Ogiltig ordning.');
    }
    const r = region(this.inst, ids);
    // Text mellan slidesen stannar på sin plats; bara slidesen byter plats.
    let next = joinRegion(r, order.map((i) => r.texts[i]), r.gaps);
    next = withJsonNotes(next, ids.length, (arr) => order.map((i) => arr[i]));
    return this._commit(next, true);
  }

  removeSlides(ids, indices) {
    this._writable();
    const drop = new Set(indices);
    if ([...drop].some((i) => !(Number.isInteger(i) && i >= 0 && i < ids.length))) throw new Error('Ogiltig slide.');
    if (drop.size >= ids.length) throw new Error('Ett deck måste ha minst en slide kvar.');
    const r = region(this.inst, ids);
    let next = writeRegion(r, removeFromRegion(r, drop));
    next = withJsonNotes(next, ids.length, (arr) => arr.filter((_, i) => !drop.has(i)));
    return this._commit(next, true);
  }

  duplicateSlide(ids, index) {
    this._writable();
    if (!(Number.isInteger(index) && index >= 0 && index < ids.length)) throw new Error('Ogiltig slide.');
    const r = region(this.inst, ids);
    let id = nextFreeId(this.inst);
    const copy = r.texts[index].replace(/ data-hp-id="\d+"/g, () => ` ${ID_ATTR}="${id++}"`);
    let next = writeRegion(r, insertIntoRegion(r, index + 1, [copy]));
    next = withJsonNotes(next, ids.length, (arr) => { arr.splice(index + 1, 0, arr[index]); return arr; });
    return this._commit(next, true);
  }

  // Infogar färdiga slide-bitar (omärkt HTML) efter slide nummer `after` (-1 = först).
  insertSlides(ids, after, htmlChunks, notes = []) {
    this._writable();
    if (!(Number.isInteger(after) && after >= -1 && after < ids.length)) throw new Error('Ogiltig plats.');
    const r = region(this.inst, ids);
    let id = nextFreeId(this.inst);
    const fresh = htmlChunks.map((h) => { const f = instrumentFragment(strip(h), id); id = f.next; return f.text; });
    let next = writeRegion(r, insertIntoRegion(r, after + 1, fresh));
    next = withJsonNotes(next, ids.length, (arr, make) => { arr.splice(after + 1, 0, ...htmlChunks.map((_, i) => make(notes[i]))); return arr; });
    return this._commit(next, true);
  }

  // Ger slides ett fast id (data-slide-id="…") i källfilen, så att en slide kan kännas
  // igen även när ett AI-verktyg skriver om filen. Slides som redan har ett behåller det.
  setSlideIds(ids, values) {
    this._writable();
    if (!Array.isArray(ids) || !Array.isArray(values) || ids.length !== values.length || !ids.length) throw new Error('Ogiltiga id.');
    const found = findByIds(this.inst, ids);
    const taken = new Set([...this.inst.matchAll(/\sdata-slide-id\s*=\s*["']?([^"'\s>]*)/gi)].map((m) => m[1]));
    const inserts = [];
    const done = new Set(); // klonade slides kan dela samma element i källan
    ids.forEach((id, i) => {
      if (done.has(String(id))) return;
      done.add(String(id));
      const node = found.get(String(id));
      if (!node || !node.sourceCodeLocation || !node.sourceCodeLocation.startTag) throw new Error('Hittade inte sliden i källfilen.');
      if (hasAttr(node, 'data-slide-id')) return;
      let v = values[i];
      if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) throw new Error(`Ogiltigt id: ${String(v).slice(0, 80)}`);
      // Finns id:t redan någonstans i filen (t.ex. i ett kodexempel) får det ett nummer efter.
      if (taken.has(v)) { const base = v.slice(0, 58); let n = 2; while (taken.has(`${base}-${n}`)) n++; v = `${base}-${n}`; }
      taken.add(v);
      const token = ` ${ID_ATTR}="${id}"`;
      const st = node.sourceCodeLocation.startTag;
      const at = this.inst.indexOf(token, st.startOffset);
      if (at < 0 || at + token.length > st.endOffset) throw new Error('Slidens starttagg kunde inte läsas säkert.');
      inserts.push({ at: at + token.length, text: ` data-slide-id="${v}"` });
    });
    if (!inserts.length) return false;
    inserts.sort((a, b) => b.at - a.at);
    let next = this.inst;
    for (const ins of inserts) next = next.slice(0, ins.at) + ins.text + next.slice(ins.at);
    return this._commit(next, true);
  }

  // Källtexten för en slide (utan appens märkning), med HTML-kommentaren precis före.
  // Kräver inte att slidesen ligger i samma behållare, till skillnad från slideChunks.
  slideSource(id) {
    const loc = locate(this.inst, id);
    if (!loc) throw new Error('Hittade inte sliden i källfilen.');
    let start = loc.start;
    const before = this.inst.slice(Math.max(0, start - 2000), start);
    const m = /<!--(?:(?!-->)[\s\S])*-->\s*$/.exec(before);
    if (m) start -= before.length - m.index;
    return strip(this.inst.slice(start, loc.end));
  }

  // Raden (från 1) där elementet börjar. Märkningen lägger inte till några radbrytningar,
  // så raden stämmer med filen på disk så länge inget är osparat.
  lineOf(id) {
    const loc = locate(this.inst, id);
    if (!loc) return null;
    let line = 1;
    for (let i = this.inst.indexOf('\n'); i !== -1 && i < loc.start; i = this.inst.indexOf('\n', i + 1)) line++;
    return line;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.inst);
    this.inst = this.undoStack.pop();
    this.rev += 1;
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.inst);
    this.inst = this.redoStack.pop();
    this.rev += 1;
    return true;
  }

  // Skriver till disk. Första sparningen per öppning tar en kopia av originalet.
  save(target = this.path) {
    this._writable();
    const out = strip(this.inst);
    if (!this.backedUp && target === this.path && fs.existsSync(this.path)) {
      backupFile(this.backupDir, this.path);
      this.backedUp = true;
    }
    writeText(target, out, this.bom);
    if (target !== this.path) {
      this.path = path.resolve(target);
      this.backedUp = true;
    }
    this.diskText = out;
    this.savedInst = this.inst;
    return target;
  }

  state() {
    return {
      path: this.path,
      name: this.name,
      rev: this.rev,
      dirty: this.dirty,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      readOnly: this.readOnly,
    };
  }
}

/* ------------------------------------------- slides som hämtas från ett annat deck */

// Läser slides ur en annan fil (id:n från samma märkning som visades i förhandsvisningen).
// Returnerar omärkt HTML per slide, med kommentarerna före.
export function extractSlides(inst, ids, indices) {
  const all = slideChunks(inst, ids);
  return indices.map((i) => strip(inst.slice(all[i].start, all[i].end)));
}

// Tar bort slides ur en annan fil på disk (vid "flytta"). Säkerhetskopierar först.
// Räknar ut den andra filens nya text utan att skriva något. Kastar om det inte går,
// så att "flytta" kan stoppas innan något har ändrats.
export function planRemoveSlidesFromFile(file, ids, indices, expectedText) {
  const { text: src, utf8, bom } = readText(file);
  if (!utf8) throw new Error(`”${path.basename(file)}” är inte sparad som UTF-8, så slides kan inte flyttas därifrån. Kopiera dem i stället.`);
  if (expectedText !== undefined && src !== expectedText) throw new Error(`”${path.basename(file)}” har ändrats sedan du valde den. Välj filen igen.`);
  const store = new DeckStore({ backupDir: null });
  store.path = path.resolve(file);
  store.inst = instrument(src);
  store.removeSlides(ids, indices);
  return { file: store.path, src, out: strip(store.inst), bom };
}

// Skriver planen till disk, om filen inte har ändrats sedan. Säkerhetskopierar först.
export function applyRemovePlan(plan, backupDir) {
  const now = readText(plan.file);
  if (now.text !== plan.src) throw new Error(`”${path.basename(plan.file)}” ändrades medan slides flyttades. Inget togs bort där.`);
  const backup = backupFile(backupDir, plan.file);
  writeText(plan.file, plan.out, plan.bom);
  return backup;
}

export function removeSlidesFromFile(file, backupDir, ids, indices, expectedText) {
  return applyRemovePlan(planRemoveSlidesFromFile(file, ids, indices, expectedText), backupDir);
}
