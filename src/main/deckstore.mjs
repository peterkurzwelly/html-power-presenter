// deckstore.mjs — håller källtexten för det öppna decket och gör exakta ändringar i den.
//
// Idé: när en fil öppnas läggs ett attribut data-hp-id="N" in i varje elements
// starttagg i <body>. Den märkta texten ("inst") är det som visas i appen, så varje
// element i den levande sidan kan kopplas tillbaka till sin plats i källan.
//
// En textändring ersätter bara innehållet mellan elementets start- och sluttagg i
// den märkta texten. Vid sparning tas exakt de insatta attributen bort igen, så
// allt du inte rört förblir byte för byte identiskt med originalfilen.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'parse5';

const ID_ATTR = 'data-hp-id';
const ID_TOKEN = / data-hp-id="\d+"/g;
const MAX_UNDO = 40;

export function instrument(src) {
  const doc = parse(src, { sourceCodeLocationInfo: true });
  const body = findBody(doc);
  const inserts = [];
  let next = 0;

  const visit = (node) => {
    const kids = node.childNodes || [];
    for (const child of kids) {
      if (child.tagName) {
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
    }
  };
  if (body) visit(body);

  inserts.sort((a, b) => a.at - b.at);
  let out = '';
  let last = 0;
  for (const ins of inserts) {
    out += src.slice(last, ins.at) + ins.text;
    last = ins.at;
  }
  return out + src.slice(last);
}

export function strip(inst) {
  return inst.replace(ID_TOKEN, '');
}

function findBody(doc) {
  const html = (doc.childNodes || []).find((n) => n.tagName === 'html');
  return html && (html.childNodes || []).find((n) => n.tagName === 'body');
}

function hasAttr(node, name) {
  return (node.attrs || []).some((a) => a.name === name);
}

function locate(inst, id) {
  const doc = parse(inst, { sourceCodeLocationInfo: true });
  const want = String(id);
  let found = null;
  const visit = (node) => {
    for (const child of node.childNodes || []) {
      if (found) return;
      if (child.tagName) {
        const a = (child.attrs || []).find((x) => x.name === ID_ATTR);
        if (a && a.value === want) { found = child; return; }
        visit(child);
        if (child.content) visit(child.content);
      }
    }
  };
  visit(doc);
  if (!found || !found.sourceCodeLocation) return null;
  const loc = found.sourceCodeLocation;
  if (!loc.startTag) return null;
  const innerStart = loc.startTag.endOffset;
  const innerEnd = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
  return { start: loc.startOffset, end: loc.endOffset, innerStart, innerEnd };
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
  }

  get name() { return this.path ? path.basename(this.path) : ''; }
  get dirty() { return this.inst !== this.savedInst; }

  load(p) {
    const src = fs.readFileSync(p, 'utf8');
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

  _commit(next) {
    if (next === this.inst) return false;
    this.undoStack.push(this.inst);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.inst = next;
    return true;
  }

  replaceInner(id, html) {
    const loc = locate(this.inst, id);
    if (!loc) throw new Error('Hittade inte elementet i källfilen.');
    const next = this.inst.slice(0, loc.innerStart) + html + this.inst.slice(loc.innerEnd);
    return this._commit(next);
  }

  remove(id) {
    const loc = locate(this.inst, id);
    if (!loc) throw new Error('Hittade inte elementet i källfilen.');
    const next = this.inst.slice(0, loc.start) + this.inst.slice(loc.end);
    return this._commit(next);
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
    const out = strip(this.inst);
    if (!this.backedUp && target === this.path && fs.existsSync(this.path)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const base = path.basename(this.path, path.extname(this.path));
      fs.copyFileSync(this.path, path.join(this.backupDir, `${base}.${stamp}${path.extname(this.path)}`));
      this.backedUp = true;
    }
    fs.writeFileSync(target, out, 'utf8');
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
    };
  }
}
