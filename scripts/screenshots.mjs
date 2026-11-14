// Makes the README screenshots from examples/demo-deck.html into docs/.
//   node scripts/screenshots.mjs
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-shots-'));
const deck = path.join(work, 'demo-deck.html');
fs.copyFileSync(path.join(root, 'examples', 'demo-deck.html'), deck);
fs.mkdirSync(outDir, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({
  args: [root, deck],
  env: { ...process.env, HP_FAKE_DUAL: '1', HP_USER_DATA: path.join(work, 'userdata') },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
await page.waitForFunction(() => document.querySelectorAll('#thumbList .thumb img').length >= 6, null, { timeout: 60000 });
const shot = async (target, name) => { await target.screenshot({ path: path.join(outDir, name) }); console.log('docs/' + name); };
const mainFrame = () => page.frames().find((f) => f.url().includes('hp=main'));

// Normal view on the chart slide
await page.click('#thumbList li:nth-child(3)');
await wait(1400);
await shot(page, 'normal-view.png');

// Grid
await page.click('.seg button[data-view="grid"]');
await wait(500);
await shot(page, 'grid-view.png');
await page.click('.seg button[data-view="normal"]');

// Edit mode: text editing in the heading of slide 5
await page.click('#thumbList li:nth-child(5)');
await wait(800);
await page.click('#editBtn');
await wait(300);
const pt = await mainFrame().evaluate(() => {
  const h = window.__hp.slides[window.__hp.index].querySelector('h2');
  const r = h.getBoundingClientRect();
  return { x: r.left + r.width * 0.62, y: r.top + r.height * 0.5 };
});
const fr = await page.$eval('#stage iframe', (f) => { const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, s: r.width / f.offsetWidth }; });
await page.mouse.click(fr.left + pt.x * fr.s, fr.top + pt.y * fr.s);
await wait(400);
await shot(page, 'edit-mode.png');
await page.keyboard.press('Escape');
await page.click('#editBtn');

// Presenter view on slide 3
const audienceP = app.waitForEvent('window', { timeout: 15000 });
await page.click('#thumbList li:nth-child(3)');
await wait(300);
await page.click('#presentBtn');
const audience = await audienceP;
await page.waitForSelector('#presenter:not([hidden])');
await wait(2500);
await page.evaluate(() => { document.getElementById('pBanner').hidden = true; });
await wait(200);
await shot(page, 'presenter-view.png');
await audience.setViewportSize({ width: 1280, height: 720 }).catch(() => {});
await wait(600);
await shot(audience, 'audience-window.png');

await app.close();
fs.rmSync(work, { recursive: true, force: true });
