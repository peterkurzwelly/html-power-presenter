// importer.mjs — gör om slides från ett annat deck så att de fungerar i det öppna decket.
//
// - Relativa sökvägar (bilder, video, typsnitt) pekar om och filerna kopieras in i
//   det öppna deckets mapp, eftersom ett deck bara får läsa sin egen mapp.
// - Slide-elementet får det öppna deckets tagg och klasser, så att appen och
//   deckets egen navigering känner igen det som en slide.
// - "Behåll originalets utseende": innehållet läggs i en inre ruta med källdeckets
//   CSS, avgränsad med @scope till just den rutan, i originalstorlek och skalad för
//   att passa. Det öppna decket styr fortfarande när sliden syns.

import fs from 'node:fs';
import path from 'node:path';
import { parseFragment } from 'parse5';

const ASSET_EXT = /\.(css|png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|m4v|webm|mov|ogv|mp3|wav|m4a|ogg|aac|flac|woff2?|ttf|otf|eot|pdf|json|vtt|srt)$/i;
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/\/|\/|#|\{|\$)/i;

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');
const slug = (s) => String(s).replace(/\.[^.]+$/, '').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'deck';

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

// Pekar om relativa sökvägar från källdeckets mapp till det öppna deckets mapp och
// kopierar filerna dit. `copied` fylls med sökvägar (relativt det öppna decket).
export function makeUrlRewriter(srcDir, dstDir, srcName, copied) {
  if (path.resolve(srcDir) === path.resolve(dstDir)) return (text) => text;
  const prefix = `assets-from-${slug(srcName)}`;
  const memo = new Map();
  let realSrc;
  try { realSrc = fs.realpathSync(srcDir); } catch { realSrc = path.resolve(srcDir); }

  const fix = (u, needsAssetExt) => {
    const raw = u.trim();
    if (!raw || ABSOLUTE.test(raw)) return u;
    const cut = raw.search(/[?#]/);
    const p = cut >= 0 ? raw.slice(0, cut) : raw;
    const suffix = cut >= 0 ? raw.slice(cut) : '';
    if (needsAssetExt && !ASSET_EXT.test(p)) return u;
    if (memo.has(p)) return memo.get(p) + suffix;
    let decoded = p;
    try { decoded = decodeURI(p); } catch (_) { /* behåll som den är */ }
    // Samma regel som när decket visas: bara filer i dess egen mapp (efter symlänkar).
    // Annars kunde ett deck få t.ex. ../../.ssh/id_rsa kopierad till din mapp.
    let abs;
    try { abs = fs.realpathSync(path.resolve(srcDir, decoded)); } catch { return u; }
    const relInSrc = path.relative(realSrc, abs);
    if (!relInSrc || relInSrc.startsWith('..') || path.isAbsolute(relInSrc)) return u;
    try { if (!fs.statSync(abs).isFile()) return u; } catch { return u; }
    const candidates = [relInSrc, path.join(prefix, relInSrc)];
    let destRel = null;
    for (const c of candidates) {
      const dest = path.join(dstDir, c);
      if (!fs.existsSync(dest) || sameBytes(dest, abs)) { destRel = c; break; }
    }
    if (!destRel) {
      const base = path.join(prefix, path.basename(abs));
      const ext = path.extname(base);
      for (let n = 2; n < 1000 && !destRel; n++) {
        const c = base.slice(0, base.length - ext.length) + '-' + n + ext;
        if (!fs.existsSync(path.join(dstDir, c))) destRel = c;
      }
    }
    const dest = path.join(dstDir, destRel);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      copied.push(destRel.split(path.sep).join('/'));
    }
    let out = destRel.split(path.sep).join('/');
    if (p.includes('%')) out = encodeURI(out);
    memo.set(p, out);
    return out + suffix;
  };

  return (text) => text
    .replace(/(\s(?:src|poster|data-src|xlink:href)\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, u) => a + q + fix(u, false) + q)
    .replace(/(\shref\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, u) => a + q + fix(u, true) + q)
    .replace(/(\s(?:srcset|data-srcset)\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, v) => a + q + rewriteSrcset(v, (u) => fix(u, false)) + q)
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => `url(${q}${fix(u, false)}${q})`);
}

// srcset: "url beskrivning, url beskrivning". En adress går fram till blanksteg (den kan
// innehålla komman, t.ex. data:-adresser). Bara adresserna byts; resten lämnas som det var.
export function rewriteSrcset(value, fixUrl) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ws = /^[\s,]*/.exec(value.slice(i))[0];
    out += ws; i += ws.length;
    if (i >= value.length) break;
    let url = /^\S+/.exec(value.slice(i))[0];
    i += url.length;
    let trail = '';
    const t = /,+$/.exec(url);
    if (t) { trail = t[0]; url = url.slice(0, -trail.length); }
    out += (/^data:/i.test(url) ? url : fixUrl(url)) + trail;
    if (trail) continue;
    const desc = /^[^,]*/.exec(value.slice(i))[0];
    out += desc; i += desc.length;
  }
  return out;
}

// All CSS som det öppna decket har: <style>-block och lokala länkade stilmallar.
export function deckCssText(inst, deckPath) {
  let css = '';
  for (const m of inst.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css += m[1] + '\n';
  for (const m of inst.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(m[0])) continue;
    const h = /href\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (!h || ABSOLUTE.test(h[1])) continue;
    try { css += fs.readFileSync(path.resolve(path.dirname(deckPath), h[1].split(/[?#]/)[0]), 'utf8') + '\n'; } catch (_) { /* saknas */ }
  }
  return css;
}

// Hur stor andel av källdeckets klasser som det öppna decket har CSS för (0–1).
// Högt värde = troligen samma mall, då behövs källdeckets stilar inte.
export function classCoverage(sourceText, targetCss) {
  const body = sourceText.slice(Math.max(0, sourceText.search(/<body[\s>]/i)));
  const classes = new Set();
  for (const m of body.matchAll(/\sclass\s*=\s*["']([^"']*)["']/gi)) m[1].split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
  if (!classes.size) return 1;
  let hit = 0;
  classes.forEach((c) => {
    const re = new RegExp('\\.' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    if (re.test(targetCss)) hit++;
  });
  return hit / classes.size;
}

function rootOf(html) {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  const root = frag.childNodes.find((n) => n.tagName);
  if (!root || !root.sourceCodeLocation || !root.sourceCodeLocation.startTag) return null;
  return root;
}

function applyEdits(text, edits) {
  edits.sort((a, b) => b.at - a.at || (b.order || 0) - (a.order || 0));
  for (const e of edits) text = text.slice(0, e.at) + e.text + text.slice(e.at + (e.del || 0));
  return text;
}

const TITLE_ATTRS = new Set(['aria-label', 'data-screen-label', 'data-title', 'title', 'data-notes', 'id']);

// Gör en slide-bit (omärkt HTML, ev. med kommentarer först) redo för det öppna decket.
//   target: { slideTag, commonClasses, strategy, size }
//   style:  resultat från controller.collectStyles för sliden, eller null (anpassa till decket)
//   source: { name, size, activeClasses }
//   note:   anteckning som ska läggas in som <aside class="notes"> (eller '')
export function adaptChunk(html, { target, style, source, note, scopeClass, rewrite }) {
  html = rewrite(html);
  let root = rootOf(html);
  if (!root) return html;
  let loc = root.sourceCodeLocation;
  const leadText = html.slice(0, loc.startOffset);
  const tag = /^[a-z][a-z0-9-]*$/.test(target.slideTag || '') && target.slideTag !== 'body' ? target.slideTag : root.tagName;
  const noteHtml = note ? `<aside class="notes">${escHtml(note)}</aside>` : '';
  const needsDataSlide = /\[data-slide\]/.test(target.strategy || '');

  if (!style) {
    // Anpassa till det öppna decket: samma element, med deckets tagg och klasser.
    // <style> inuti sliden avgränsas till sliden, så att den inte ändrar resten av decket.
    const findOwnStyles = () => [...html.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi)]
      .filter((m) => m.index >= loc.startTag.endOffset && m.index < (loc.endTag ? loc.endTag.startOffset : loc.endOffset));
    let ownStyles = findOwnStyles();
    // @keyframes och typsnitt i slidens egna stilar som krockar med det öppna deckets
    // får nya namn, även där de används i style-attribut.
    const rename = ownStyles.length && scopeClass ? hoistedNames(ownStyles.flatMap((m) => splitCss(m[2]).hoist), scopeClass, target.css) : null;
    if (rename && (rename.anim.size || rename.font.size)) {
      html = rewriteStyleAttrs(html, rename);
      root = rootOf(html);
      loc = root.sourceCodeLocation;
      ownStyles = findOwnStyles();
    }
    const edits = [];
    const classAttr = root.attrs.find((a) => a.name === 'class');
    const classes = classAttr ? classAttr.value.split(/\s+/).filter(Boolean) : [];
    const missing = (target.commonClasses || []).filter((c) => !classes.includes(c));
    // Stilar som redan avgränsats vid en tidigare import lämnas som de är.
    const fresh = ownStyles.filter((m) => !/@scope\s*\([^)]*\.hp-imp-/.test(m[2]));
    if (fresh.length && scopeClass) {
      missing.push(scopeClass);
      for (const m of fresh) {
        const at = m.index + m[1].length;
        edits.push({ at, del: m[2].length, text: scopeOwnCss(m[2], scopeClass, rename) });
      }
    }
    const nameEnd = loc.startTag.startOffset + 1 + root.tagName.length;
    if (missing.length) {
      const cl = loc.attrs && loc.attrs.class;
      if (cl) edits.push({ at: cl.startOffset, del: cl.endOffset - cl.startOffset, text: `class="${escAttr([...classes, ...missing].join(' '))}"` });
      else edits.push({ at: nameEnd, text: ` class="${escAttr(missing.join(' '))}"`, order: 1 });
    }
    if (needsDataSlide && !root.attrs.some((a) => a.name === 'data-slide')) edits.push({ at: nameEnd, text: ' data-slide', order: 2 });
    if (noteHtml && loc.endTag) edits.push({ at: loc.endTag.startOffset, text: noteHtml });
    if (tag !== root.tagName && loc.endTag) {
      edits.push({ at: loc.endTag.startOffset + 2, del: root.tagName.length, text: tag, order: 1 });
      edits.push({ at: loc.startTag.startOffset + 1, del: root.tagName.length, text: tag });
    }
    return applyEdits(html, edits);
  }

  // Behåll originalets utseende: ny slide i det öppna decket, med en inre ruta som
  // ser ut och beter sig som källdeckets slide.
  // @keyframes och typsnitt från källdecket får egna namn, så att de inte krockar med
  // det öppna deckets (t.ex. två olika "fadeIn" eller "Brand").
  const rename = hoistedNames(style.hoisted, scopeClass, target.css);
  const outerAttrs = [];
  const innerAttrs = [];
  for (const a of root.attrs) {
    if (a.name === 'class') continue;
    const value = a.name === 'style' ? renameInDecls(a.value, rename, "'") : a.value;
    (TITLE_ATTRS.has(a.name) ? outerAttrs : innerAttrs).push(value === '' ? a.name : `${a.name}="${escAttr(value)}"`);
  }
  const srcClasses = (root.attrs.find((a) => a.name === 'class') || { value: '' }).value.split(/\s+/).filter(Boolean);
  const innerClasses = [...srcClasses, ...(source.activeClasses || []).filter((c) => !srcClasses.includes(c))];
  const outerClasses = [...(target.commonClasses || [])];
  if (needsDataSlide) outerAttrs.push('data-slide');

  const sw = source.size.w, sh = source.size.h, tw = target.size.w, th = target.size.h;
  const s = Math.min(tw / sw, th / sh);
  const box = `position:absolute;left:${round((tw - sw * s) / 2)}px;top:${round((th - sh * s) / 2)}px;width:${sw}px;height:${sh}px;box-sizing:border-box;overflow:hidden;`
    + (Math.abs(s - 1) > 1e-3 ? `transform:scale(${round(s, 5)});transform-origin:0 0;` : '');

  const comment = `/* Stilar från ”${String(source.name).replace(/\*\//g, '')}”, avgränsade till den här sliden. */`;
  const scoped = style.scoped.map((r) => renameInDecls(r, rename));
  const css = rewrite([
    comment,
    ...style.hoisted.map((r) => renameHoisted(r, rename)),
    // @scope gäller bara element INUTI roten, så roten är en ram runt källdeckets
    // slide-element (som då träffas av t.ex. .page och .page h1).
    `@scope (.${scopeClass}) {`,
    `:scope { ${box} }`,
    ':scope > * { position: relative; width: 100%; height: 100%; box-sizing: border-box; }',
    style.inherit ? `:scope { ${renameInDecls(style.inherit, rename)} }` : '',
    ...scoped,
    '}',
  ].filter(Boolean).join('\n')).replace(/<\/style/gi, '<\\/style');
  const links = (style.links || []).filter((h) => /^https?:\/\//i.test(h)).map((h) => `<link rel="stylesheet" href="${escAttr(h)}">`).join('');

  // Stilmallar inuti sliden skulle gälla hela decket. Deras regler för sliden finns
  // redan i det avgränsade blocket ovan, så de tas bort här.
  const inner = rewriteStyleAttrs(withoutStylesheets(loc.endTag ? html.slice(loc.startTag.endOffset, loc.endTag.startOffset) : html.slice(loc.startTag.endOffset, loc.endOffset)), rename);
  const open = (name, cls, attrs) => `<${name}${cls.length ? ` class="${escAttr(cls.join(' '))}"` : ''}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  return leadText
    + open(tag, outerClasses, outerAttrs)
    + links + `<style data-hp-import>\n${css}\n</style>`
    + open('div', [scopeClass], []) + open('div', innerClasses, innerAttrs) + inner + '</div></div>'
    + noteHtml
    + `</${tag}>`;
}

function withoutStylesheets(html) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*stylesheet[^>]*>/gi, '');
}

const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Namn på @keyframes och @font-face-familjer i de lyfta reglerna → nya, unika namn.
// Med `targetCss` byts bara namn som det öppna decket också definierar (annars finns
// ingen krock, och då får t.ex. var(--font) fortsätta peka på samma namn).
function hoistedNames(hoisted, suffix, targetCss = null) {
  const anim = new Map();
  const font = new Map();
  const clashes = (re) => targetCss == null || re.test(targetCss);
  for (const raw of hoisted) {
    const r = raw.trim();
    const k = /^@(?:-webkit-)?keyframes\s+(["']?)([^\s{"']+)\1/i.exec(r);
    if (k && clashes(new RegExp(`@(?:-webkit-)?keyframes\\s+["']?${reEsc(k[2])}["']?\\s*\\{`, 'i'))) anim.set(k[2], `${k[2]}-${suffix}`);
    if (/^@font-face/i.test(r)) {
      const f = /font-family\s*:\s*(["']?)([^;"'}]+?)\1\s*[;}]/i.exec(r);
      const name = f && f[2].trim();
      if (name && clashes(new RegExp(`@font-face\\s*\\{[^}]*font-family\\s*:\\s*["']?${reEsc(name)}["']?\\s*[;}]`, 'i'))) font.set(name, `${name} ${suffix}`);
    }
  }
  return { anim, font };
}

// Delar CSS i satser på översta nivån. @keyframes, @font-face och @property gäller hela
// dokumentet och kan inte ligga i @scope; @import, @charset m.fl. måste stå först.
export function splitCss(css) {
  const parts = [];
  let depth = 0, start = 0, i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 2; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < css.length && css[j] !== c) { if (css[j] === '\\') j++; j++; } i = j + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth = Math.max(0, depth - 1); if (depth === 0) { parts.push(css.slice(start, i + 1)); start = i + 1; } }
    else if (c === ';' && depth === 0) { parts.push(css.slice(start, i + 1)); start = i + 1; }
    i++;
  }
  if (css.slice(start).trim()) parts.push(css.slice(start));
  const head = (t) => t.replace(/^(\s|\/\*[\s\S]*?\*\/)*/, '');
  const out = { top: [], hoist: [], body: [] };
  for (const p of parts) {
    const h = head(p);
    if (/^@(?:-webkit-)?keyframes\b|^@font-face\b|^@property\b/i.test(h)) out.hoist.push(p);
    else if (/^@(?:import|charset|namespace)\b/i.test(h) || /^@layer\s[^{]*;/i.test(h)) out.top.push(p);
    else out.body.push(p);
  }
  return out;
}

// En slides egen <style> (läget "anpassa"): reglerna gäller bara sliden. Roten för @scope
// är sliden förälder, men syskonen stängs ute, så att regler som pekar på själva
// slide-elementet (t.ex. #s3 eller .slide.dark) fortfarande gäller.
function scopeOwnCss(css, scopeClass, rename) {
  const { top, hoist, body } = splitCss(css);
  const names = rename || { anim: new Map(), font: new Map() };
  const lifted = hoist.map((r) => renameHoisted(r.trim(), names));
  const inner = renameInDecls(body.join(''), names);
  return [...top, ...lifted, `@scope (:has(> .${scopeClass})) to (:scope > :not(.${scopeClass})) {\n${inner}\n}`].join('\n');
}

// Byter namn i alla style="…"-attribut, med hjälp av var attributen faktiskt står i
// källan (inte en textsökning, som kunde träffa text i andra attribut eller skript).
function rewriteStyleAttrs(html, rename) {
  if (!rename || (!rename.anim.size && !rename.font.size)) return html;
  const edits = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.tagName) {
        const a = c.attrs.find((x) => x.name === 'style');
        const at = c.sourceCodeLocation && c.sourceCodeLocation.attrs && c.sourceCodeLocation.attrs.style;
        if (a && at) {
          const v = renameInDecls(a.value, rename, "'");
          if (v !== a.value) edits.push({ at: at.startOffset, del: at.endOffset - at.startOffset, text: `style="${escAttr(v)}"` });
        }
      }
      walk(c.content || c);
    }
  };
  walk(parseFragment(html, { sourceCodeLocationInfo: true }));
  return applyEdits(html, edits);
}

function renameHoisted(rule, { anim, font }) {
  let r = rule.replace(/^(@(?:-webkit-)?keyframes\s+)(["']?)([^\s{"']+)\2/i, (m, a, q, n) => a + q + (anim.get(n) || n) + q);
  if (/^@font-face/i.test(r)) r = r.replace(/(font-family\s*:\s*)(["']?)([^;"'}]+?)\2(\s*[;}])/i, (m, a, q, n, e) => `${a}"${font.get(n.trim()) || n.trim()}"${e}`);
  return r;
}

// Byter namnen i deklarationer som animation, animation-name, font och font-family.
// `q` är citattecknet runt typsnittsnamn: '"' i CSS, "'" inuti ett style="…"-attribut.
function renameInDecls(css, { anim, font }, q = '"') {
  if (!anim.size && !font.size) return css;
  // Egna egenskaper (--font-display: "Brand") kan bära namnen vidare via var().
  return css.replace(/(^|[;{\s])(--[\w-]+|(?:-webkit-)?animation(?:-name)?|font(?:-family)?)(\s*:\s*)([^;}]*)/gi, (m, pre0, prop, colon, val) => {
    const custom = prop.startsWith('--');
    const maps = custom ? [[font, true], [anim, false]] : [[/^font/i.test(prop) ? font : anim, /^font/i.test(prop)]];
    let v = val;
    for (const [map, quoted] of maps) {
      for (const [from, to] of map) {
        v = v.replace(new RegExp(`(^|[\\s,])(["']?)${reEsc(from)}\\2(?=$|[\\s,!;)])`, 'g'), (mm, pre) => `${pre}${quoted ? q : ''}${to}${quoted ? q : ''}`);
      }
    }
    return pre0 + prop + colon + v;
  });
}

function round(n, d = 2) { const f = 10 ** d; return Math.round(n * f) / f; }
