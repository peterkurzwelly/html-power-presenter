// End-to-end test: drives the real app with Playwright on a COPY of a deck and exits
// non-zero if anything is wrong. Covers views, thumbnails, editing and saving,
// deleting and undo, reordering, importing slides from another deck (copy and
// move), the deck's file sandbox, and presenting with an audience window.
//
//   node scripts/smoke-test.mjs <deck.html> [out-dir]
//   HP_EXEC=<path to built app binary> node scripts/smoke-test.mjs …   (test the packaged app)

import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'hp-smoke'));
if (!src) { console.error('Usage: node scripts/smoke-test.mjs <deck.html> [out-dir]'); process.exit(2); }
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/* ------------------------------------------------------------------ fixtures */

// The deck under test, in its own folder, plus files to probe the sandbox with.
const deckDir = path.join(out, 'deck');
fs.mkdirSync(deckDir, { recursive: true });
const deck = path.join(deckDir, path.basename(src));
fs.copyFileSync(src, deck);
// A Google Fonts link, to test that fonts are served through the app's offline cache.
const GF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap';
{
  const t = fs.readFileSync(deck, 'utf8');
  const i = t.search(/<\/head>/i);
  if (i > 0) fs.writeFileSync(deck, t.slice(0, i) + `<link href="${GF.replace(/&/g, '&amp;')}" rel="stylesheet">\n` + t.slice(i));
}
fs.writeFileSync(path.join(out, 'outside.txt'), 'secret');
fs.writeFileSync(path.join(deckDir, 'inside.txt'), 'ok');
fs.writeFileSync(path.join(deckDir, 'inner.html'), '<!doctype html><body>inner ok</body>');
fs.symlinkSync(out, path.join(deckDir, 'escape-link'));
const original = fs.readFileSync(deck, 'utf8');

// A second deck in another folder, with a different design and an image file, to import from.
const otherDir = path.join(out, 'other');
fs.mkdirSync(path.join(otherDir, 'img'), { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(otherDir, 'img', 'dot.png'), PNG);
const other = path.join(otherDir, 'other-deck.html');
fs.writeFileSync(other, `<!doctype html><html><head><meta charset="utf-8"><title>Other</title><style>
:root { --brand: rgb(200, 30, 90); }
body { margin: 0; font-family: Georgia, serif; color: rgb(20, 20, 20); }
.page { position: absolute; inset: 0; width: 1280px; height: 720px; display: none; background: rgb(250, 240, 220); padding: 60px; box-sizing: border-box; }
.page.current { display: block; }
.page h1 { color: var(--brand); font-size: 80px; margin: 0; }
.badge { display: inline-block; border: 4px solid var(--brand); padding: 10px 20px; font-size: 30px; }
</style></head><body><div class="deck">
<div class="page" data-title="Other one"><h1>Imported title</h1><span class="badge">badge</span><img src="img/dot.png" width="40" height="40"></div>
<div class="page" data-title="Other two"><h1>Second other</h1></div>
<div class="page" data-title="Other three"><h1>Third other</h1></div>
</div>
<script type="application/json" id="speaker-notes">["note one", "note two", "note three"]</script>
</body></html>`);
const otherOriginal = fs.readFileSync(other, 'utf8');

/* --------------------------------------------------------------------- helpers */

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) { failures++; process.exitCode = 1; }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (target, name) => { await target.screenshot({ path: path.join(out, name + '.png') }); };

const app = await electron.launch({
  ...(process.env.HP_EXEC ? { executablePath: process.env.HP_EXEC, args: [deck] } : { args: [root, deck] }),
  env: { ...process.env, HP_FAKE_DUAL: '1', HP_USER_DATA: path.join(out, 'userdata') },
});
app.process().stderr.on('data', (d) => { const s = String(d); if (/Error|error:/.test(s) && !/Security Warning|DevTools|Debugger/.test(s)) process.stderr.write('[main] ' + s); });

const page = await app.firstWindow();
page.on('pageerror', (e) => { check(false, 'no page errors in the main window', e.message); });
if (process.env.HP_VERBOSE) page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text(), m.location().url || ''); });
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});

const mainFrame = () => page.frames().find((f) => f.url().includes('hp=main'));
const sidebarTitles = () => page.$$eval('#thumbList .thumb .ph', (els) => els.map((e) => e.textContent));
const slideCount = () => page.$$eval('#thumbList li', (l) => l.length);
const status = () => page.textContent('#statusLeft');
const menu = (action) => app.evaluate(({ BrowserWindow }, a) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/ui/index.html'));
  w.webContents.send('menu', a);
}, action);
const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());
// Clicks a menu item by its label (checkboxes flip like a real click).
const clickMenuItem = (label) => app.evaluate(({ Menu, BrowserWindow }, l) => {
  const find = (items) => { for (const it of items) { if (it.label === l) return it; if (it.submenu) { const f = find(it.submenu.items); if (f) return f; } } return null; };
  const it = find(Menu.getApplicationMenu().items);
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/ui/index.html'));
  it.click({}, w, w.webContents);
}, label);
const winInfo = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).map((w) => ({
  url: w.webContents.getURL(), title: w.getTitle(), bounds: w.getBounds(), content: w.getContentBounds(), full: w.isSimpleFullScreen(),
})));
const audienceInfo = async () => (await winInfo()).find((w) => w.url.includes('/ui/audience.html'));
const presenterInfo = async () => (await winInfo()).find((w) => w.url.includes('/ui/index.html'));
const displayCount = () => app.evaluate(({ screen }) => screen.getAllDisplays().length);
const audienceFrame = async (aud) => {
  let f = null;
  for (let i = 0; i < 100 && !f; i++) { f = aud.frames().find((x) => x.url().includes('hp=audience')); if (!f) await wait(100); }
  return f && f.waitForFunction(() => window.__hp && window.__hp.ready, null, { timeout: 20000 }).then(() => f, () => null);
};
const frameRev = (mode) => { const f = page.frames().find((x) => x.url().includes(`hp=${mode}`)); const m = f && /rev=(\d+)/.exec(f.url()); return m ? +m[1] : null; };
const waitReload = async (count) => {
  await page.waitForFunction((n) => document.querySelectorAll('#thumbList li').length === n && !document.querySelector('#stage.sv-loading'), count, { timeout: 20000 });
  await wait(500);
};
const clickInSlide = async (x, y, mods = []) => {
  const fr = await page.$eval('#stage iframe', (f) => { const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, s: r.width / f.offsetWidth }; });
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(fr.left + x * fr.s, fr.top + y * fr.s);
  for (const m of mods) await page.keyboard.up(m);
};

/* ------------------------------------------------------------------ open & view */

await page.waitForFunction(() => document.querySelectorAll('#thumbList li').length > 0, null, { timeout: 30000 });
const n0 = await slideCount();
check(n0 >= 2, 'deck opens with slides', `${n0} slides, ${await page.textContent('#statusMid')}`);

const t0 = Date.now();
const thumbsOk = await page.waitForFunction((n) => document.querySelectorAll('#thumbList .thumb img').length >= n, n0, { timeout: 90000 }).then(() => true, () => false);
check(thumbsOk, 'thumbnails render for every slide', `${Date.now() - t0} ms`);

await page.keyboard.press('ArrowRight');
await wait(500);
check((await status()) === `Slide 2 av ${n0}`, 'arrow key moves to the next slide', await status());
await shot(page, '1-normal');

await page.click('.seg button[data-view="grid"]');
await wait(300);
check(await page.isVisible('#gridView'), 'grid view opens');
await shot(page, '2-grid');
await page.click('.seg button[data-view="normal"]');

/* ------------------------------------------------------------------- sandbox */

const probe = await mainFrame().evaluate(async () => {
  const get = (u) => fetch(u).then((r) => r.status).catch(() => 'error');
  let parentApi;
  try { parentApi = typeof window.parent.hp; } catch (_) { parentApi = 'blocked'; }
  let parentDom;
  try { parentDom = !!window.parent.document; } catch (_) { parentDom = 'blocked'; }
  return {
    inside: await get('inside.txt'),
    outside: await get('../outside.txt'),
    system: await get('/fs/etc/hosts'),
    symlink: await get('escape-link/outside.txt'),
    parentApi, parentDom,
  };
});
check(probe.inside === 200, 'deck can read files in its own folder', String(probe.inside));
check(probe.outside === 403 && probe.system === 403, 'deck cannot read files outside its folder', `${probe.outside}, ${probe.system}`);
check(probe.symlink === 403 || probe.symlink === 404, 'a symlink in the deck folder does not lead outside it', String(probe.symlink));
check(probe.parentApi === 'blocked' && probe.parentDom === 'blocked', 'deck cannot reach the app window or its API', `${probe.parentApi}, ${probe.parentDom}`);

/* -------------------------------------------- what a deck's own script can't do */

// A deck script can post the same messages the app's controller posts. Outside edit
// mode (and without the user starting an edit) the app must ignore them.
const anyId = await mainFrame().evaluate(() => {
  const el = window.__hp.slides[window.__hp.index].querySelector('h1, h2, p');
  const id = el.getAttribute('data-hp-id');
  parent.postMessage({ hp: 1, type: 'event', name: 'editBegin', data: { id, html: el.innerHTML } }, 'hpres://app');
  parent.postMessage({ hp: 1, type: 'event', name: 'edit', data: { id, html: 'HACKED<script src="x.js"></script>', orig: el.innerHTML } }, 'hpres://app');
  parent.postMessage({ hp: 1, type: 'event', name: 'requestDelete', data: null }, 'hpres://app');
  return id;
});
await wait(800);
const afterForge = await page.evaluate(() => window.hp.state());
check(anyId && !afterForge.dirty && !afterForge.canUndo, 'messages forged by the deck change nothing', JSON.stringify({ dirty: afterForge.dirty }));

// The deck's own iframes (embeds, local demos) load inside it; only the app's frames are guarded.
await mainFrame().evaluate(() => { const f = document.createElement('iframe'); f.src = 'inner.html'; f.id = 'hp-test-inner'; document.body.appendChild(f); });
let innerText = null;
for (let i = 0; i < 30 && innerText === null; i++) {
  const f = page.frames().find((x) => x.url().endsWith('/inner.html'));
  if (f) innerText = await f.textContent('body').catch(() => null);
  if (innerText === null) await wait(100);
}
check(innerText === 'inner ok', "an iframe inside the deck loads its page", String(innerText));
await mainFrame().evaluate(() => document.getElementById('hp-test-inner').remove());

/* ------------------------------------------------------------- edit & save */

await page.click('#editBtn');
await wait(300);
const target = await mainFrame().evaluate(() => {
  const s = window.__hp.slides[window.__hp.index];
  const el = [...s.querySelectorAll('h1, h2, h3, p')].find((e) => e.textContent.trim().length > 3 && e.getBoundingClientRect().width > 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(r.width - 4, 30), y: r.top + r.height / 2, id: el.getAttribute('data-hp-id') };
});
check(!!target, 'found a text to edit on slide 2');
if (target) {
  await clickInSlide(target.x, target.y);
  await wait(200);
  check(await mainFrame().evaluate(() => window.__hp.editing), 'clicking a text starts editing');
  await page.keyboard.press('End');
  await page.keyboard.type(' [EDITED]');
  await page.keyboard.press('Escape');
  await wait(400);
  await page.click('#saveBtn');
  await wait(600);
  const saved = fs.readFileSync(deck, 'utf8');
  let a = 0; while (a < original.length && original[a] === saved[a]) a++;
  let b = 0; while (b < original.length - a && original[original.length - 1 - b] === saved[saved.length - 1 - b]) b++;
  const changed = saved.slice(a, saved.length - b);
  check(saved.includes('[EDITED]') && !/data-hp-id/.test(saved), 'saved file has the edit and no internal markers');
  check(changed === ' [EDITED]', 'nothing else in the file changed', JSON.stringify(changed).slice(0, 80));

  await clickInSlide(target.x, target.y, ['Alt']);
  await wait(200);
  await page.keyboard.press('Backspace');
  await wait(400);
  check(await mainFrame().evaluate((id) => !document.querySelector(`[data-hp-id="${id}"]`), target.id), '⌥-click + ⌫ deletes the element');
  await page.click('#undoBtn');
  await wait(1500);
  check(await mainFrame().evaluate((id) => !!document.querySelector(`[data-hp-id="${id}"]`), target.id), 'undo brings it back');
}
await page.click('#editBtn');

/* --------------------------------------------------------------- reorder */

await page.click('#thumbList li:nth-child(1)');
await wait(300);
const before = await sidebarTitles();
// Drag slide 1 below slide 3 in the sidebar.
await page.dragAndDrop('#thumbList li:nth-child(1)', '#thumbList li:nth-child(3)', { targetPosition: { x: 60, y: 80 } });
await waitReload(n0);
const afterDrag = await sidebarTitles();
check(afterDrag[2] === before[0] && afterDrag[0] === before[1], 'dragging a slide in the sidebar reorders it', afterDrag.slice(0, 3).join(' | '));
check((await status()) === `Slide 3 av ${n0}`, 'the moved slide stays selected', await status());

await menu('slide-up');
await waitReload(n0);
check((await sidebarTitles())[1] === before[0], '⌥⌘↑ (Slides menu) moves the slide up');

await menu('slide-duplicate');
await waitReload(n0 + 1);
const dup = await sidebarTitles();
check(dup.length === n0 + 1 && dup[1] === dup[2], 'duplicate adds a copy right after');
await menu('slide-delete');
await waitReload(n0);
check((await slideCount()) === n0, 'delete slide removes it');

for (const n of [n0 + 1, n0, n0, n0]) { await page.click('#undoBtn'); await waitReload(n); }
check(JSON.stringify(await sidebarTitles()) === JSON.stringify(before), 'undo walks back through every reorder', (await sidebarTitles()).slice(0, 3).join(' | '));
check(fs.readFileSync(deck, 'utf8').length === original.length + ' [EDITED]'.length, 'the file on disk only has the text edit');

/* ------------------------------------------------- import from another deck */

await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, other);
await page.click('#thumbList li:nth-child(1)');
await wait(300);
await page.click('#importBtn');
await page.waitForSelector('#importDlg:not([hidden])');
await page.waitForFunction(() => document.querySelectorAll('#impGrid li[data-i]').length === 3, null, { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('#impGrid .thumb img').length === 3, null, { timeout: 30000 }).catch(() => {});
check(await page.isChecked('#impStyles'), 'a deck with a different design suggests keeping the original look');
await page.click('#impGrid li[data-i="0"]');
await shot(page, '3-import-dialog');
await page.click('#impGo');
await waitReload(n0 + 1);
const imported = await sidebarTitles();
check(imported[1] === 'Other one', 'imported slide lands after the current slide and is recognized as a slide', imported.slice(0, 3).join(' | '));
check(fs.existsSync(path.join(deckDir, 'img', 'dot.png')), 'the image it uses is copied into the deck folder');
await wait(800);
const look = await mainFrame().evaluate(() => {
  const s = window.__hp.slides[window.__hp.index];
  const h1 = s.querySelector('h1');
  const img = s.querySelector('img');
  // Wrappern är @scope-roten; originalslidens element ligger direkt i den.
  const wrap = s.querySelector('[class*="hp-imp-"]');
  const inner = wrap && wrap.firstElementChild;
  const r = inner && inner.getBoundingClientRect();
  return { color: h1 && getComputedStyle(h1).color, bg: inner && getComputedStyle(inner).backgroundColor, size: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null, img: img && img.complete ? img.naturalWidth : null };
});
check(look.color === 'rgb(200, 30, 90)' && look.bg === 'rgb(250, 240, 220)' && look.size && !look.size.startsWith('0'), 'it keeps the original look (scoped CSS and CSS variables)', JSON.stringify(look));
check(look.img === 1, 'its image loads from the copied file');
const notesText = await page.textContent('#notesText');
check(notesText.includes('note one'), 'its speaker note comes along', notesText.slice(0, 40));
await shot(page, '4-imported');

// Move: slide 3 of the other deck, adopting this deck's look. Saves at once and removes it from the other file.
await page.click('#importBtn');
await page.waitForFunction(() => document.querySelectorAll('#impGrid li[data-i]').length === 3, null, { timeout: 30000 });
await page.click('#impGrid li[data-i="2"]');
await page.check('#impMove');
await page.uncheck('#impStyles');
page.once('dialog', (d) => d.accept());
await page.click('#impGo');
await waitReload(n0 + 2);
const otherNow = fs.readFileSync(other, 'utf8');
check(!otherNow.includes('Third other') && otherNow.includes('Second other'), 'move removes the slide from the other file');
check(JSON.parse(/speaker-notes">([\s\S]*?)<\/script>/.exec(otherNow)[1]).length === 2, "…and its note from that file's note list");
const deckNow = fs.readFileSync(deck, 'utf8');
check(deckNow.includes('Third other') && deckNow.includes('Imported title'), 'move saves both imported slides into this deck');
check(!/data-hp-id/.test(deckNow), 'no internal markers in the saved deck');
const backups = fs.readdirSync(path.join(out, 'userdata', 'Säkerhetskopior'));
check(backups.some((f) => f.startsWith('other-deck.')), 'a backup of the other file is kept', backups.join(', '));
check(await page.isDisabled('#undoBtn'), "a move can't be half-undone with ⌘Z (undo is off)");
fs.writeFileSync(other, otherOriginal);

// Moving every slide out of the other deck would leave it empty: refused before anything changes.
const deckBeforeAll = fs.readFileSync(deck, 'utf8');
await page.click('#importBtn');
await page.waitForFunction(() => document.querySelectorAll('#impGrid li[data-i]').length === 3, null, { timeout: 30000 });
await page.click('#impAll');
await page.check('#impMove');
page.once('dialog', (d) => d.accept());
await page.click('#impGo');
await page.waitForFunction(() => { const t = document.getElementById('toast'); return t && !t.hidden && t.classList.contains('error'); }, null, { timeout: 10000 }).catch(() => {});
const allToast = await page.textContent('#toast');
check(/minst en slide/.test(allToast) && fs.readFileSync(deck, 'utf8') === deckBeforeAll && fs.readFileSync(other, 'utf8') === otherOriginal && (await slideCount()) === n0 + 2,
  'moving every slide out of a deck is refused and changes nothing', allToast.slice(0, 60));
await page.keyboard.press('Escape');
await wait(300);
check(await page.isHidden('#importDlg'), 'Esc closes the import dialog');

/* --------------------------------------------------------------- presenting */

check(await page.isHidden('#dirtyMark'), 'the deck is saved before presenting');
check(await page.$eval('#windowedBtn', (b) => b.classList.contains('on')), 'window mode is on (the default in this test)');
const audienceP = app.waitForEvent('window', { timeout: 15000 });
await page.click('#thumbList li:nth-child(2)');
await wait(300);
await page.click('#presentBtn');
let audience = await audienceP;
await audience.waitForLoadState();
audience.on('pageerror', (e) => check(false, 'no page errors in the audience window', e.message));
await page.waitForSelector('#presenter:not([hidden])');
let af = await audienceFrame(audience);
check(!!af, 'audience window loads the deck');
await wait(1000);

// Window mode: the presenter view and the audience are ordinary windows. On one screen
// they sit side by side; the audience window keeps the slide's proportions.
const ratio = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ratio')));
const aw = await audienceInfo();
const pw = await presenterInfo();
check(aw && pw && !aw.full && !pw.full, 'window mode: neither window is full screen');
check(aw && Math.abs(aw.content.width / aw.content.height - ratio) < 0.02, "window mode: the audience window has the slide's proportions", aw && `${aw.content.width}×${aw.content.height}, slide ${ratio.toFixed(3)}`);
check(aw && aw.title === `Publik – ${path.basename(deck)}`, 'the audience window is named after the deck, to pick it when sharing', aw && aw.title);
if ((await displayCount()) === 1) {
  check(aw && pw && aw.bounds.x >= pw.bounds.x + pw.bounds.width - 2, 'window mode on one screen: the audience sits beside the presenter view', aw && pw && `presenter ${JSON.stringify(pw.bounds)}, audience ${JSON.stringify(aw.bounds)}`);
}

// Only the current slide runs live in the presenter view; the next one is a picture.
const live = page.frames().map((f) => f.url()).filter((u) => /hp=(main|next|current)/.test(u)).map((u) => /hp=(\w+)/.exec(u)[1]);
check(live.join(',') === 'current', 'during the show only the current slide runs live in the presenter view', live.join(', '));
check(await page.isVisible('#pNextImg'), 'the next slide shows as a picture');

await page.keyboard.press('ArrowRight');
await wait(1000);
await shot(page, '5-presenter');
await shot(audience, '6-audience');
const audIdx = af ? await af.evaluate(() => window.__hp.index) : null;
check(audIdx === 2, 'audience follows the presenter', `audience index ${audIdx}, presenter "${await page.textContent('#pCount')}"`);

// Talk length, countdown and pace from the time budgets in the notes.
await page.click('#pTargetBtn');
await page.fill('#pTargetMin', '20');
await page.press('#pTargetMin', 'Enter');
await wait(700);
const tt = await page.textContent('#pTimer');
const sub = await page.textContent('#pTimerSub');
check(/^(19:5\d|20:00)$/.test(tt) && /kvar av 20 min/.test(sub), 'a talk length makes the timer count down', `${tt} · ${sub}`);
const paceText = await page.$eval('#pPace', (e) => (e.hidden ? '' : e.textContent));
check(/Sliden \d+:\d\d \/ ≈?\d+:\d\d/.test(paceText) && /(i fas|före|efter)/.test(paceText), 'time budgets in the notes show the pace on each slide', paceText);
await page.keyboard.press('s');
await wait(600);
check(/pausad/.test(await page.textContent('#pTimerSub')), 'S pauses the timer');
await page.keyboard.press('s');

// Show lock: a file rewritten mid-talk is not loaded until the show ends.
const revBefore = frameRev('current');
fs.appendFileSync(deck, '\n<!-- changed by another tool -->\n');
await page.waitForSelector('#pFileChip:not([hidden])', { timeout: 8000 }).catch(() => {});
await wait(800);
check(await page.isVisible('#pFileChip') && frameRev('current') === revBefore, 'a file changed during the show waits until the show is over', `rev ${revBefore} → ${frameRev('current')}`);

// F switches between window mode and full screen mid-show; the audience keeps its slide.
let nextAud = app.waitForEvent('window', { timeout: 15000 });
await page.keyboard.press('f');
audience = await nextAud;
await audience.waitForLoadState();
af = await audienceFrame(audience);
await wait(1000);
let a2 = await audienceInfo();
check(a2 && a2.full && af && (await af.evaluate(() => window.__hp.index)) === 2, 'F switches the audience to full screen, on the same slide', a2 && `full ${a2.full}`);
nextAud = app.waitForEvent('window', { timeout: 15000 });
await page.keyboard.press('f');
audience = await nextAud;
await audience.waitForLoadState();
af = await audienceFrame(audience);
await wait(800);
a2 = await audienceInfo();
check(a2 && !a2.full && !!af, 'F again goes back to window mode');

await page.keyboard.press('Escape');
await wait(1000);
check(await page.isVisible('#workspace'), 'Esc ends the presentation');
const reloaded = await page.waitForFunction((r) => {
  const f = [...document.querySelectorAll('iframe')].map((x) => x.src).find((u) => u.includes('hp=main'));
  const m = f && /rev=(\d+)/.exec(f);
  return m && +m[1] > r;
}, revBefore, { timeout: 10000 }).then(() => true, () => false);
check(reloaded && fs.readFileSync(deck, 'utf8').includes('changed by another tool'), 'the changed file is loaded when the show ends');
await page.waitForFunction(() => !document.querySelector('#stage.sv-loading'), null, { timeout: 20000 });
await wait(800);
const right = await page.textContent('#statusRight');
check(/(≈ \d+ min enligt anteckningarna|\d+ (min|s) i anteckningarna för \d+ av \d+ slides)/.test(right) && /mål 20 min/.test(right), 'the status bar shows the planned time and the talk length', right);

// A double click on ▶ Presentera starts one show, with the right window-mode state.
let audP = app.waitForEvent('window', { timeout: 15000 });
await page.dblclick('#presentBtn');
audience = await audP;
await audience.waitForLoadState();
af = await audienceFrame(audience);
await page.waitForSelector('#presenter:not([hidden])');
await wait(1200);
check(await page.$eval('#pWindowed', (b) => b.classList.contains('on')), 'a double click starts one show and window mode stays lit');

// A script in the deck can post fake key presses. In the audience window they can turn
// pages but not switch window mode or stop the timer.
let extraWindow = false;
const onWin = () => { extraWindow = true; };
app.on('window', onWin);
const fakeKey = (key) => af.evaluate((k) => parent.postMessage({ hp: 1, type: 'event', name: 'key', data: { key: k } }, '*'), key);
await fakeKey('f');
await fakeKey('s');
await wait(1500);
const a3 = await audienceInfo();
check(!extraWindow && a3 && !a3.full && !/pausad/.test(await page.textContent('#pTimerSub')), 'keys sent by the deck in the audience window cannot switch window mode or pause the timer');
const slideNo = async () => +(/Slide (\d+)/.exec(await page.textContent('#pCount')) || [0, 0])[1];
const slideBefore = await slideNo();
await fakeKey('ArrowRight');
await wait(800);
check((await slideNo()) === slideBefore + 1, '…but they can still turn pages (clickers and the deck itself)', `${slideBefore} → ${await slideNo()}`);
app.off('window', onWin);
await page.keyboard.press('Escape');
await wait(1500);

// Ending the show while it is still loading leaves the editor working.
audP = app.waitForEvent('window', { timeout: 15000 });
await page.click('#presentBtn');
await page.waitForSelector('#presenter:not([hidden])');
await page.keyboard.press('Escape');
await audP.catch(() => null);
await wait(2500);
const editorOk = await page.isVisible('#workspace') && !!mainFrame() && await mainFrame().evaluate(() => !!(window.__hp && window.__hp.slides.length)).catch(() => false);
check(editorOk, 'ending a show right after starting it leaves the editor with the deck loaded');

/* ------------------------------------------------- two slide commands in a row */

// A second ⌘D before the views have reloaded must not act on the old slide list.
const nBefore = await slideCount();
await menu('slide-duplicate');
await menu('slide-duplicate');
await wait(2500);
const nAfter = await slideCount();
const idsUnique = await mainFrame().evaluate(() => { const ids = [...document.querySelectorAll('[data-hp-id]')].map((e) => e.getAttribute('data-hp-id')); return ids.length === new Set(ids).size; });
check((nAfter === nBefore + 1 || nAfter === nBefore + 2) && idsUnique, 'a quick second ⌘D never corrupts the deck', `${nBefore} → ${nAfter}, unique ids: ${idsUnique}`);
await menu('slide-up');
await wait(2000);
const t = await page.$eval('#toast', (el) => (el.hidden ? '' : el.className + ' ' + el.textContent));
check(!/error/.test(t), 'slides can still be moved afterwards', t.slice(0, 80));
await menu('save');
await wait(1000);

/* ----------------------------------------- stable slide ids, text for Claude */

const beforeIds = fs.readFileSync(deck, 'utf8');
await menu('slide-ids');
await page.waitForFunction(() => !document.querySelector('#stage.sv-loading'), null, { timeout: 20000 });
await wait(1500);
const sids = await mainFrame().evaluate(() => [...document.querySelectorAll('[data-hp-slide]')].map((x) => x.getAttribute('data-slide-id')));
check(sids.length > 1 && sids.every(Boolean) && new Set(sids).size === sids.length, 'Ge slides fasta id gives every slide a unique id', sids.slice(0, 4).join(', '));
await menu('save');
await wait(1000);
const withIds = fs.readFileSync(deck, 'utf8');
check(withIds !== beforeIds && withIds.replace(/ data-slide-id="[^"]*"/g, '') === beforeIds, 'the ids are the only change in the saved file');

await page.click('#thumbList li:nth-child(3)');
await wait(400);
await menu('copy-slide');
await wait(600);
const clip = await clipboardText();
check(/^Slide 3 av \d+ · ”.+” · id: [a-z0-9-]+\n/.test(clip) && clip.includes(deck) && clip.includes('```html') && !/data-hp-id/.test(clip),
  'Kopiera slide för Claude copies the slide source, notes and file path', clip.split('\n')[0]);
await menu('copy-deck:qa');
await wait(1000);
const clip2 = await clipboardText();
check(clip2.startsWith('Här är mitt deck.') && /\n## 1\. /.test(clip2) && /budget ~/.test(clip2) && !/data-hp-id|base64,[A-Za-z0-9+/]{200}/.test(clip2), 'Kopiera decket för Claude gives a text outline with the request first', `${clip2.length} chars`);

/* ------------------------------------------------------------ versions */

await menu('versions');
await page.waitForSelector('#versionsDlg:not([hidden])');
const rows = await page.$$eval('#verList li', (l) => l.map((x) => x.textContent));
check(rows.length >= 3 && rows.some((r) => /Öppnad/.test(r)) && rows.some((r) => /Sparad/.test(r)) && rows.some((r) => /Ändrad utanför appen/.test(r)),
  'every version the app saw is kept (opened, saved, changed outside the app)', `${rows.length} versions`);
await shot(page, '7-versions');
page.once('dialog', (d) => d.accept());
const oldest = (await page.$$('#verList li')).pop();
await (await oldest.$('button.primary')).click();
await page.waitForSelector('#versionsDlg', { state: 'hidden', timeout: 10000 }).catch(() => {});
await wait(1500);
check(fs.readFileSync(deck, 'utf8') === original, 'restoring the oldest version gives back the file as it was opened');
await page.waitForFunction(() => !document.querySelector('#stage.sv-loading'), null, { timeout: 20000 });
await wait(800);

/* -------------------------------------------------------- fonts without network */

const fontHref = await mainFrame().evaluate(() => { const l = document.querySelector('link[rel="stylesheet"][href*="/__fonts/css"]'); return l ? l.href : null; });
check(!!fontHref && fontHref.startsWith('hpres://deck/__fonts/css?u=') && fs.readFileSync(deck, 'utf8').includes('href="https://fonts.googleapis.com/'),
  'Google Fonts load through the app; the file itself is unchanged', String(fontHref).slice(0, 50));
const fontOnline = fontHref ? await mainFrame().evaluate((h) => fetch(h).then((r) => r.status, () => 0), fontHref) : 0;
if (fontOnline === 200) {
  await clickMenuItem('Testa utan nät');
  await page.waitForSelector('#offlineMark:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#stage.sv-loading'), null, { timeout: 20000 });
  await wait(2500);
  const off = await mainFrame().evaluate((h) => fetch(h).then((r) => r.status, () => 0), fontHref);
  const ext = await mainFrame().evaluate(() => fetch('https://example.com/?hp-test', { mode: 'no-cors' }).then(() => 'online', () => 'blocked'));
  check(off === 200 && ext === 'blocked', 'with Testa utan nät on, other requests fail but the saved fonts still load', `${off}, ${ext}`);
  await clickMenuItem('Testa utan nät');
  await page.waitForSelector('#offlineMark', { state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#stage.sv-loading'), null, { timeout: 20000 });
  await wait(1500);
} else {
  console.log('  (skipped the offline font check: Google Fonts could not be reached)');
}

await app.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
