// Enhetstester för deckstore: rundtur, flytt, borttagning, duplicering, infogning.
//   node scripts/unit-deckstore.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrument, strip, DeckStore, extractSlides, backupFile, planRemoveSlidesFromFile, removeSlidesFromFile } from '../src/main/deckstore.mjs';
import { makeUrlRewriter, rewriteSrcset, adaptChunk } from '../src/main/importer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const test = (name, fn) => { try { fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '\n ', e.message); } };

const DECK = `<!doctype html><html><head><title>t</title></head><body>
<main class="stage">
  <!-- 1 Titel -->
  <section class="slide"><h1>Ett</h1><aside class="notes">n1</aside></section>

  <!-- 2 -->
  <section class="slide"><h2>Två</h2></section>

  <section class="slide"><h2>Tre</h2></section>
</main>
<script type="application/json" id="speaker-notes">[
"a",
"b",
"c"
]</script>
</body></html>`;

function storeFor(text) {
  const s = new DeckStore({ backupDir: os.tmpdir() });
  s.path = '/tmp/x.html';
  s.inst = instrument(text);
  s.savedInst = s.inst;
  return s;
}
const slideIds = (inst) => [...inst.matchAll(/<section class="slide" data-hp-id="(\d+)"/g)].map((m) => m[1]);
const titles = (text) => [...text.matchAll(/<h[12]>(.*?)<\/h[12]>/g)].map((m) => m[1]);
const notes = (text) => JSON.parse(/id="speaker-notes">([\s\S]*?)<\/script>/.exec(text)[1]);

test('round trip on the demo deck is byte-identical', () => {
  const t = fs.readFileSync(path.join(root, 'examples/demo-deck.html'), 'utf8');
  assert.equal(strip(instrument(t)), t);
});

test('reorder moves slides with their comments, notes follow', () => {
  const s = storeFor(DECK);
  s.reorderSlides(slideIds(s.inst), [2, 0, 1]);
  const out = strip(s.inst);
  assert.deepEqual(titles(out), ['Tre', 'Ett', 'Två']);
  assert.deepEqual(notes(out), ['c', 'a', 'b']);
  assert.ok(out.indexOf('<!-- 1 Titel -->') < out.indexOf('<h1>Ett'), 'comment stays with its slide');
  assert.ok(out.indexOf('<!-- 1 Titel -->') > out.indexOf('<h2>Tre'));
  assert.equal(out.length, DECK.length, 'nothing added or lost');
});

test('reorder then reverse gives back the original bytes', () => {
  const s = storeFor(DECK);
  s.reorderSlides(slideIds(s.inst), [2, 0, 1]);
  s.reorderSlides(slideIds(s.inst), [1, 2, 0]);
  assert.equal(strip(s.inst), DECK);
});

test('remove slide drops it, its comment and its note', () => {
  const s = storeFor(DECK);
  s.removeSlides(slideIds(s.inst), [1]);
  const out = strip(s.inst);
  assert.deepEqual(titles(out), ['Ett', 'Tre']);
  assert.ok(!out.includes('<!-- 2 -->'));
  assert.deepEqual(notes(out), ['a', 'c']);
});

test('cannot remove every slide', () => {
  const s = storeFor(DECK);
  assert.throws(() => s.removeSlides(slideIds(s.inst), [0, 1, 2]));
});

test('duplicate gives fresh unique ids', () => {
  const s = storeFor(DECK);
  s.duplicateSlide(slideIds(s.inst), 0);
  assert.deepEqual(titles(strip(s.inst)), ['Ett', 'Ett', 'Två', 'Tre']);
  const all = [...s.inst.matchAll(/data-hp-id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(all).size, all.length, 'ids are unique');
  assert.deepEqual(notes(strip(s.inst)), ['a', 'a', 'b', 'c']);
});

test('insert slides from another deck after slide 1', () => {
  const s = storeFor(DECK);
  const other = instrument('<!doctype html><body><div class="slide"><h2>X</h2></div><div class="slide"><h2>Y</h2></div></body>');
  const oids = [...other.matchAll(/<div class="slide" data-hp-id="(\d+)"/g)].map((m) => m[1]);
  const chunks = extractSlides(other, oids, [1]);
  assert.equal(chunks[0], '<div class="slide"><h2>Y</h2></div>');
  s.insertSlides(slideIds(s.inst), 0, chunks, ['ny']);
  const out = strip(s.inst);
  assert.deepEqual(titles(out), ['Ett', 'Y', 'Två', 'Tre']);
  assert.deepEqual(notes(out), ['a', 'ny', 'b', 'c']);
  const all = [...s.inst.matchAll(/data-hp-id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(all).size, all.length, 'ids are unique');
  assert.ok(/<div class="slide" data-hp-id="\d+"><h2 data-hp-id="\d+">Y/.test(s.inst), 'inserted slide is instrumented');
});

test('undo restores the text before a structural change', () => {
  const s = storeFor(DECK);
  const before = s.inst;
  s.reorderSlides(slideIds(s.inst), [1, 0, 2]);
  s.undo();
  assert.equal(s.inst, before);
});

test('slides in different containers refuse to move', () => {
  const s = storeFor('<!doctype html><body><div><section class="slide">a</section></div><div><section class="slide">b</section></div></body>');
  assert.throws(() => s.reorderSlides(slideIds(s.inst), [1, 0]), /samma behållare/);
});

test('text changed by a deck script cannot be edited', () => {
  const s = storeFor('<!doctype html><body><section class="slide"><p>Hej <b>där</b></p></section></body>');
  const id = /<p data-hp-id="(\d+)"/.exec(s.inst)[1];
  const bId = /<b data-hp-id="(\d+)"/.exec(s.inst)[1];
  const live = `Hej <b data-hp-id="${bId}">där</b>`;
  assert.equal(s.canEdit(id, live).ok, true);
  assert.equal(s.canEdit(id, live + '<span class="katex">x</span>').ok, false);
  assert.throws(() => s.replaceInner(id, 'Hej', 'något annat'), /skript/);
  s.replaceInner(id, 'Hej alla', live);
  assert.match(strip(s.inst), /<p>Hej alla<\/p>/);
});

test('misnested tags refuse to be edited instead of splicing the wrong range', () => {
  const s = storeFor('<!doctype html><body><section class="slide"><p><b>ett</p><p>två</b></p></section></body>');
  const bId = /<b data-hp-id="(\d+)"/.exec(s.inst)[1];
  assert.throws(() => s.replaceInner(bId, 'x'), /felnästlat/);
  assert.throws(() => s.remove(bId), /felnästlat/);
});

test('a file that is not UTF-8 opens read-only and is never written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-unit-'));
  const file = path.join(dir, 'latin1.html');
  const bytes = Buffer.from('<!doctype html><body><section class="slide"><p>R\xe4ksm\xf6rg\xe5s</p></section></body>', 'latin1');
  fs.writeFileSync(file, bytes);
  const s = new DeckStore({ backupDir: dir });
  s.load(file);
  assert.equal(s.readOnly, true);
  assert.match(strip(s.inst), /Räksmörgås/);
  const id = /<p data-hp-id="(\d+)"/.exec(s.inst)[1];
  assert.throws(() => s.replaceInner(id, 'x'), /UTF-8/);
  assert.throws(() => s.removeSlides([/<section class="slide" data-hp-id="(\d+)"/.exec(s.inst)[1]], [0]), /UTF-8/);
  assert.deepEqual(fs.readFileSync(file), bytes);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importing copies only files from the other deck\'s own folder', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-unit-'));
  const src = path.join(base, 'src'), dst = path.join(base, 'dst');
  fs.mkdirSync(path.join(src, 'img'), { recursive: true });
  fs.mkdirSync(dst);
  fs.writeFileSync(path.join(src, 'img', 'a.png'), 'png');
  fs.writeFileSync(path.join(base, 'secret'), 'key');
  fs.symlinkSync(path.join(base, 'secret'), path.join(src, 'img', 'link.png'));
  const copied = [];
  const rw = makeUrlRewriter(src, dst, 'src.html', copied);
  const out = rw('<img src="img/a.png"><img src="../secret"><img src="img/link.png"><div style="background:url(../secret)"></div>');
  assert.deepEqual(copied, ['img/a.png']);
  assert.equal(fs.readFileSync(path.join(dst, 'img', 'a.png'), 'utf8'), 'png');
  assert.match(out, /src="\.\.\/secret"/);
  assert.equal(fs.readdirSync(dst).join(), 'img');
  assert.deepEqual(fs.readdirSync(path.join(dst, 'img')), ['a.png']);
  fs.rmSync(base, { recursive: true, force: true });
});

const SCRIPTED = `<!doctype html><body><main>
  <section class="slide"><h2>A</h2></section>
  <script>chart('a')</script>
  <section class="slide"><h2>B</h2></section>
  <script>chart('b')</script>
  <section class="slide"><h2>C</h2></section>
  <script>chart('c')</script>
  <section class="slide"><h2>D</h2></section>
  <script>chart('d')</script>
</main></body>`;
const charts = (t) => [...t.matchAll(/chart\('(\w)'\)/g)].map((m) => m[1]).join('');

test('removing slides never drops text that sits between slides', () => {
  for (const drop of [[0], [1], [3], [0, 3], [1, 2]]) {
    const s = storeFor(SCRIPTED);
    s.removeSlides(slideIds(s.inst), drop);
    const out = strip(s.inst);
    assert.equal(charts(out), 'abcd', `drop ${drop}`);
    assert.equal(titles(out).join(''), 'ABCD'.split('').filter((_, i) => !drop.includes(i)).join(''), `drop ${drop}`);
  }
});

test('duplicating or inserting never copies text that sits between slides', () => {
  for (const i of [0, 2, 3]) {
    const s = storeFor(SCRIPTED);
    s.duplicateSlide(slideIds(s.inst), i);
    assert.equal(charts(strip(s.inst)), 'abcd', `dup ${i}`);
    assert.equal(titles(strip(s.inst)).length, 5);
  }
  for (const after of [-1, 1, 3]) {
    const s = storeFor(SCRIPTED);
    s.insertSlides(slideIds(s.inst), after, ['<section class="slide"><h2>X</h2></section>', '<section class="slide"><h2>Y</h2></section>']);
    const out = strip(s.inst);
    assert.equal(charts(out), 'abcd', `insert after ${after}`);
    const t = titles(out).join('');
    assert.equal(t.indexOf('XY'), after + 1, `insert after ${after}: ${t}`);
  }
});

test('a slide hidden from the app (not in its list) survives deletes', () => {
  const src = '<!doctype html><body><main>\n<section class="slide"><h2>A</h2></section>\n<section class="slide"><h2>B</h2></section>\n<section class="slide" data-visibility="hidden"><h2>X</h2></section>\n<section class="slide"><h2>C</h2></section>\n</main></body>';
  const s = storeFor(src);
  const all = [...s.inst.matchAll(/<section\b[^>]*data-hp-id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(all.length, 4);
  const visible = [all[0], all[1], all[3]];
  s.removeSlides(visible, [0]);
  assert.equal(titles(strip(s.inst)).join(''), 'BXC');
  s.undo();
  assert.equal(strip(s.inst), src);
});

test('removing then undoing restores the exact bytes', () => {
  const s = storeFor(SCRIPTED);
  s.removeSlides(slideIds(s.inst), [1]);
  s.duplicateSlide(slideIds(s.inst), 0);
  s.undo(); s.undo();
  assert.equal(strip(s.inst), SCRIPTED);
});

test('notes in the other forms the app reads are kept in step', () => {
  const body = '<section class="slide"><h2>A</h2></section>\n<section class="slide"><h2>B</h2></section>\n<section class="slide"><h2>C</h2></section>';
  const forms = [
    ['<script id="speaker-notes">["a","b","c"]</script>', (t) => JSON.parse(/speaker-notes">(.*?)<\/script>/s.exec(t)[1])],
    ['<script type="application/json" id="speaker-notes">{"notes":["a","b","c"],"v":1}</script>', (t) => JSON.parse(/speaker-notes">(.*?)<\/script>/s.exec(t)[1]).notes],
    ['<script type="application/json" id="deck-notes">{"slides":[{"notes":"a"},{"notes":"b"},{"notes":"c"}]}</script>', (t) => JSON.parse(/deck-notes">(.*?)<\/script>/s.exec(t)[1]).slides.map((x) => x.notes)],
  ];
  for (const [block, read] of forms) {
    const s = storeFor(`<!doctype html><body>\n${body}\n${block}</body>`);
    s.reorderSlides(slideIds(s.inst), [2, 0, 1]);
    assert.deepEqual(read(strip(s.inst)), ['c', 'a', 'b'], block);
  }
  // kortare lista än antalet slides: sista sliden saknar anteckning
  const s = storeFor(`<!doctype html><body>\n${body}\n<script id="speaker-notes">["a","b"]</script></body>`);
  s.reorderSlides(slideIds(s.inst), [2, 0, 1]);
  assert.deepEqual(JSON.parse(/speaker-notes">(.*?)<\/script>/s.exec(strip(s.inst))[1]), [null, 'a', 'b']);
});

test('notes containing </script> stay inside their script element', () => {
  const s = storeFor('<!doctype html><body><section class="slide">A</section><section class="slide">B</section><script type="application/json" id="speaker-notes">["Explain <\\/script> here","two"]</script></body>');
  s.reorderSlides(slideIds(s.inst), [1, 0]);
  s.insertSlides(slideIds(s.inst), 1, ['<section class="slide">C</section>'], ['ends with </script><!-- x']);
  const out = strip(s.inst);
  const m = /speaker-notes">([\s\S]*?)<\/script>/.exec(out);
  assert.deepEqual(JSON.parse(m[1]), ['two', 'Explain </script> here', 'ends with </script><!-- x']);
  assert.equal((out.match(/<\/script>/g) || []).length, 1);
});

test('a UTF-8 BOM is kept when the file is saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-unit-'));
  const file = path.join(dir, 'bom.html');
  const text = '<!doctype html><body><section class="slide"><p>Hej</p></section><section class="slide"><p>Två</p></section></body>';
  fs.writeFileSync(file, '﻿' + text);
  const s = new DeckStore({ backupDir: path.join(dir, 'bk') });
  s.load(file);
  s.reorderSlides(slideIds(s.inst), [1, 0]);
  s.save();
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  s.reorderSlides(slideIds(s.inst), [1, 0]);
  s.save();
  assert.equal(fs.readFileSync(file, 'utf8'), '﻿' + text);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backups of two files with the same name never overwrite each other', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-unit-'));
  fs.mkdirSync(path.join(dir, 'a')); fs.mkdirSync(path.join(dir, 'b'));
  fs.writeFileSync(path.join(dir, 'a', 'index.html'), 'A');
  fs.writeFileSync(path.join(dir, 'b', 'index.html'), 'B');
  const bk = path.join(dir, 'bk');
  const x = backupFile(bk, path.join(dir, 'a', 'index.html'));
  const y = backupFile(bk, path.join(dir, 'b', 'index.html'));
  assert.notEqual(x, y);
  assert.equal(fs.readFileSync(x, 'utf8'), 'A');
  assert.equal(fs.readFileSync(y, 'utf8'), 'B');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('moving every slide out of a file is refused before anything is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-unit-'));
  const file = path.join(dir, 'o.html');
  const text = '<!doctype html><body><section class="slide">A</section><section class="slide">B</section></body>';
  fs.writeFileSync(file, text);
  const ids = slideIds(instrument(text));
  assert.throws(() => planRemoveSlidesFromFile(file, ids, [0, 1], text), /minst en slide/);
  removeSlidesFromFile(file, path.join(dir, 'bk'), ids, [0], text);
  assert.equal(titles(fs.readFileSync(file, 'utf8')).length, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /<section class="slide">B<\/section>/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), />A</);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('srcset with data: addresses is left intact', () => {
  const v = 'data:image/png;base64,iVBORw0KGgo= 1x, img/a.png 2x';
  assert.equal(rewriteSrcset(v, (u) => 'X/' + u), 'data:image/png;base64,iVBORw0KGgo= 1x, X/img/a.png 2x');
  assert.equal(rewriteSrcset('a.png 1x,b.png 2x', (u) => u), 'a.png 1x,b.png 2x');
  assert.equal(rewriteSrcset('a.png, b.png 2x', (u) => '/' + u), '/a.png, /b.png 2x');
  assert.equal(rewriteSrcset('data:image/png;base64,AAA=, b.png 2x', (u) => '/' + u), 'data:image/png;base64,AAA=, /b.png 2x');
});

test('imported slides keep their stylesheets to themselves', () => {
  const target = { slideTag: 'section', commonClasses: ['slide'], strategy: 'section.slide', size: { w: 1600, h: 900 } };
  const source = { name: 'o.html', size: { w: 1280, h: 720 }, activeClasses: [] };
  const html = '<div class="page" style="animation: fadeIn 1s; font-family: Brand"><style>h1{color:red}</style><h1>Hi</h1></div>';
  const style = {
    hoisted: ['@keyframes fadeIn { from { opacity: 0 } }', '@font-face { font-family: "Brand"; src: url(b.woff2); }'],
    inherit: 'font-family: Brand, sans-serif',
    scoped: ['h1 { color: red; animation: fadeIn 2s; font-family: "Brand", serif; }'],
    links: [],
  };
  const out = adaptChunk(html, { target, style, source, note: '', scopeClass: 'hp-imp-1', rewrite: (t) => t });
  assert.equal((out.match(/<style/g) || []).length, 1, 'only the scoped block');
  assert.match(out, /@keyframes fadeIn-hp-imp-1/);
  assert.match(out, /font-family: "Brand hp-imp-1"/);
  assert.match(out, /animation: fadeIn-hp-imp-1 2s/);
  assert.match(out, /style="animation: fadeIn-hp-imp-1 1s; font-family: 'Brand hp-imp-1'"/);
  const plain = adaptChunk('<div class="page"><style>h1{color:red}</style><h1>Hi</h1></div>', { target, style: null, source, note: '', scopeClass: 'hp-imp-2', rewrite: (t) => t });
  assert.match(plain, /class="page slide hp-imp-2"/);
  assert.match(plain, /<style>@scope \(:has\(> \.hp-imp-2\)\) to \(:scope > :not\(\.hp-imp-2\)\) \{\nh1\{color:red\}\n\}<\/style>/);
});

test('a text edit can only change text, remove elements or add line breaks', () => {
  const src = '<!doctype html><body><section class="slide"><p>Hej <b>där</b> du</p></section></body>';
  const fresh = () => storeFor(src);
  let s = fresh();
  const id = /<p data-hp-id="(\d+)"/.exec(s.inst)[1];
  const bId = /<b data-hp-id="(\d+)"/.exec(s.inst)[1];
  const live = `Hej <b data-hp-id="${bId}">där</b> du`;
  s.replaceInner(id, `Hej <b data-hp-id="${bId}">alla</b><br>du`, live);
  s = fresh(); s.replaceInner(id, 'Hej du', live);
  for (const bad of [
    `Hej <b data-hp-id="${bId}">där</b><img src=x onerror="alert(1)">`,
    `Hej <b data-hp-id="${bId}" onclick="x()">där</b>`,
    'x</p></section><script>alert(1)</script>',
    'x</p></section>',
    '<i>Hej</i>',
  ]) {
    s = fresh();
    assert.throws(() => s.replaceInner(id, bad, live), /sparades inte/, bad);
    assert.equal(strip(s.inst), src);
  }
});

test('imported names are only changed when they clash, and var() keeps working', () => {
  const target = { slideTag: 'section', commonClasses: ['slide'], strategy: 'section.slide', size: { w: 1280, h: 720 } };
  const source = { name: 'o.html', size: { w: 1280, h: 720 }, activeClasses: [] };
  const style = {
    hoisted: ['@keyframes rise { to { opacity: 1 } }', '@font-face { font-family: "Brand"; src: url(b.woff2); }'],
    inherit: '--font-display: "Brand", serif; --enter: rise',
    scoped: ['h1 { font-family: var(--font-display); animation: var(--enter) 1s; }'],
    links: [],
  };
  const html = `<div class="page"><h1 data-tip='Tip: style="font-family: Brand" works'>Hi</h1><p style="font-family: Brand">x</p></div>`;
  // Inga krockar: inget byter namn.
  const calm = adaptChunk(html, { target: { ...target, css: '.x{}' }, style, source, note: '', scopeClass: 'hp-imp-1', rewrite: (t) => t });
  assert.match(calm, /@keyframes rise \{/);
  assert.match(calm, /--font-display: "Brand", serif/);
  // Det öppna decket har också "rise" och "Brand": då byts de, även i egna egenskaper.
  const css = '@keyframes rise { from { top: 0 } } @font-face { font-family: Brand; src: url(x.woff2) }';
  const out = adaptChunk(html, { target: { ...target, css }, style, source, note: '', scopeClass: 'hp-imp-2', rewrite: (t) => t });
  assert.match(out, /@keyframes rise-hp-imp-2/);
  assert.match(out, /--font-display: "Brand hp-imp-2", serif; --enter: rise-hp-imp-2/);
  assert.match(out, /<p style="font-family: 'Brand hp-imp-2'">/);
  assert.match(out, /data-tip='Tip: style="font-family: Brand" works'/, 'text in other attributes is left alone');
});

test('a slide\'s own <style> in adapt mode keeps @keyframes outside @scope', () => {
  const target = { slideTag: 'section', commonClasses: ['slide'], strategy: 'section.slide', size: { w: 1280, h: 720 }, css: '@keyframes pop { to { opacity: 0 } }' };
  const source = { name: 'o.html', size: { w: 1280, h: 720 }, activeClasses: [] };
  const out = adaptChunk('<section class="slide" id="s3"><style>@import url(x.css); #s3 { animation: pop 1s } @keyframes pop { to { opacity: 1 } }</style><h1>Hi</h1></section>', { target, style: null, source, note: '', scopeClass: 'hp-imp-3', rewrite: (t) => t });
  const css = /<style>([\s\S]*?)<\/style>/.exec(out)[1];
  assert.ok(css.indexOf('@import') < css.indexOf('@keyframes pop-hp-imp-3'), css);
  assert.ok(css.indexOf('@keyframes pop-hp-imp-3') < css.indexOf('@scope'), css);
  assert.match(css, /#s3 \{ animation: pop-hp-imp-3 1s \}/);
});

test('a text edit cannot smuggle code in through <br> attributes or code elements', () => {
  const src = '<!doctype html><body><section class="slide"><p>Hej<script>ok()</script></p></section></body>';
  const s = storeFor(src);
  const id = /<p data-hp-id="(\d+)"/.exec(s.inst)[1];
  const sId = /<script data-hp-id="(\d+)"/.exec(s.inst)[1];
  const live = `Hej<script data-hp-id="${sId}">ok()</script>`;
  assert.throws(() => s.replaceInner(id, `Hej<br onanimationstart="evil()">`, live), /sparades inte/);
  assert.throws(() => s.replaceInner(id, `Hej<script data-hp-id="${sId}">evil()</script>`, live), /sparades inte/);
  assert.throws(() => s.replaceInner(sId, 'evil()', 'ok()'), /kod/);
  assert.equal(strip(s.inst), src);
});

test('the notes list is found the same way the app reads it', () => {
  const body = '<section class="slide">A</section>\n<section class="slide">B</section>';
  const tricky = [
    '<script type="application/json" data-deck-id="main" id="speaker-notes">["a","b"]</script>',
    '<!-- <script id="speaker-notes">["old a","old b"]</script> -->\n<script id="speaker-notes">["a","b"]</script>',
  ];
  for (const block of tricky) {
    const s = storeFor(`<!doctype html><body>\n${body}\n${block}</body>`);
    s.reorderSlides(slideIds(s.inst), [1, 0]);
    const out = strip(s.inst);
    const live = [...out.matchAll(/<script[^>]*id="speaker-notes">(.*?)<\/script>/g)].map((m) => m[1]).pop();
    assert.deepEqual(JSON.parse(live), ['b', 'a'], block);
    if (block.includes('old')) assert.match(out, /\["old a","old b"\]/);
  }
});

// Valfritt: HP_REAL_DECKS=<mapp> kör samma kontroll på riktiga decks i en mapp.
if (process.env.HP_REAL_DECKS) test('real decks: reverse order twice is byte-identical', () => {
  const dir = process.env.HP_REAL_DECKS;
  const files = fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f) && fs.statSync(path.join(dir, f)).size < 50e6);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const s = storeFor(text);
    const ids = [...s.inst.matchAll(/<section\b[^>]*class="slide[^"]*"[^>]*data-hp-id="(\d+)"/g)].map((m) => m[1]);
    if (ids.length < 2) continue;
    const order = ids.map((_, i) => ids.length - 1 - i);
    try { s.reorderSlides(ids, order); } catch (e) { continue; }
    const ids2 = [...s.inst.matchAll(/<section\b[^>]*class="slide[^"]*"[^>]*data-hp-id="(\d+)"/g)].map((m) => m[1]);
    s.reorderSlides(ids2, order);
    assert.equal(strip(s.inst), text, f);
  }
});

if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nall passed');
