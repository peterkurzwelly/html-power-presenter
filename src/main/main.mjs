// main.mjs — Electron-huvudprocessen för HTML Presenter.
//
// Ansvar: serverar appens UI och dina deck-filer via hpres://, håller källtexten
// (DeckStore), renderar miniatyrer, och sköter fönstren när du presenterar —
// publikfönstret på en skärm, presentatörsvyn på den andra.

import {
  app, BrowserWindow, protocol, ipcMain, dialog, Menu, screen,
  powerSaveBlocker, shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DeckStore, extractSlides, planRemoveSlidesFromFile, applyRemovePlan, readText } from './deckstore.mjs';
import { ThumbRenderer } from './thumbs.mjs';
import { adaptChunk, classCoverage, deckCssText, makeUrlRewriter } from './importer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = 'hpres';
const ORIGIN = `${SCHEME}://app`;        // appens eget UI
const DECK_ORIGIN = `${SCHEME}://deck`;  // det öppna decket (egen origin: når inte appen)
const SOURCE_ORIGIN = `${SCHEME}://source`; // decket du hämtar slides från
const UI_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const CONTROLLER_URL = `${ORIGIN}/ui/controller.js`;
const FAKE_DUAL = process.env.HP_FAKE_DUAL === '1';

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

app.setName('HTML Presenter');
if (process.env.HP_USER_DATA) app.setPath('userData', process.env.HP_USER_DATA); // för tester

let mainWin = null;
let audienceWin = null;
let presenting = null; // { rehearse, swapped, blocker, restore }
let lastSync = null;
let pendingOpen = null;
let watcher = null;
let quitting = false;

const BACKUP_DIR = path.join(app.getPath('userData'), 'Säkerhetskopior');
const deck = new DeckStore({ backupDir: BACKUP_DIR });
const thumbs = new ThumbRenderer((t) => send(mainWin, 'thumb', t));
let importer = null; // { store, thumbs, path, text, token, info }

/* ------------------------------------------------------------------ helpers */

function send(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) return;
  wc.send(channel, payload);
}

function deckBaseUrl(p, origin = DECK_ORIGIN) {
  return `${origin}/fs${p.split('/').map(encodeURIComponent).join('/')}`;
}

// Regeln som hittade slidesen i appens vy (t.ex. "section.slide"), så att publikfönstret
// och miniatyrerna delar upp decket på samma sätt även när bara en slide finns kvar.
let deckHpsel = null;
const setHpsel = (v) => { deckHpsel = typeof v === 'string' && /^[\w .>\[\]-]{1,100}$/.test(v) ? v : null; };

function deckUrl(mode) {
  return `${deckBaseUrl(deck.path)}?hp=${mode}&rev=${deck.rev}${deckHpsel ? '&hpsel=' + encodeURIComponent(deckHpsel) : ''}`;
}

function publicState(extra = {}) {
  if (!deck.path) return { open: false, ...extra };
  return { open: true, ...deck.state(), baseUrl: deckBaseUrl(deck.path), ...extra };
}

function pushState(extra) {
  const s = publicState(extra);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setDocumentEdited(!!s.dirty);
    mainWin.setTitle(s.open ? s.name : 'HTML Presenter');
    if (s.open) mainWin.setRepresentedFilename(s.path);
  }
  send(mainWin, 'deck-state', s);
  updateMenu();
  return s;
}

/* ---------------------------------------------------------------- protocol */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function serveFile(file, req) {
  let stat;
  try { stat = fs.statSync(file); } catch { return new Response('Hittades inte', { status: 404 }); }
  if (!stat.isFile()) return new Response('Hittades inte', { status: 404 });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };

  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (!m[1] && m[2]) { start = Math.max(0, stat.size - parseInt(m[2], 10)); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
    }
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${stat.size}` },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200, headers: { ...headers, 'content-length': String(stat.size) },
  });
}

function isInside(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Ett decks skript får bara läsa filer i deckets egen mapp (och undermappar).
// Symlänkar löses upp först, så en länk i mappen kan inte peka ut på disken.
function serveDeckFile(store, u, p, req) {
  if (!store || !store.path || !p.startsWith('/fs/')) return new Response('Hittades inte', { status: 404 });
  const abs = path.normalize(p.slice(3));
  if (u.searchParams.has('hp') && abs === store.path) {
    return new Response(store.servedHtml(CONTROLLER_URL), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  let real, root;
  try { root = fs.realpathSync(path.dirname(store.path)); } catch { return new Response('Nej', { status: 403 }); }
  try { real = fs.realpathSync(abs); } catch { return new Response('Hittades inte', { status: 404 }); }
  if (!isInside(real, root)) return new Response('Utanför deckets mapp', { status: 403 });
  return serveFile(real, req);
}

function handleProtocol(req) {
  const u = new URL(req.url);
  const p = decodeURIComponent(u.pathname);
  if (u.host === 'app') {
    if (!p.startsWith('/ui/')) return new Response('Hittades inte', { status: 404 });
    const file = path.normalize(path.join(UI_DIR, p.slice(4)));
    if (!isInside(file, UI_DIR)) return new Response('Nej', { status: 403 });
    return serveFile(file, req);
  }
  if (u.host === 'deck') return serveDeckFile(deck, u, p, req);
  if (u.host === 'source') return serveDeckFile(importer && importer.store, u, p, req);
  return new Response('Okänd värd', { status: 404 });
}

// Länkar och nya fönster från ett deck öppnas i webbläsaren, aldrig i appen.
function guardWindow(win, allowedPrefix) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(allowedPrefix)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  wc.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    // Bara appens egna ramar (decket som visas) vaktas. Ramar INUTI decket, som en
    // YouTube- eller CodePen-inbäddning, får ladda som i en webbläsare.
    const parent = e.frame && e.frame.parent;
    if (parent && parent.parent) return;
    const url = e.url || '';
    if (url === 'about:blank') return;
    try {
      const u = new URL(url);
      // (Nodes URL ger origin "null" för egna scheman, så jämför schema + värd.)
      const origin = `${u.protocol}//${u.host}`;
      if ((origin === DECK_ORIGIN || origin === SOURCE_ORIGIN) && u.searchParams.has('hp')) return;
    } catch (_) { /* ogiltig adress */ }
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

/* ------------------------------------------------------------------ recent */

const RECENT_FILE = () => path.join(app.getPath('userData'), 'senaste.json');

function readRecent() {
  try {
    const list = JSON.parse(fs.readFileSync(RECENT_FILE(), 'utf8'));
    return list.filter((r) => r && r.path && fs.existsSync(r.path));
  } catch { return []; }
}

function writeRecent(list) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(RECENT_FILE(), JSON.stringify(list.slice(0, 15), null, 2));
  } catch (err) { console.error('recent', err); }
}

function touchRecent(p, patch = {}) {
  const list = readRecent();
  const old = list.find((r) => r.path === p) || {};
  const entry = { ...old, path: p, name: path.basename(p), openedAt: Date.now(), ...patch };
  writeRecent([entry, ...list.filter((r) => r.path !== p)]);
  app.addRecentDocument(p);
  return entry;
}

/* ------------------------------------------------------------- open / save */

// Be UI:t skicka en text du håller på att skriva innan vi kollar om något är osparat.
let flushSeq = 0;
function flushRenderer() {
  if (!mainWin || mainWin.isDestroyed()) return Promise.resolve();
  const id = ++flushSeq;
  return new Promise((resolve) => {
    const done = (e, got) => { if (got !== id || e.sender !== mainWin.webContents) return; ipcMain.removeListener('flushed', done); clearTimeout(t); resolve(); };
    const t = setTimeout(() => { ipcMain.removeListener('flushed', done); resolve(); }, 1500);
    ipcMain.on('flushed', done);
    mainWin.webContents.send('flush', id);
  });
}

async function confirmDiscard() {
  await flushRenderer();
  if (!deck.dirty) return true;
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'warning',
    message: `Vill du spara ändringarna i ”${deck.name}”?`,
    detail: 'Ändringarna går förlorade om du inte sparar.',
    buttons: ['Spara', 'Spara inte', 'Avbryt'],
    defaultId: 0, cancelId: 2,
  });
  if (response === 2) return false;
  if (response === 0) return doSave();
  return true;
}

async function openDeck(p) {
  if (!mainWin) { pendingOpen = p; return null; }
  p = path.resolve(String(p || ''));
  if (!/\.html?$/i.test(p) || !fs.existsSync(p)) {
    dialog.showErrorBox('Kunde inte öppna filen', `Bara .html- och .htm-filer kan öppnas.\n\n${p}`);
    return null;
  }
  // Samma fil igen (Öppna senaste, Finder, dra in): visa den bara, kasta inte ändringar.
  if (deck.path === p) { mainWin.show(); mainWin.focus(); return publicState(); }
  if (deck.path && !(await confirmDiscard())) return null;
  if (presenting) stopPresenting();
  try {
    deck.load(p);
  } catch (err) {
    dialog.showErrorBox('Kunde inte öppna filen', `${p}\n\n${err.message}`);
    return null;
  }
  setHpsel(null);
  const entry = touchRecent(p);
  watchFile(p);
  closeImporter();
  thumbs.cancel();
  return pushState({ reload: true, lastIndex: entry.lastIndex || 0 });
}

async function reloadDeck() {
  if (!deck.path) return null;
  if (!(await confirmDiscard())) return null;
  try { deck.load(deck.path); } catch (err) { dialog.showErrorBox('Kunde inte läsa filen', err.message); return null; }
  return pushState({ reload: true });
}

function closeDeck() {
  setHpsel(null);
  unwatch();
  closeImporter();
  thumbs.cancel();
  deck.close();
  pushState({ reload: true });
}

async function doSave() {
  if (!deck.path) return false;
  try {
    selfWrite = Date.now();
    deck.save();
    pushState();
    return true;
  } catch (err) {
    dialog.showErrorBox('Kunde inte spara', err.message);
    return false;
  }
}

async function doSaveAs() {
  if (!deck.path) return false;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    defaultPath: deck.path,
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  if (canceled || !filePath) return false;
  try {
    selfWrite = Date.now();
    deck.save(filePath);
    touchRecent(deck.path);
    watchFile(deck.path);
    pushState();
    return true;
  } catch (err) {
    dialog.showErrorBox('Kunde inte spara', err.message);
    return false;
  }
}

async function showOpenDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    properties: ['openFile'],
    filters: [{ name: 'HTML-presentationer', extensions: ['html', 'htm'] }],
  });
  if (canceled || !filePaths[0]) return null;
  return openDeck(filePaths[0]);
}

/* ------------------------------------------------------------ file watching */

let selfWrite = 0;
let watchTimer = null;

function unwatch() {
  if (watcher) { watcher.close(); watcher = null; }
}

// Bevakar mappen i stället för filen: verktyg som skriver en ny fil och byter namn
// på den ersätter filen, och då tappar en bevakning av själva filen spåret.
function watchFile(p) {
  unwatch();
  const name = path.basename(p);
  try {
    watcher = fs.watch(path.dirname(p), (_event, filename) => {
      if (filename && filename.toString() !== name) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => onFileChanged(p), 350);
    });
  } catch (err) { console.error('watch', err); }
}

async function onFileChanged(p) {
  if (p !== deck.path || !fs.existsSync(p)) return;
  if (Date.now() - selfWrite < 1500) return;
  const read = () => { try { return readText(p).text; } catch { return null; } };
  if (read() === deck.diskText) return;
  // En text du håller på att skriva räknas som en osparad ändring.
  await flushRenderer();
  if (p !== deck.path) return;
  const text = read();
  if (text == null || text === deck.diskText) return;
  if (deck.dirty) {
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'question',
      message: `”${deck.name}” har ändrats utanför appen.`,
      detail: 'Vill du läsa in den nya versionen? Dina osparade ändringar i appen försvinner då.',
      buttons: ['Behåll mina ändringar', 'Läs in nya versionen'],
      defaultId: 0, cancelId: 0,
    });
    if (response !== 1) { deck.diskText = text; return; }
  }
  deck.load(p);
  pushState({ reload: true, external: true });
  if (presenting) syncAudience(lastSync);
}

/* ------------------------------------------------------------- presenting */

// Vilken skärm som visar vad sparas som skärm-id, så att "Byt skärmar" alltid byter
// och att en skärm som kopplas in eller ur inte flyttar presentatörsvyn till projektorn.
function displaysFor() {
  const all = screen.getAllDisplays();
  const byId = (id) => all.find((d) => d.id === id);
  let pres = presenting && byId(presenting.presenterId);
  let aud = presenting && byId(presenting.audienceId);
  if (!pres) pres = screen.getDisplayMatching(presenting ? presenting.restore.bounds : mainWin.getBounds());
  if (!aud || aud.id === pres.id) aud = all.find((d) => d.id !== pres.id) || pres;
  if (presenting) { presenting.presenterId = pres.id; presenting.audienceId = aud.id; }
  return { all, presenterDisplay: pres, audienceDisplay: aud, dual: aud.id !== pres.id };
}

function swapDisplays() {
  if (!presenting) return;
  displaysFor();
  if (presenting.audienceId === presenting.presenterId) return;
  [presenting.presenterId, presenting.audienceId] = [presenting.audienceId, presenting.presenterId];
  layoutPresentation();
}

function createAudienceWindow() {
  const win = new BrowserWindow({
    show: false,
    frame: FAKE_DUAL,
    width: 960, height: 540,
    backgroundColor: '#000000',
    title: 'Publik',
    webPreferences: { preload: PRELOAD, spellcheck: false, backgroundThrottling: false },
  });
  guardWindow(win, `${ORIGIN}/ui/`);
  win.loadURL(`${ORIGIN}/ui/audience.html`);
  win.on('closed', () => {
    if (audienceWin === win) audienceWin = null;
    if (presenting && !presenting.rehearse && !quitting) stopPresenting();
  });
  return win;
}

function placeWindow(win, display, full) {
  if (!win || win.isDestroyed()) return;
  if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false);
  const b = display.bounds;
  if (full) {
    win.setBounds(b);
    win.setSimpleFullScreen(true);
  } else {
    win.setBounds({ x: b.x + 60, y: b.y + 60, width: Math.round(b.width * 0.5), height: Math.round(b.width * 0.5 * 9 / 16) });
  }
}

function layoutPresentation() {
  if (!presenting || !mainWin) return;
  const { presenterDisplay, audienceDisplay, dual } = displaysFor();
  presenting.dual = dual;
  if (!presenting.rehearse) {
    if (!audienceWin) audienceWin = createAudienceWindow();
    placeWindow(audienceWin, audienceDisplay, !FAKE_DUAL);
    audienceWin.show();
  }
  // Presentatörsvyn fyller sin skärm när det finns två skärmar (eller vid övning).
  if (dual || presenting.rehearse || FAKE_DUAL) {
    if (dual && !presenting.rehearse) placeWindow(mainWin, presenterDisplay, !FAKE_DUAL);
    else if (!mainWin.isSimpleFullScreen() && !FAKE_DUAL) mainWin.setSimpleFullScreen(true);
  }
  if (dual || presenting.rehearse || FAKE_DUAL) mainWin.focus();
  else if (audienceWin) audienceWin.focus();
  send(mainWin, 'present-layout', { dual, rehearse: presenting.rehearse, audience: !!audienceWin, fake: FAKE_DUAL });
}

function startPresenting({ rehearse = false } = {}) {
  if (!deck.path || !mainWin) return null;
  if (presenting) { layoutPresentation(); return { ok: true }; }
  presenting = {
    rehearse,
    presenterId: null,
    audienceId: null,
    blocker: powerSaveBlocker.start('prevent-display-sleep'),
    restore: { bounds: mainWin.getBounds(), maximized: mainWin.isMaximized(), simple: mainWin.isSimpleFullScreen() },
  };
  layoutPresentation();
  const { dual } = displaysFor();
  updateMenu();
  return { ok: true, dual, rehearse, audience: !!audienceWin, fake: FAKE_DUAL };
}

function stopPresenting() {
  if (!presenting) return;
  const p = presenting;
  presenting = null;
  lastSync = null;
  if (powerSaveBlocker.isStarted(p.blocker)) powerSaveBlocker.stop(p.blocker);
  if (audienceWin && !audienceWin.isDestroyed()) { const w = audienceWin; audienceWin = null; w.destroy(); }
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isSimpleFullScreen() && !p.restore.simple) mainWin.setSimpleFullScreen(false);
    mainWin.setBounds(p.restore.bounds);
    if (p.restore.maximized) mainWin.maximize();
    mainWin.focus();
  }
  send(mainWin, 'present-stopped', {});
  updateMenu();
}

function syncAudience(state) {
  if (!state) return;
  lastSync = { ...state, url: deck.path ? deckUrl('audience') : null };
  send(audienceWin, 'sync', lastSync);
}

/* -------------------------------------------------------------------- IPC */

// Bara appens egna sidor (hpres://app/ui/…) får prata med huvudprocessen, och de
// flesta kanalerna bara från huvudfönstret. Publikfönstret får bara säga att det är
// redo och skicka vidare tangenter.
const fromApp = (e) => !!(e.senderFrame && e.senderFrame.origin === ORIGIN);
const fromMain = (e) => fromApp(e) && !!mainWin && e.sender === mainWin.webContents;
const fromAudience = (e) => fromApp(e) && !!audienceWin && e.sender === audienceWin.webContents;

function wireIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (e, ...a) => {
    if (!fromMain(e)) throw new Error('Nekad');
    return fn(e, ...a);
  });
  const on = (channel, allowed, fn) => ipcMain.on(channel, (e, ...a) => { if (allowed(e)) fn(e, ...a); });

  handle('open-dialog', () => showOpenDialog());
  handle('open-path', (_e, p) => openDeck(p));
  handle('close-deck', async () => { if (await confirmDiscard()) closeDeck(); });
  handle('reload-deck', () => reloadDeck());
  handle('recent', () => readRecent());
  handle('forget-recent', (_e, p) => writeRecent(readRecent().filter((r) => r.path !== p)));
  handle('state', () => publicState());
  handle('remember-index', (_e, i) => { if (deck.path) touchRecent(deck.path, { lastIndex: i }); });
  handle('reveal', () => { if (deck.path) shell.showItemInFolder(deck.path); });

  handle('can-edit', (_e, { id, html }) => {
    try { return deck.readOnly ? { ok: false, reason: 'Filen är skrivskyddad (inte UTF-8).' } : deck.canEdit(id, html); }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  handle('edit-inner', (_e, { id, html, orig }) => {
    try {
      if (typeof html !== 'string' || typeof orig !== 'string') throw new Error('Ogiltig ändring.');
      deck.replaceInner(id, html, orig);
      return pushState();
    }
    catch (err) { return { error: err.message }; }
  });
  handle('edit-remove', (_e, { id }) => {
    try { deck.remove(id); return pushState(); }
    catch (err) { return { error: err.message }; }
  });
  handle('undo', () => { const ok = deck.undo(); return pushState({ reload: ok }); });
  handle('redo', () => { const ok = deck.redo(); return pushState({ reload: ok }); });
  handle('save', () => doSave());
  handle('save-as', () => doSaveAs());

  handle('thumbs', (_e, { token, indices, hpsel }) => {
    if (!deck.path) return;
    setHpsel(hpsel);
    thumbs.render(deckUrl('thumb'), token, indices || null);
  });

  handle('present-start', (_e, opts) => { setHpsel(opts && opts.hpsel); return startPresenting(opts); });
  handle('present-stop', () => stopPresenting());
  handle('present-swap', () => swapDisplays());
  on('present-sync', fromMain, (_e, state) => syncAudience(state));
  on('audience-ready', fromAudience, () => syncAudience(lastSync));
  on('audience-key', fromAudience, (_e, k) => send(mainWin, 'remote-key', k));
  handle('displays', () => {
    const all = screen.getAllDisplays();
    return { count: all.length, fakeDual: FAKE_DUAL };
  });

  // Slides: ordning, duplicering, borttagning (ids = alla slides i nuvarande ordning).
  // `rev` är versionen som UI:ts slide-lista hör till. Har decket ändrats sedan dess
  // (t.ex. två ⌘D i snabb följd) stämmer inte id:na längre, och då görs ingenting.
  const slideOp = (rev, fn) => {
    if (rev !== deck.rev) return { error: 'Vänta tills presentationen har laddats om och försök igen.', stale: true };
    try { fn(); return pushState({ reload: true }); }
    catch (err) { return { error: err.message }; }
  };
  handle('slides-reorder', (_e, { ids, order, rev }) => slideOp(rev, () => deck.reorderSlides(ids, order)));
  handle('slides-remove', (_e, { ids, indices, rev }) => slideOp(rev, () => deck.removeSlides(ids, indices)));
  handle('slides-duplicate', (_e, { ids, index, rev }) => slideOp(rev, () => deck.duplicateSlide(ids, index)));

  // Hämta slides från ett annat deck.
  handle('import-pick', () => importPick());
  handle('import-cancel', () => closeImporter());
  handle('import-run', (_e, opts) => importRun(opts));
}

/* ------------------------------------------------- slides från ett annat deck */

function closeImporter() {
  if (!importer) return;
  importer.thumbs.destroy();
  importer = null;
}

async function importPick() {
  if (!deck.path) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    title: 'Infoga slides från en annan presentation',
    buttonLabel: 'Välj',
    properties: ['openFile'],
    filters: [{ name: 'HTML-presentationer', extensions: ['html', 'htm'] }],
  });
  if (canceled || !filePaths[0]) return null;
  const p = path.resolve(filePaths[0]);
  if (p === deck.path) {
    await dialog.showMessageBox(mainWin, {
      type: 'info',
      message: 'Det är presentationen du redan har öppen.',
      detail: 'Använd Duplicera slide (⌘D) för att kopiera en slide inom samma presentation.',
    });
    return null;
  }
  closeImporter();
  const store = new DeckStore({ backupDir: BACKUP_DIR });
  try { store.load(p); } catch (err) { dialog.showErrorBox('Kunde inte öppna filen', `${p}\n\n${err.message}`); return null; }
  const token = `imp-${Date.now()}`;
  const imp = { store, path: p, text: store.diskText, token, info: null };
  imp.thumbs = new ThumbRenderer(
    (t) => { if (importer === imp) send(mainWin, 'import-thumb', t); },
    ({ info }) => { if (importer === imp) { imp.info = info; send(mainWin, 'import-info', { token, info }); } },
  );
  importer = imp;
  imp.thumbs.render(`${deckBaseUrl(p, SOURCE_ORIGIN)}?hp=thumb&rev=${store.rev}`, token);
  const coverage = classCoverage(store.diskText, deckCssText(deck.inst, deck.path));
  return {
    token,
    path: p,
    name: path.basename(p),
    sameFolder: path.dirname(p) === path.dirname(deck.path),
    suggestKeepStyles: coverage < 0.9,
  };
}

async function importRun({ token, indices, after, move, keepStyles, target, rev } = {}) {
  const imp = importer;
  if (!imp || imp.token !== token || !imp.info) return { error: 'Förhandsvisningen är inte klar än.' };
  if (!deck.path) return { error: 'Ingen presentation är öppen.' };
  if (rev !== deck.rev) return { error: 'Vänta tills presentationen har laddats om och försök igen.', stale: true };
  if (!target || !Array.isArray(target.ids) || !target.ids.length || target.ids.some((x) => x == null)) {
    return { error: 'Den öppna presentationens slides kunde inte kopplas till källfilen.' };
  }
  const list = [...new Set(indices || [])].filter((i) => Number.isInteger(i) && i >= 0 && i < imp.info.count).sort((a, b) => a - b);
  if (!list.length) return { error: 'Välj minst en slide.' };
  let inserted = false;
  try {
    if (readText(imp.path).text !== imp.text) throw new Error(`”${path.basename(imp.path)}” har ändrats sedan du valde den. Välj filen igen.`);
    const srcIds = imp.info.ids;
    if (!srcIds || srcIds.some((x) => x == null)) throw new Error('Slidesen i den andra presentationen kunde inte kopplas till dess källfil.');
    if (move && deck.readOnly) throw new Error('Den här presentationen är skrivskyddad.');
    // Flytta: räkna ut hur den andra filen ska se ut innan något ändras, så att ett
    // fel (t.ex. att alla slides skulle tas bort) stoppar allt i stället för halvvägs.
    const plan = move ? planRemoveSlidesFromFile(imp.path, srcIds, list, imp.text) : null;
    const raw = extractSlides(imp.store.inst, srcIds, list);
    const targetCss = deckCssText(deck.inst, deck.path);
    const styles = keepStyles ? await imp.thumbs.exec(`window.__hp.collectStyles(${JSON.stringify(list.map((i) => srcIds[i]))})`) : null;
    const copied = [];
    const srcName = path.basename(imp.path);
    const rewrite = makeUrlRewriter(path.dirname(imp.path), path.dirname(deck.path), srcName, copied);
    const stamp = Date.now().toString(36);
    const chunks = raw.map((html, k) => adaptChunk(html, {
      target: { slideTag: target.slideTag, commonClasses: target.commonClasses || [], strategy: target.strategy, size: target.size, css: targetCss },
      style: styles ? styles[k] : null,
      source: { name: srcName, size: imp.info.size, activeClasses: imp.info.activeClasses || [] },
      // Anteckningar som låg i källdeckets JSON-lista följer med som <aside>, om
      // inte det här decket också har en lista (då läggs de in där).
      note: imp.info.jsonNotes && !target.jsonNotes ? (imp.info.notes[list[k]] || '') : '',
      scopeClass: `hp-imp-${stamp}${k}`,
      rewrite,
    }));
    const at = Number.isInteger(after) ? Math.max(-1, Math.min(target.ids.length - 1, after)) : target.ids.length - 1;
    deck.insertSlides(target.ids, at, chunks, list.map((i) => imp.info.notes[i] || ''));
    inserted = true;
    let moved = false;
    if (move) {
      // Spara först det här decket, ta sedan bort slidesen ur det andra.
      selfWrite = Date.now();
      deck.save();
      try {
        applyRemovePlan(plan, BACKUP_DIR);
      } catch (err) {
        throw new Error(`Slidesen lades in här och presentationen sparades, men de kunde inte tas bort ur ”${srcName}”: ${err.message}`);
      }
      moved = true;
      // Den andra filen är redan ändrad på disk, så ⌘Z här skulle bara ta bort slidesen
      // ur det här decket. Därför går en flytt inte att ångra (kopiorna finns kvar).
      deck.undoStack = [];
      deck.redoStack = [];
    }
    return { ok: true, count: chunks.length, copied, styled: !!styles, moved, at, from: srcName };
  } catch (err) {
    return { error: err.message, inserted };
  } finally {
    if (inserted) { closeImporter(); pushState({ reload: true }); }
  }
}

/* ------------------------------------------------------------------- menu */

function menuAction(action) {
  return () => send(mainWin, 'menu', action);
}

function updateMenu() {
  const open = !!deck.path;
  const recent = readRecent().slice(0, 10).map((r) => ({ label: r.name, click: () => openDeck(r.path) }));
  const template = [
    { role: 'appMenu', label: 'HTML Presenter' },
    {
      label: 'Arkiv',
      submenu: [
        { label: 'Öppna…', accelerator: 'CmdOrCtrl+O', click: () => showOpenDialog() },
        { label: 'Öppna senaste', submenu: recent.length ? recent : [{ label: 'Inga filer', enabled: false }] },
        { type: 'separator' },
        { label: 'Spara', accelerator: 'CmdOrCtrl+S', enabled: open, click: menuAction('save') },
        { label: 'Spara som…', accelerator: 'Shift+CmdOrCtrl+S', enabled: open, click: menuAction('save-as') },
        { label: 'Läs in filen igen', accelerator: 'CmdOrCtrl+R', enabled: open, click: menuAction('reload') },
        { label: 'Visa i Finder', enabled: open, click: () => shell.showItemInFolder(deck.path) },
        { type: 'separator' },
        { label: 'Stäng presentation', accelerator: 'CmdOrCtrl+W', enabled: open, click: menuAction('close') },
      ],
    },
    {
      label: 'Redigera',
      submenu: [
        { label: 'Ångra', accelerator: 'CmdOrCtrl+Z', click: menuAction('undo') },
        { label: 'Gör om', accelerator: 'Shift+CmdOrCtrl+Z', click: menuAction('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Klipp ut' },
        { role: 'copy', label: 'Kopiera' },
        { role: 'paste', label: 'Klistra in' },
        { role: 'selectAll', label: 'Markera allt' },
        { type: 'separator' },
        { label: 'Redigeringsläge', accelerator: 'CmdOrCtrl+E', enabled: open, click: menuAction('toggle-edit') },
      ],
    },
    {
      label: 'Visa',
      submenu: [
        { label: 'Normal', accelerator: 'CmdOrCtrl+1', enabled: open, click: menuAction('view-normal') },
        { label: 'Rutnät', accelerator: 'CmdOrCtrl+2', enabled: open, click: menuAction('view-grid') },
        { type: 'separator' },
        { label: 'Visa/dölj anteckningar', accelerator: 'CmdOrCtrl+Alt+N', enabled: open, click: menuAction('toggle-notes') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Helskärm' },
        { role: 'toggleDevTools', label: 'Utvecklarverktyg' },
      ],
    },
    {
      label: 'Slides',
      submenu: [
        { label: 'Duplicera slide', accelerator: 'CmdOrCtrl+D', enabled: open, click: menuAction('slide-duplicate') },
        { label: 'Ta bort slide', enabled: open, click: menuAction('slide-delete') },
        { type: 'separator' },
        { label: 'Flytta slide uppåt', accelerator: 'Alt+CmdOrCtrl+Up', enabled: open, click: menuAction('slide-up') },
        { label: 'Flytta slide nedåt', accelerator: 'Alt+CmdOrCtrl+Down', enabled: open, click: menuAction('slide-down') },
        { label: 'Flytta slide först', accelerator: 'Shift+Alt+CmdOrCtrl+Up', enabled: open, click: menuAction('slide-first') },
        { label: 'Flytta slide sist', accelerator: 'Shift+Alt+CmdOrCtrl+Down', enabled: open, click: menuAction('slide-last') },
        { type: 'separator' },
        { label: 'Infoga slides från annan presentation…', accelerator: 'Shift+CmdOrCtrl+I', enabled: open, click: menuAction('import') },
      ],
    },
    {
      label: 'Bildspel',
      submenu: [
        { label: 'Presentera från början', accelerator: 'Shift+CmdOrCtrl+Enter', enabled: open, click: menuAction('present-start') },
        { label: 'Presentera från aktuell slide', accelerator: 'CmdOrCtrl+Enter', enabled: open, click: menuAction('present-current') },
        { label: 'Öva med presentatörsvy', accelerator: 'Alt+CmdOrCtrl+Enter', enabled: open, click: menuAction('present-rehearse') },
        { type: 'separator' },
        { label: 'Byt skärmar', enabled: !!presenting, click: () => swapDisplays() },
      ],
    },
    { role: 'windowMenu', label: 'Fönster' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------- windows */

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'HTML Presenter',
    backgroundColor: '#16171a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: { preload: PRELOAD, spellcheck: false, backgroundThrottling: false },
  });
  mainWin.loadURL(`${ORIGIN}/ui/index.html`);
  mainWin.once('ready-to-show', () => mainWin.show());
  guardWindow(mainWin, `${ORIGIN}/ui/`);
  let closeConfirmed = false;
  mainWin.on('close', async (e) => {
    if (closeConfirmed || !deck.path) return;
    e.preventDefault();
    if (await confirmDiscard()) { closeConfirmed = true; mainWin.close(); }
    else quitting = false;
  });
  mainWin.on('closed', () => {
    mainWin = null;
    stopPresenting();
    thumbs.destroy();
  });
  mainWin.webContents.on('did-finish-load', () => {
    if (pendingOpen) { const p = pendingOpen; pendingOpen = null; openDeck(p); }
  });
}

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => /\.html?$/i.test(a) && fs.existsSync(a));
}

/* ------------------------------------------------------------------ boot */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
    if (f) openDeck(f);
  });

  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (mainWin && !mainWin.webContents.isLoading()) openDeck(p);
    else pendingOpen = p;
  });

  app.whenReady().then(() => {
    protocol.handle(SCHEME, handleProtocol);
    wireIpc();
    updateMenu();
    const f = fileFromArgv(process.argv);
    if (f) pendingOpen = path.resolve(f);
    createMainWindow();

    const relayout = () => { if (presenting) layoutPresentation(); };
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!mainWin) createMainWindow(); });
}
