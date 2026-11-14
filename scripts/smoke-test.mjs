// Röktest: startar appen med Playwright, öppnar ett deck (en kopia), tar skärmdumpar
// av normalvy, rutnät, redigering och presentatörsläge, och kontrollerar att en
// textändring sparas utan att resten av filen rörs.
//
//   node scripts/smoke-test.mjs <deck.html> [utmapp]

import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'hp-smoke'));
if (!src) { console.error('Ange en deck-fil.'); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

// Kopian läggs i en egen mapp med samma filnamn. En fil utanför mappen och en
// innanför används för att kontrollera att decket bara kommer åt sin egen mapp.
const deckDir = path.join(out, 'deck');
fs.mkdirSync(deckDir, { recursive: true });
const deck = path.join(deckDir, path.basename(src));
fs.copyFileSync(src, deck);
fs.writeFileSync(path.join(out, 'outside.txt'), 'hemligt');
fs.writeFileSync(path.join(deckDir, 'inside.txt'), 'ok');
const original = fs.readFileSync(deck, 'utf8');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => { const p = path.join(out, name + '.png'); await page.screenshot({ path: p }); console.log('📸', p); };

const app = await electron.launch({
  // HP_EXEC = sökväg till en byggd app, för att testa paketet i stället för källkoden.
  ...(process.env.HP_EXEC ? { executablePath: process.env.HP_EXEC, args: [deck] } : { args: [root, deck] }),
  env: { ...process.env, HP_FAKE_DUAL: '1', HP_USER_DATA: path.join(out, 'userdata') },
});
app.process().stdout.on('data', (d) => process.stdout.write('[main] ' + d));
app.process().stderr.on('data', (d) => { const s = String(d); if (!/Electron Security Warning|DevTools/.test(s)) process.stderr.write('[main!] ' + s); });

const page = await app.firstWindow();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[renderer]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[renderer pageerror]', e.message));

await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
await page.waitForSelector('#workspace:not([hidden])', { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll('#thumbList li').length > 0, null, { timeout: 20000 });
const n = await page.$$eval('#thumbList li', (l) => l.length);
console.log('slides:', n, '| status:', await page.textContent('#statusMid'));

// Filåtkomst: decket ska nå sin egen mapp men inte filer utanför.
const access = await page.frames().find((f) => f.url().includes('hp=main')).evaluate(async () => {
  const get = (u) => fetch(u).then((r) => r.status).catch(() => 'fel');
  return { inside: await get('inside.txt'), outside: await get('../outside.txt'), system: await get('/fs/etc/hosts') };
});
console.log('filåtkomst — inuti:', access.inside, '| utanför:', access.outside, '| /etc/hosts:', access.system);

// Vänta på miniatyrer
const t0 = Date.now();
await page.waitForFunction((n) => document.querySelectorAll('#thumbList .thumb img').length >= Math.min(n, 6), n, { timeout: 60000 });
console.log('första miniatyrerna efter', Date.now() - t0, 'ms');
await wait(600);
await page.keyboard.press('ArrowRight');
await wait(700);
console.log('efter →:', await page.textContent('#statusLeft'));
await shot(page, '1-normal');

// Rutnät
await page.click('.seg button[data-view="grid"]');
await page.waitForFunction((n) => document.querySelectorAll('#gridList .thumb img').length >= n, n, { timeout: 90000 }).catch(() => console.log('alla miniatyrer hann inte bli klara'));
console.log('alla miniatyrer efter', Date.now() - t0, 'ms');
await wait(300);
await shot(page, '2-grid');
await page.click('.seg button[data-view="normal"]');

// Redigering: klicka i första rubriken på aktuell slide och lägg till text
await page.click('#editBtn');
await wait(300);
const frame = page.frames().find((f) => f.url().includes('hp=main'));
const target = await frame.evaluate(() => {
  const s = window.__hp.slides[window.__hp.index];
  const el = [...s.querySelectorAll('h1, h2, h3, p')].find((e) => e.textContent.trim().length > 3 && e.getBoundingClientRect().width > 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(r.width - 4, 30), y: r.top + r.height / 2, text: el.textContent.trim().slice(0, 60), id: el.getAttribute('data-hp-id') };
});
console.log('redigerar:', target);
if (target) {
  const fr = await page.$eval('#stage iframe', (f) => { const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth }; });
  await page.mouse.click(fr.left + target.x * fr.scale, fr.top + target.y * fr.scale);
  await wait(200);
  const editing = await frame.evaluate(() => window.__hp.editing);
  console.log('textredigering aktiv:', editing);
  await page.keyboard.press('End');
  await page.keyboard.type(' [ÄNDRAT]');
  await wait(150);
  await shot(page, '3-editing');
  await page.keyboard.press('Escape');
  await wait(400);
  await page.click('#saveBtn');
  await wait(600);
  const saved = fs.readFileSync(deck, 'utf8');
  const changedChars = saved.length - original.length;
  const idx = saved.indexOf('[ÄNDRAT]');
  console.log('sparad fil innehåller ändringen:', idx >= 0, '| längdskillnad:', changedChars, '| märken kvar:', /data-hp-id/.test(saved));
  // Allt utom den ändrade biten ska vara identiskt:
  let a = 0; while (a < original.length && original[a] === saved[a]) a++;
  let b = 0; while (b < original.length - a && original[original.length - 1 - b] === saved[saved.length - 1 - b]) b++;
  console.log('ändrat område i originalet:', JSON.stringify(original.slice(a, original.length - b)), '→', JSON.stringify(saved.slice(a, saved.length - b)));
  // Ta bort ett element (⌥-klick + ⌫) och ångra
  const fr2 = await page.$eval('#stage iframe', (f) => { const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / f.offsetWidth }; });
  await page.keyboard.down('Alt');
  await page.mouse.click(fr2.left + target.x * fr2.scale, fr2.top + target.y * fr2.scale);
  await page.keyboard.up('Alt');
  await wait(200);
  const before = await frame.evaluate((id) => !!document.querySelector(`[data-hp-id="${id}"]`), target.id);
  await shot(page, '3b-selected');
  await page.keyboard.press('Backspace');
  await wait(400);
  const gone = await frame.evaluate((id) => !document.querySelector(`[data-hp-id="${id}"]`), target.id);
  const dirty = await page.isVisible('#dirtyMark');
  console.log('element fanns:', before, '| borttaget:', gone, '| markerad som ändrad:', dirty);
  await page.click('#undoBtn');
  await wait(1500);
  const frameAfter = page.frames().find((f) => f.url().includes('hp=main'));
  const back = await frameAfter.evaluate((id) => !!document.querySelector(`[data-hp-id="${id}"]`), target.id);
  console.log('tillbaka efter ångra:', back, '| fortfarande ändrad:', await page.isVisible('#dirtyMark'));
}
await page.click('#editBtn');

// Presentatörsläge (HP_FAKE_DUAL=1 ger publikfönstret som vanligt fönster)
const audiencePromise = app.waitForEvent('window', { timeout: 15000 });
await page.click('#presentBtn');
const audience = await audiencePromise;
await audience.waitForLoadState();
audience.on('console', (m) => { if (m.type() === 'error') console.log('[audience]', m.text()); });
audience.on('pageerror', (e) => console.log('[audience pageerror]', e.message));
await page.waitForSelector('#presenter:not([hidden])');
await audience.waitForFunction(() => { const f = document.querySelector('iframe'); return f && f.contentWindow && f.contentWindow.__hp && f.contentWindow.__hp.ready; }, null, { timeout: 20000 }).catch(() => console.log('publikfönstret blev aldrig klart'));
await wait(1000);
await page.keyboard.press('ArrowRight');
await wait(1200);
await shot(page, '4-presenter');
await audience.screenshot({ path: path.join(out, '5-audience.png') });
console.log('📸', path.join(out, '5-audience.png'));
const audIdx = await audience.evaluate(() => { const f = document.querySelector('iframe'); return f && f.contentWindow.__hp ? f.contentWindow.__hp.index : null; });
const presIdx = await page.evaluate(() => document.querySelector('#pCount').textContent);
console.log('publik visar index', audIdx, '| presentatör:', presIdx);

await page.keyboard.press('Escape');
await wait(800);
console.log('tillbaka i normalvy:', await page.isVisible('#workspace'));

await app.close();
console.log('KLART');
