// Unit tests for the studio features: time budgets, version snapshots, the offline font
// cache, text for Claude, and stable slide ids in the source.
//   node scripts/unit-studio.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instrument, strip, DeckStore } from '../src/main/deckstore.mjs';
import { parseBudget, planFor, pace, clock, warnAt } from '../src/renderer/timing.mjs';
import { Versions } from '../src/main/versions.mjs';
import { FontCache, rewriteFontLinks, rewriteCssFiles, fontFilesIn } from '../src/main/fontcache.mjs';
import { trimDataUris, slideForClaude, deckForClaude } from '../src/main/forclaude.mjs';
import { cleanInfo } from '../src/renderer/deckinfo.mjs';

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `hp-${name}-`));

/* ------------------------------------------------------------------ budgets */

test('time budgets are read from the start of the notes', () => {
  assert.equal(parseBudget('~1.5 min · Säg att…'), 90);
  assert.equal(parseBudget('~1,5 min — x'), 90);
  assert.equal(parseBudget('~45 s · x'), 45);
  assert.equal(parseBudget('≈ 2 min'), 120);
  assert.equal(parseBudget('ca 3 minuter: x'), 180);
  assert.equal(parseBudget('~2–3 min · range takes the middle'), 150);
  assert.equal(parseBudget('2 min · without a tilde, followed by a separator'), 120);
  assert.equal(parseBudget('2 min\nnext line'), 120);
  assert.equal(parseBudget('~3 mins · English'), 180);
  assert.equal(parseBudget('~1 min 30 s · compound'), 90);
  assert.equal(parseBudget('~1m30s · short form'), 90);
});

test('ordinary notes are not mistaken for budgets', () => {
  assert.equal(parseBudget('5 minuter in i talet säger jag…'), null);
  assert.equal(parseBudget('Visa 3 saker'), null);
  assert.equal(parseBudget(''), null);
  assert.equal(parseBudget(null), null);
  assert.equal(parseBudget('~0 min'), null);
  assert.equal(parseBudget('~90 min · longer than an hour per slide is refused'), null);
});

test('the plan fills slides without a budget and tracks pace', () => {
  const p = planFor([60, null, 120], null);
  assert.deepEqual(p.per, [60, 90, 120]);
  assert.deepEqual(p.starts, [0, 60, 150]);
  assert.equal(p.total, 270);
  const t = planFor([60, null, null], 20 * 60);
  assert.equal(t.per[1], (1200 - 60) / 2);
  assert.equal(planFor([null, null], 600), null);
  assert.deepEqual(planFor([600, 600, null, null], 600).per, [600, 600, 0, 0], 'a target already used up leaves nothing for the rest');
  assert.deepEqual(pace(p, 1, 30), { state: 'ahead', delta: 30 });
  assert.deepEqual(pace(p, 1, 100), { state: 'on', delta: 0 });
  assert.deepEqual(pace(p, 1, 200), { state: 'behind', delta: 50 });
  assert.equal(clock(75), '1:15');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(clock(-5), '−0:05');
  assert.equal(warnAt(20 * 60), 120);
  assert.equal(warnAt(5 * 60), 60);
});

/* ------------------------------------------------------------- slide ids */

const DECK = `<!doctype html><html><head><title>t</title></head><body>
<main>
  <section class="slide" data-slide-id="keep"><h1>One</h1></section>
  <section class="slide"><h2>Two</h2></section>
  <svg><rect/></svg>
  <section class="slide"
     aria-label="Three"><h2>Three</h2></section>
</main>
</body></html>`;

function storeFor(text) {
  const s = new DeckStore({ backupDir: os.tmpdir() });
  s.path = '/tmp/x.html';
  s.inst = instrument(text);
  s.savedInst = s.inst;
  return s;
}
const sectionIds = (inst) => [...inst.matchAll(/<section\b[^>]*?data-hp-id="(\d+)"/g)].map((m) => m[1]);

test('stable slide ids are added surgically and existing ones are kept', () => {
  const s = storeFor(DECK);
  const ids = sectionIds(s.inst);
  assert.equal(ids.length, 3);
  assert.equal(s.setSlideIds(ids.slice(1), ['two', 'three']), true);
  const out = strip(s.inst);
  assert.equal(out, DECK.replace('<section class="slide"><h2>Two', '<section class="slide" data-slide-id="two"><h2>Two')
    .replace('aria-label="Three">', 'aria-label="Three" data-slide-id="three">'));
  assert.ok(out.includes('data-slide-id="keep"'));
  assert.equal(s.rev, 1, 'views reload so the new ids are seen');
});

test('slide ids are validated and must be unique', () => {
  const s = storeFor(DECK);
  const ids = sectionIds(s.inst);
  assert.throws(() => s.setSlideIds([ids[1]], ['Bad Id']), /Ogiltigt/);
  assert.equal(s.setSlideIds([ids[0]], ['other']), false, 'a slide that has an id keeps it');
  assert.equal(strip(s.inst), DECK);
  // Krockar får ett nummer i stället för att stoppa hela ändringen.
  assert.equal(s.setSlideIds([ids[1], ids[2], ids[1]], ['keep', 'keep', 'keep']), true);
  const out = strip(s.inst);
  assert.ok(out.includes('data-slide-id="keep-2"') && out.includes('data-slide-id="keep-3"'), out);
  assert.equal((out.match(/data-slide-id=/g) || []).length, 3, 'a repeated slide is changed once');
});

test('the source of a slide includes the comment right before it', () => {
  const text = DECK.replace('<section class="slide"><h2>Two</h2>', '<!-- slide 2: kostnader -->\n  <section class="slide"><h2>Two</h2>');
  const s = storeFor(text);
  const ids = sectionIds(s.inst);
  assert.equal(s.slideSource(ids[1]), '<!-- slide 2: kostnader -->\n  <section class="slide"><h2>Two</h2></section>');
  assert.equal(s.slideSource(ids[0]), '<section class="slide" data-slide-id="keep"><h1>One</h1></section>');
});

test('lineOf gives the source line of an element', () => {
  const s = storeFor(DECK);
  const ids = sectionIds(s.inst);
  assert.deepEqual(ids.map((id) => s.lineOf(id)), [3, 4, 6]);
});

test('cleanInfo keeps valid slide ids only', () => {
  const info = cleanInfo({ count: 3, size: { w: 1600, h: 900 }, slideIds: ['a-1', 'bad id', '<x>'] });
  assert.deepEqual(info.slideIds, ['a-1', '', '']);
});

/* ------------------------------------------------------------- versions */

test('versions: one snapshot per distinct content, newest first, restorable', async () => {
  const dir = tmp('ver');
  const file = path.join(dir, 'deck.html');
  const v = new Versions(path.join(dir, 'store'));
  fs.writeFileSync(file, 'one');
  const a = await v.snapshot(file, 'open', 1000);
  assert.ok(a && a.reason === 'open');
  assert.equal(await v.snapshot(file, 'save', 2000), null, 'same content is not stored twice');
  fs.writeFileSync(file, 'two');
  await v.snapshot(file, 'extern', 3000);
  const list = v.list(file);
  assert.deepEqual(list.map((e) => e.reason), ['extern', 'open']);
  assert.equal(list[0].label, 'Ändrad utanför appen');
  assert.equal(String(await v.read(file, list[1].id)), 'one');
  await assert.rejects(() => v.read(file, '../../etc/passwd'), /Ogiltig/);
  await assert.rejects(() => v.read(file, 'nope'), /finns inte/);
});

test('versions: old snapshots are pruned by count and size', async () => {
  const dir = tmp('ver2');
  const file = path.join(dir, 'deck.html');
  const v = new Versions(path.join(dir, 'store'), { maxPerDeck: 3, maxBytesPerDeck: 1e9 });
  for (let i = 0; i < 5; i++) { fs.writeFileSync(file, 'v' + i); await v.snapshot(file, 'save', 1000 + i); }
  const list = v.list(file);
  assert.equal(list.length, 3);
  assert.equal(String(await v.read(file, list[0].id)), 'v4');
  const gz = fs.readdirSync(v.folderFor(file)).filter((f) => f.endsWith('.gz'));
  assert.equal(gz.length, 3, 'pruned files are deleted');
  const big = new Versions(path.join(dir, 'store2'), { maxFileBytes: 10 });
  fs.writeFileSync(file, 'x'.repeat(50));
  assert.equal((await big.snapshot(file, 'open')).skipped, 'size');
});

test('versions: snapshots taken at once do not clobber the index', async () => {
  const dir = tmp('ver3');
  const file = path.join(dir, 'deck.html');
  const v = new Versions(path.join(dir, 'store'));
  fs.writeFileSync(file, 'a');
  const p1 = v.snapshot(file, 'open', 5000);
  const p2 = v.snapshot(file, 'save', 5000);
  await Promise.all([p1, p2]);
  fs.writeFileSync(file, 'b');
  await v.snapshot(file, 'save', 5000);
  const ids = v.list(file).map((e) => e.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'same timestamp still gets unique ids');
});

/* -------------------------------------------------------------- fonts */

const GF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap';

test('Google Fonts links are rewritten in the served HTML only where they are real links', () => {
  const html = `<head><link rel="preconnect" href="https://fonts.gstatic.com"><link href="${GF.replace(/&/g, '&amp;')}" rel="stylesheet">
<style>@import url('https://fonts.googleapis.com/css2?family=Lora');</style></head>
<body><pre>&lt;link href="https://fonts.googleapis.com/css2?family=X"&gt;</pre></body>`;
  const { html: out, urls } = rewriteFontLinks(html, 'hpres://deck');
  assert.deepEqual(urls, [GF, 'https://fonts.googleapis.com/css2?family=Lora']);
  assert.ok(out.includes(`href="hpres://deck/__fonts/css?u=${encodeURIComponent(GF)}"`));
  assert.ok(out.includes(`@import url("hpres://deck/__fonts/css?u=${encodeURIComponent('https://fonts.googleapis.com/css2?family=Lora')}")`));
  assert.ok(out.includes('href="https://fonts.gstatic.com"'), 'preconnect is left alone');
  assert.ok(out.includes('&lt;link href="https://fonts.googleapis.com/css2?family=X"&gt;'), 'text that shows a link is not touched');
});

test('the font scanner skips comments, scripts and non-stylesheet links, and decodes entities', () => {
  const lora = 'https://fonts.googleapis.com/css2?family=Lora&display=swap';
  const html = `<!-- <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=A"> -->
<script>const s = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=B">';</script>
<textarea><style>@import url(https://fonts.googleapis.com/css2?family=C);</style></textarea>
<link rel="icon" href="https://fonts.googleapis.com/css2?family=D">
<link rel=preload as=style href="https://fonts.googleapis.com/css2?family=Lora&#38;display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=E#frag">`;
  const { html: out, urls } = rewriteFontLinks(html, 'hpres://deck');
  assert.deepEqual(urls, [lora]);
  for (const f of ['A', 'B', 'C', 'D']) assert.ok(out.includes(`family=${f}`), `${f} is left as it was`);
  assert.ok(out.includes(encodeURIComponent(lora)));
  assert.ok(out.includes('family=E#frag'), 'a url with # is left alone');
});

test('the font scanner is linear and stops after 20 stylesheets', () => {
  const many = Array.from({ length: 30 }, (_, i) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=F${i}">`).join('');
  assert.equal(rewriteFontLinks(many, 'hpres://deck').urls.length, 20);
  const evil = '<style'.repeat(20000) + '<link'.repeat(20000) + '<!--x'.repeat(5000);
  const t = Date.now();
  rewriteFontLinks(evil, 'hpres://deck');
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
});

const CSS = `/* cyrillic */
@font-face { font-family: 'Inter'; src: url(https://fonts.gstatic.com/s/inter/cyr.woff2) format('woff2'); }
/* latin-ext */
@font-face { font-family: 'Inter'; src: url(https://fonts.gstatic.com/s/inter/ext.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Inter'; src: url(https://fonts.gstatic.com/s/inter/latin.woff2) format('woff2'); }`;

test('font files in a Google Fonts stylesheet are found and routed through the app', () => {
  assert.equal(fontFilesIn(CSS).length, 3);
  assert.deepEqual(fontFilesIn(CSS, true), ['https://fonts.gstatic.com/s/inter/ext.woff2', 'https://fonts.gstatic.com/s/inter/latin.woff2']);
  const out = rewriteCssFiles(CSS, 'hpres://deck');
  assert.ok(!out.includes('url(https://fonts.gstatic.com'));
  assert.ok(out.includes(`url("hpres://deck/__fonts/file?u=${encodeURIComponent('https://fonts.gstatic.com/s/inter/latin.woff2')}")`));
});

test('the font cache serves saved fonts without network, and refuses other hosts', async () => {
  const calls = [];
  let online = true;
  const fetchFn = async (url) => {
    calls.push(url);
    if (!online) throw new Error('offline');
    const css = url.startsWith('https://fonts.googleapis.com/');
    return { ok: true, status: 200, headers: new Map([['content-type', css ? 'text/css; charset=utf-8' : 'font/woff2']]), arrayBuffer: async () => Buffer.from(css ? CSS : 'wOF2' + url) };
  };
  let changed = 0;
  const fc = new FontCache(tmp('fonts'), fetchFn, { onChange: () => changed++ });
  const got = await fc.css(GF);
  assert.ok(String(got.body).includes('@font-face'));
  await new Promise((r) => setTimeout(r, 30)); // latin files are prefetched in the background
  assert.ok(fc.has('https://fonts.gstatic.com/s/inter/latin.woff2') && fc.has('https://fonts.gstatic.com/s/inter/ext.woff2'));
  assert.ok(!fc.has('https://fonts.gstatic.com/s/inter/cyr.woff2'), 'other scripts are fetched only when used');
  assert.deepEqual(fc.status([GF]), { count: 1, ready: 1 });
  assert.ok(changed >= 1);
  online = false;
  fc.offline = true;
  const n = calls.length;
  assert.ok(String((await fc.css(GF)).body).includes('@font-face'));
  assert.equal(String((await fc.file('https://fonts.gstatic.com/s/inter/latin.woff2')).body), 'wOF2https://fonts.gstatic.com/s/inter/latin.woff2');
  assert.equal(calls.length, n, 'no network while testing offline');
  await assert.rejects(() => fc.file('https://fonts.gstatic.com/s/inter/cyr.woff2'), /offline/);
  await assert.rejects(() => fc.css('https://evil.example/css'), /Google Fonts/);
  await assert.rejects(() => fc.file('https://fonts.googleapis.com.evil.example/x'), /Google Fonts/);
});

test('the font cache does not save a login page as a font', async () => {
  const page = { ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), arrayBuffer: async () => Buffer.from('<html>Logga in på wifi</html>') };
  const fc = new FontCache(tmp('fonts-bad'), async () => page);
  await assert.rejects(() => fc.css(GF), /typsnitt/);
  await assert.rejects(() => fc.file('https://fonts.gstatic.com/s/inter/latin.woff2'), /typsnitt/);
  assert.ok(!fc.has(GF) && !fc.has('https://fonts.gstatic.com/s/inter/latin.woff2'));
});

/* -------------------------------------------------------------- Claude */

test('text for Claude drops embedded base64 but keeps short data and the rest', () => {
  const b64 = 'A'.repeat(4000);
  const html = `<img src="data:image/png;base64,${b64}"><img src="data:image/gif;base64,R0lGOD">`;
  const out = trimDataUris(html);
  assert.ok(out.includes('data:image/png;base64,…[3 kB borttaget]'));
  assert.ok(out.includes('data:image/gif;base64,R0lGOD'));
  const text = slideForClaude({ index: 1, count: 5, title: 'Kostnader', slideId: 'kostnader', file: '/d/deck.html', line: 40, dirty: false, size: { w: 1600, h: 900 }, notes: '~1 min · säg', html: `<section>${html}</section>`, budget: '~1:00 min' });
  assert.ok(text.startsWith('Slide 2 av 5 · ”Kostnader” · id: kostnader\nFil: /d/deck.html (rad 40)'));
  assert.ok(text.includes('```html\n<section>'));
  assert.ok(!text.includes(b64));
  const unquoted = trimDataUris(`<img src=data:image/png;base64,${b64} alt=Logo width=40>`);
  assert.ok(unquoted.endsWith(' alt=Logo width=40>'), 'attributes after an unquoted data url stay');
});

test('the whole deck becomes a short outline, with an optional request first', () => {
  const md = deckForClaude({ file: '/d/deck.html', name: 'deck.html', size: { w: 1600, h: 900 }, recipe: 'cut', targetMin: 15, totalMin: 24,
    slides: [{ title: 'Intro', text: 'Hej', notes: 'n1\nn2', slideId: 'intro', budget: '~1:00 min' }, { title: '', text: '', notes: '' }] });
  assert.ok(md.startsWith('Här är mitt deck. Föreslå hur det kan kortas till 15 minuter'));
  assert.ok(md.includes('## 1. Intro  (id: intro, budget ~1:00 min)'));
  assert.ok(md.includes('> Anteckningar: n1\n> n2'));
  assert.ok(md.includes('## 2. Slide 2'));
  assert.ok(md.includes('planerad tid ≈ 24 min'));
});

/* ------------------------------------------------------------------ run */

for (const [name, fn] of tests) {
  try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '\n ', e.message); }
}
if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nall passed');
