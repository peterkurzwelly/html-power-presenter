// main.mjs — Electron-huvudprocessen för HTML Presenter.
//
// Ansvar: serverar appens UI och dina deck-filer via hpres://, håller källtexten
// (DeckStore), renderar miniatyrer, och sköter fönstren när du presenterar —
// publikfönstret på en skärm, presentatörsvyn på den andra.

import {
  app, BrowserWindow, protocol, ipcMain, dialog, Menu, screen,
  powerSaveBlocker, shell, session, clipboard, net,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DeckStore, planRemoveSlidesFromFile, applyRemovePlan, readText, backupFile, extractSlides } from './deckstore.mjs';
import { ThumbRenderer } from './thumbs.mjs';
import { adaptChunk, classCoverage, deckCssText, makeUrlRewriter } from './importer.mjs';
import { Versions } from './versions.mjs';
import { FontCache, rewriteFontLinks, rewriteCssFiles, rewriteCssImports, fontFilesIn } from './fontcache.mjs';
import { slideForClaude, deckForClaude } from './forclaude.mjs';
import { installPermissionPolicy, setOfflineTest } from './policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = 'hpres';
const ORIGIN = `${SCHEME}://app`;        // appens eget UI
const DECK_ORIGIN = `${SCHEME}://deck`;  // det öppna decket (egen origin: når inte appen)
const SOURCE_ORIGIN = `${SCHEME}://source`; // decket du hämtar slides från
const UI_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const CONTROLLER_URL = `${ORIGIN}/ui/controller.js`;
const FAKE_DUAL = process.env.HP_FAKE_DUAL === '1'; // tester: fönsterläge som standard
const DEVTOOLS = !app.isPackaged || process.env.HP_DEVTOOLS === '1';

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

app.setName('HTML Presenter');
if (process.env.HP_USER_DATA) app.setPath('userData', process.env.HP_USER_DATA); // för tester

let mainWin = null;
let audienceWin = null;
let presenting = null; // { rehearse, windowed, size, presenterId, audienceId, blocker, restore, pendingFile }
let lastSync = null;
let pendingOpen = null;
let watcher = null;
let quitting = false;

const BACKUP_DIR = path.join(app.getPath('userData'), 'Säkerhetskopior');
const deck = new DeckStore({ backupDir: BACKUP_DIR });
const thumbs = new ThumbRenderer((t) => send(mainWin, 'thumb', t));
let importer = null; // { store, thumbs, path, text, token, info }
const versions = new Versions(path.join(app.getPath('userData'), 'Versioner'));
const fontCache = new FontCache(path.join(app.getPath('userData'), 'Typsnitt'), (url, opts) => net.fetch(url, opts), { onChange: () => schedulePush() });
// Typsnitt: vilka CSS-adresser decken länkar till (får hämtas), vilka det öppna decket
// faktiskt har bett om (visas i statusraden) och vilka typsnittsfiler CSS:erna pekar på.
const fontUse = { deck: new Set(), source: new Set(), requested: new Set(), files: new Set() };
let testOffline = false;

/* ------------------------------------------------------------------- prefs */

// Små inställningar som gäller mellan körningar: fönsterläge och talens mållängd.
const PREFS_FILE = () => path.join(app.getPath('userData'), 'installningar.json');
let prefs = null;
function getPrefs() {
  if (prefs) return prefs;
  try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')); } catch { prefs = {}; }
  if (!prefs || typeof prefs !== 'object') prefs = {};
  if (!prefs.talks || typeof prefs.talks !== 'object') prefs.talks = {};
  return prefs;
}
function savePrefs() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(getPrefs(), null, 1));
  } catch (err) { console.error('prefs', err); }
}
const windowedPref = () => (typeof getPrefs().windowed === 'boolean' ? getPrefs().windowed : FAKE_DUAL);

// En kopia av varje version av filen som appen ser (öppnad, sparad, ändrad utanför).
function snap(reason) {
  if (deck.path) versions.snapshot(deck.path, reason).catch((err) => console.error('version', err.message));
}

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
  const common = { windowed: windowedPref(), testOffline };
  if (!deck.path) return { open: false, ...common, ...extra };
  return {
    open: true, ...deck.state(), baseUrl: deckBaseUrl(deck.path),
    fonts: fontCache.status([...fontUse.requested]),
    pendingFile: !!(presenting && presenting.pendingFile),
    ...common, ...extra,
  };
}

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { if (deck.path) pushState(); }, 400);
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
function serveDeckFile(store, u, p, req, origin, used) {
  if (!store || !store.path || !p.startsWith('/fs/')) return new Response('Hittades inte', { status: 404 });
  const abs = path.normalize(p.slice(3));
  if (u.searchParams.has('hp') && abs === store.path) {
    // Google Fonts-länkar går via appen så att typsnitten finns även utan nät (filen ändras inte).
    const { html, urls } = rewriteFontLinks(store.servedHtml(CONTROLLER_URL), origin);
    const before = used.size;
    urls.forEach((x) => used.add(x));
    if (used.size !== before) schedulePush();
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  let real, root;
  try { root = fs.realpathSync(path.dirname(store.path)); } catch { return new Response('Nej', { status: 403 }); }
  try { real = fs.realpathSync(abs); } catch { return new Response('Hittades inte', { status: 404 }); }
  if (!isInside(real, root)) return new Response('Utanför deckets mapp', { status: 403 });
  if (/\.css$/i.test(real)) {
    try {
      const css = fs.readFileSync(real, 'utf8');
      const found = [];
      const out = rewriteCssImports(css, origin, found);
      if (found.length) {
        found.forEach((x) => used.add(x));
        return new Response(out, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } });
      }
    } catch (_) { /* skickas som vanlig fil */ }
  }
  return serveFile(real, req);
}

// hpres://deck/__fonts/css?u=… och …/file?u=…: Google Fonts från den sparade kopian
// eller nätet. Bara typsnitt som decket självt länkar till hämtas.
async function serveFont(u, origin, used) {
  const kind = u.pathname.slice('/__fonts/'.length);
  const url = u.searchParams.get('u') || '';
  try {
    if (kind === 'css' && used.has(url)) {
      if (used === fontUse.deck) fontUse.requested.add(url);
      const got = await fontCache.css(url);
      const css = got.body.toString('utf8');
      fontFilesIn(css).forEach((f) => fontUse.files.add(f));
      schedulePush();
      return new Response(rewriteCssFiles(css, origin), { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    if (kind === 'file' && fontUse.files.has(url)) {
      const got = await fontCache.file(url);
      return new Response(got.body, { headers: { 'content-type': got.type || 'font/woff2', 'cache-control': 'no-cache' } });
    }
  } catch (_) {
    schedulePush(); // statusraden visar att typsnittet saknas
    return new Response('Typsnittet kunde inte hämtas', { status: 504 });
  }
  return new Response('Hittades inte', { status: 404 });
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
  if (u.host === 'deck') return p.startsWith('/__fonts/') ? serveFont(u, DECK_ORIGIN, fontUse.deck) : serveDeckFile(deck, u, p, req, DECK_ORIGIN, fontUse.deck);
  if (u.host === 'source') return p.startsWith('/__fonts/') ? serveFont(u, SOURCE_ORIGIN, fontUse.source) : serveDeckFile(importer && importer.store, u, p, req, SOURCE_ORIGIN, fontUse.source);
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
  fontUse.deck.clear();
  fontUse.requested.clear();
  const entry = touchRecent(p);
  watchFile(p);
  closeImporter();
  thumbs.cancel();
  snap('open');
  return pushState({ reload: true, lastIndex: entry.lastIndex || 0 });
}

async function reloadDeck() {
  if (!deck.path) return null;
  if (!(await confirmDiscard())) return null;
  try { deck.load(deck.path); } catch (err) { dialog.showErrorBox('Kunde inte läsa filen', err.message); return null; }
  if (presenting) presenting.pendingFile = false;
  snap('reload');
  return pushState({ reload: true });
}

function closeDeck() {
  setHpsel(null);
  fontUse.deck.clear();
  fontUse.requested.clear();
  unwatch();
  closeImporter();
  thumbs.cancel();
  deck.close();
  pushState({ reload: true });
}

// Har filen ändrats på disk sedan appen läste den (t.ex. av ett AI-verktyg under ett
// bildspel)? Då sparas den versionen först, och du får välja innan den skrivs över.
async function confirmOverwriteExternal() {
  let disk;
  try { disk = readText(deck.path).text; } catch { return true; }
  if (disk === deck.diskText) return true;
  await versions.snapshot(deck.path, 'extern').catch(() => null);
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'warning',
    message: `”${deck.name}” har ändrats utanför appen sedan den lästes in.`,
    detail: 'Sparar du nu skrivs den nya versionen över med appens version. Den nya versionen finns kvar under Arkiv → Tidigare versioner.',
    buttons: ['Spara ändå', 'Avbryt'],
    defaultId: 1, cancelId: 1,
  });
  return response === 0;
}

async function doSave() {
  if (!deck.path) return false;
  if (!(await confirmOverwriteExternal())) return false;
  try {
    selfWrite = Date.now();
    deck.save();
    if (presenting) presenting.pendingFile = false;
    snap('save');
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
    snap('save');
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

// Ett verktyg kan fortfarande hålla på att skriva filen: läs tills den ligger still.
async function readStable(p) {
  const read = () => { try { return readText(p).text; } catch { return null; } };
  let a = read();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const b = read();
    if (b === a) return b;
    a = b;
  }
  return a;
}

// Under ett bildspel laddas ingenting om mitt i en mening: den nya versionen väntar
// tills bildspelet är slut, eller tills du själv väljer att läsa in den.
function holdFile() {
  if (presenting.pendingFile) return;
  presenting.pendingFile = true;
  send(mainWin, 'file-pending', { name: deck.name });
  pushState();
}

let fileCheck = null; // { again, force } medan en kontroll pågår
async function onFileChanged(p, { force = false } = {}) {
  if (fileCheck) { fileCheck.again = true; fileCheck.force = fileCheck.force || force; return; }
  fileCheck = { again: false, force: false };
  try { await checkFile(p, force); }
  finally {
    const again = fileCheck.again && deck.path;
    const againForce = fileCheck.force;
    fileCheck = null;
    if (again) setTimeout(() => onFileChanged(deck.path, { force: againForce }), 50);
  }
}

async function checkFile(p, force) {
  if (p !== deck.path || !fs.existsSync(p)) return;
  if (Date.now() - selfWrite < 1500) return;
  const quick = (() => { try { return readText(p).text; } catch { return null; } })();
  if (quick == null || quick === deck.diskText) return;
  const text = await readStable(p);
  if (p !== deck.path || text == null || text === deck.diskText) return;
  // Varje version som ett annat verktyg skriver sparas, även om den inte läses in nu.
  await versions.snapshot(p, 'extern').catch((err) => console.error('version', err.message));
  const locked = () => !!presenting && !force;
  if (locked()) { holdFile(); return; }
  // En text du håller på att skriva räknas som en osparad ändring.
  await flushRenderer();
  if (p !== deck.path) return;
  if (locked()) { holdFile(); return; }
  if (deck.dirty) {
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'question',
      message: `”${deck.name}” har ändrats utanför appen.`,
      detail: 'Vill du läsa in den nya versionen? Dina osparade ändringar i appen försvinner då. Den nya versionen finns kvar under Arkiv → Tidigare versioner om du behåller dina ändringar.',
      buttons: ['Behåll mina ändringar', 'Läs in nya versionen'],
      defaultId: 0, cancelId: 0,
    });
    if (p !== deck.path) return;
    if (response !== 1) {
      deck.diskText = text;
      if (presenting) presenting.pendingFile = false;
      pushState();
      return;
    }
  }
  if (locked()) { holdFile(); return; }
  deck.load(p);
  if (presenting) presenting.pendingFile = false;
  snap('extern');
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

function createAudienceWindow(framed) {
  const win = new BrowserWindow({
    show: false,
    frame: framed,
    width: 960, height: 540, minWidth: 320, minHeight: 180,
    backgroundColor: '#000000',
    title: `Publik – ${deck.name}`,
    webPreferences: { preload: PRELOAD, spellcheck: false, backgroundThrottling: false },
  });
  const size = presenting && presenting.size;
  if (framed && size) win.setAspectRatio(size.w / size.h);
  // Behåll fönstertiteln (sidans <title> är bara "Publik"), så att fönstret går att
  // känna igen när du väljer vad du ska dela i Teams eller Zoom.
  win.on('page-title-updated', (e) => e.preventDefault());
  guardWindow(win, `${ORIGIN}/ui/`);
  win.loadURL(`${ORIGIN}/ui/audience.html`);
  // I fönsterläge har publikfönstret en stängknapp: fråga innan bildspelet avslutas.
  win.on('close', (e) => {
    if (!framed || !presenting || quitting || audienceWin !== win) return;
    e.preventDefault();
    dialog.showMessageBox(mainWin, {
      type: 'question',
      message: 'Avsluta bildspelet?',
      detail: 'Publikfönstret stängs och du kommer tillbaka till redigeringsvyn.',
      buttons: ['Avsluta bildspelet', 'Fortsätt presentera'],
      defaultId: 1, cancelId: 1,
    }).then(({ response }) => { if (response === 0) stopPresenting(); });
  });
  win.on('closed', () => {
    if (audienceWin !== win) return; // ersatt av ett nytt fönster, eller bildspelet är slut
    audienceWin = null;
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

// Fönsterläge: presentatörsvyn och publiken som vanliga fönster. Med en skärm ligger de
// sida vid sida (presentatörsvyn till vänster), med två skärmar på var sin.
function placeWindowed(dual, presenterDisplay, audienceDisplay) {
  const ratio = presenting.size ? presenting.size.w / presenting.size.h : 16 / 9;
  if (mainWin.isSimpleFullScreen()) mainWin.setSimpleFullScreen(false);
  if (mainWin.isMaximized()) mainWin.unmaximize();
  mainWin.setMinimumSize(640, 420);
  if (!audienceWin) { mainWin.setBounds(presenterDisplay.workArea); return; } // övning
  if (audienceWin.isSimpleFullScreen()) audienceWin.setSimpleFullScreen(false);
  const bar = Math.max(0, audienceWin.getBounds().height - audienceWin.getContentBounds().height) || 28;
  if (dual) {
    const wa = audienceDisplay.workArea;
    let w = Math.round(wa.width * 0.8);
    let h = Math.round(w / ratio);
    if (h + bar > wa.height * 0.9) { h = Math.round(wa.height * 0.9 - bar); w = Math.round(h * ratio); }
    audienceWin.setContentBounds({ x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + Math.round((wa.height - h - bar) / 2) + bar, width: w, height: h });
    mainWin.setBounds(presenterDisplay.workArea);
  } else {
    const wa = presenterDisplay.workArea;
    // Presentatörsvyn behöver minst 640 px; publikfönstret får resten (minst 320 px).
    let aw = Math.max(320, Math.min(Math.round(wa.width * 0.42), wa.width - 640));
    let ah = Math.round(aw / ratio);
    if (ah + bar > wa.height) { ah = wa.height - bar; aw = Math.round(ah * ratio); }
    mainWin.setBounds({ x: wa.x, y: wa.y, width: wa.width - aw, height: wa.height });
    audienceWin.setContentBounds({ x: wa.x + wa.width - aw, y: wa.y + bar, width: aw, height: ah });
  }
}

// place = flytta fönstren till sina platser. I fönsterläge görs det bara när
// bildspelet startar, när läget byts och vid Byt skärmar, så att fönster du själv
// har flyttat (t.ex. för att dela i Teams) ligger kvar när en skärm kopplas in.
function layoutPresentation({ place = true } = {}) {
  if (!presenting || !mainWin) return;
  const { presenterDisplay, audienceDisplay, dual } = displaysFor();
  presenting.dual = dual;
  const windowed = presenting.windowed;
  let created = false;
  if (!presenting.rehearse) {
    if (!audienceWin) { audienceWin = createAudienceWindow(windowed); created = true; }
    if (!windowed) placeWindow(audienceWin, audienceDisplay, true);
  }
  if (windowed) {
    if (place || created) placeWindowed(dual, presenterDisplay, audienceDisplay);
    if (audienceWin && !audienceWin.isVisible()) audienceWin.showInactive();
    mainWin.focus();
  } else {
    if (audienceWin && !audienceWin.isVisible()) audienceWin.show();
    // Presentatörsvyn fyller sin skärm när det finns två skärmar (eller vid övning).
    if (dual && !presenting.rehearse) placeWindow(mainWin, presenterDisplay, true);
    else if (presenting.rehearse && !mainWin.isSimpleFullScreen()) mainWin.setSimpleFullScreen(true);
    if (dual || presenting.rehearse) mainWin.focus();
    else if (audienceWin) audienceWin.focus();
  }
  send(mainWin, 'present-layout', { dual, rehearse: presenting.rehearse, audience: !!audienceWin, windowed });
}

const validSize = (s) => (s && [s.w, s.h].every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 50 && x <= 20000) ? { w: s.w, h: s.h } : null);

const presentInfo = () => {
  const { dual } = displaysFor();
  return { ok: true, dual, rehearse: presenting.rehearse, audience: !!audienceWin, windowed: presenting.windowed };
};

// macOS egna helskärmsläge (gröna knappen) lägger fönstret i ett eget skrivbord. Lämna det
// först, annars hamnar publikfönstret på ett annat skrivbord än presentatörsvyn.
function leaveNativeFullScreen() {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 1500);
    mainWin.once('leave-full-screen', () => { clearTimeout(t); setTimeout(resolve, 150); });
    mainWin.setFullScreen(false);
  });
}

async function startPresenting({ rehearse = false, windowed, size } = {}) {
  if (!deck.path || !mainWin) return null;
  if (presenting) { layoutPresentation(); return presentInfo(); }
  const nativeFull = mainWin.isFullScreen();
  presenting = {
    rehearse: !!rehearse,
    windowed: typeof windowed === 'boolean' ? windowed : windowedPref(),
    size: validSize(size),
    presenterId: null,
    audienceId: null,
    pendingFile: false,
    blocker: powerSaveBlocker.start('prevent-display-sleep'),
    restore: { bounds: mainWin.getBounds(), maximized: mainWin.isMaximized(), simple: mainWin.isSimpleFullScreen(), fullscreen: nativeFull },
  };
  if (nativeFull) {
    const p = presenting;
    await leaveNativeFullScreen();
    if (presenting !== p || !mainWin) return null; // avslutat under tiden
    p.restore.bounds = mainWin.getBounds();
  }
  layoutPresentation();
  updateMenu();
  return presentInfo();
}

// Byter mellan helskärm och fönsterläge, även mitt i ett bildspel.
let windowedAt = 0;
function setWindowed(on) {
  on = !!on;
  // Byte mitt i ett bildspel byter ut publikfönstret: inte oftare än en gång i sekunden.
  if (presenting && presenting.windowed !== on) {
    if (Date.now() - windowedAt < 1000) return;
    windowedAt = Date.now();
  }
  getPrefs().windowed = on;
  savePrefs();
  if (presenting && presenting.windowed !== on) {
    presenting.windowed = on;
    // En ram kan inte läggas till eller tas bort på ett öppet fönster, så publikfönstret
    // byts ut. Det nya hämtar sliden själv när det är redo (audience-ready).
    if (audienceWin && !audienceWin.isDestroyed()) { const old = audienceWin; audienceWin = null; old.destroy(); }
    if (on && mainWin && mainWin.isSimpleFullScreen()) mainWin.setSimpleFullScreen(false);
    layoutPresentation({ place: true });
  }
  updateMenu();
  pushState();
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
    mainWin.setMinimumSize(900, 600);
    mainWin.setBounds(p.restore.bounds);
    if (p.restore.maximized) mainWin.maximize();
    if (p.restore.fullscreen) mainWin.setFullScreen(true);
    mainWin.focus();
  }
  send(mainWin, 'present-stopped', {});
  updateMenu();
  // En ny version av filen som kom under bildspelet läses in nu.
  if (p.pendingFile && deck.path) setTimeout(() => onFileChanged(deck.path), 200);
}

function syncAudience(state) {
  if (!state) return;
  lastSync = { ...state, url: deck.path ? deckUrl('audience') : null };
  // Slidens proportioner kan ändras när filen läses om: publikfönstret följer med.
  const size = validSize(state.size);
  if (presenting && size && (!presenting.size || presenting.size.w !== size.w || presenting.size.h !== size.h)) {
    presenting.size = size;
    if (presenting.windowed && audienceWin && !audienceWin.isDestroyed()) audienceWin.setAspectRatio(size.w / size.h);
  }
  send(audienceWin, 'sync', lastSync);
}

/* ------------------------------------------------------------ versioner */

async function restoreVersion(id) {
  if (!deck.path) return { error: 'Ingen presentation är öppen.' };
  if (presenting) return { error: 'Avsluta bildspelet först.' };
  let buf;
  try { buf = await versions.read(deck.path, id); } catch (err) { return { error: err.message }; }
  if (!(await confirmDiscard())) return { cancelled: true };
  // Den nuvarande versionen sparas först. Går det inte (t.ex. för stor fil) görs en vanlig
  // säkerhetskopia, och går inte heller det avbryts återställningen.
  const before = await versions.snapshot(deck.path, 'before-restore').catch((err) => ({ error: err }));
  if (before && (before.skipped || before.error)) {
    try { backupFile(BACKUP_DIR, deck.path); }
    catch (err) { return { error: `Den nuvarande filen kunde inte sparas undan först, så inget återställdes: ${err.message}` }; }
  }
  try {
    selfWrite = Date.now();
    fs.writeFileSync(deck.path, buf);
    deck.load(deck.path);
  } catch (err) { return { error: err.message }; }
  snap('restore');
  pushState({ reload: true });
  return { ok: true };
}

async function saveVersionCopy(id) {
  if (!deck.path) return { error: 'Ingen presentation är öppen.' };
  let buf;
  try { buf = await versions.read(deck.path, id); } catch (err) { return { error: err.message }; }
  const ext = path.extname(deck.path);
  const entry = versions.list(deck.path).find((e) => e.id === id);
  const d = new Date(entry ? entry.at : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`; // lokal tid
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Spara versionen som en kopia',
    // Samma mapp som decket, så att bilder och andra filer med relativa sökvägar fungerar.
    defaultPath: path.join(path.dirname(deck.path), `${path.basename(deck.path, ext)} (version ${stamp})${ext}`),
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  if (canceled || !filePath) return { cancelled: true };
  if (path.resolve(filePath) === deck.path) return { error: 'Välj ett annat namn än den öppna filen (använd Återställ för att ersätta den).' };
  try { fs.writeFileSync(filePath, buf); } catch (err) { return { error: err.message }; }
  return { ok: true, path: filePath, name: path.basename(filePath) };
}

/* ------------------------------------------------------- testa utan nät */

function setTestOffline(on) {
  testOffline = !!on;
  fontCache.offline = testOffline;
  setOfflineTest(session.defaultSession, testOffline);
  updateMenu();
  // Publikfönstret laddas också om, så att det visar samma sak som presentatörsvyn.
  if (audienceWin && !audienceWin.isDestroyed()) audienceWin.webContents.reload();
  // Ladda om vyerna så att allt hämtas på nytt (eller misslyckas) som utan nät.
  if (deck.path) pushState({ reload: true });
  else pushState();
}

/* ------------------------------------------------------ text till Claude */

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const slideIdOk = (v) => (typeof v === 'string' && /^[A-Za-z0-9][\w-]{0,63}$/.test(v) ? v : '');
const hpIdsOk = (ids) => Array.isArray(ids) && ids.length > 0 && ids.length <= 5000 && ids.every((x) => typeof x === 'string' && /^\d{1,9}$/.test(x));

function copySlide(o = {}) {
  if (!deck.path) return { error: 'Ingen presentation är öppen.' };
  if (o.rev !== deck.rev) return { error: 'Vänta tills presentationen har laddats om och försök igen.', stale: true };
  if (!hpIdsOk(o.ids) || !Number.isInteger(o.index) || o.index < 0 || o.index >= o.ids.length) return { error: 'Den här sliden kunde inte kopplas till källfilen.' };
  try {
    const html = deck.slideSource(o.ids[o.index]);
    const line = deck.lineOf(o.ids[o.index]);
    const text = slideForClaude({
      index: o.index, count: o.ids.length, title: str(o.title, 300), slideId: slideIdOk(o.slideId),
      file: deck.path, line, dirty: deck.dirty, size: validSize(o.size), notes: str(o.notes, 20000), html, budget: str(o.budget, 40),
    });
    clipboard.writeText(text);
    return { ok: true, line, chars: text.length };
  } catch (err) { return { error: err.message }; }
}

function copyDeck(o = {}) {
  if (!deck.path) return { error: 'Ingen presentation är öppen.' };
  const slides = Array.isArray(o.slides) ? o.slides.slice(0, 5000).map((x) => ({
    title: str(x && x.title, 300), text: str(x && x.text, 4000), notes: str(x && x.notes, 20000),
    slideId: slideIdOk(x && x.slideId), budget: str(x && x.budget, 40),
  })) : [];
  if (!slides.length) return { error: 'Decket har inga slides att kopiera.' };
  const recipe = ['plain', 'qa', 'cut', 'story'].includes(o.recipe) ? o.recipe : 'plain';
  const targetMin = Number.isInteger(o.targetMin) && o.targetMin > 0 && o.targetMin < 600 ? o.targetMin : 20;
  const totalMin = Number.isInteger(o.totalMin) && o.totalMin > 0 ? o.totalMin : null;
  const text = deckForClaude({ file: deck.path, name: deck.name, size: validSize(o.size), slides, recipe, targetMin, totalMin });
  clipboard.writeText(text);
  return { ok: true, chars: text.length, kb: Math.max(1, Math.round(Buffer.byteLength(text) / 1024)) };
}

// Öppnar filen i en kodeditor på raden där elementet börjar (VS Code, Cursor eller Windsurf).
async function openInEditor(id) {
  if (!deck.path) return { error: 'Ingen presentation är öppen.' };
  if (typeof id !== 'string' || !/^\d{1,9}$/.test(id)) return { error: 'Inget element valt.' };
  let line = 1;
  try { line = deck.lineOf(id) || 1; } catch (_) { /* felnästlat element: öppna på rad 1 */ }
  const enc = deck.path.split('/').map(encodeURIComponent).join('/');
  for (const scheme of ['vscode', 'cursor', 'windsurf']) {
    let name = '';
    try { name = app.getApplicationNameForProtocol(`${scheme}://`); } catch (_) {}
    if (name) {
      try { await shell.openExternal(`${scheme}://file${enc}:${line}`); return { ok: true, editor: name.replace(/\.app$/i, ''), line, dirty: deck.dirty }; }
      catch (_) { /* prova nästa */ }
    }
  }
  const err = await shell.openPath(deck.path);
  return err ? { error: err } : { ok: true, editor: 'standardprogrammet', line, dirty: deck.dirty, noLine: true };
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

  handle('present-start', (_e, opts) => { setHpsel(opts && opts.hpsel); return startPresenting(opts || {}); });
  handle('present-stop', () => stopPresenting());
  handle('present-swap', () => swapDisplays());
  handle('present-windowed', (_e, on) => setWindowed(on));
  handle('load-pending', async () => {
    if (presenting && presenting.pendingFile && deck.path) await onFileChanged(deck.path, { force: true });
    return publicState();
  });
  handle('test-offline', (_e, on) => setTestOffline(on));

  // Talets mållängd sparas per fil.
  handle('talk-get', () => {
    const t = deck.path && getPrefs().talks[deck.path];
    return { minutes: t && Number.isInteger(t.minutes) ? t.minutes : null };
  });
  handle('talk-set', (_e, minutes) => {
    if (!deck.path) return null;
    const m = Number.isInteger(minutes) && minutes > 0 && minutes <= 600 ? minutes : null;
    if (m) getPrefs().talks[deck.path] = { minutes: m, at: Date.now() };
    else delete getPrefs().talks[deck.path];
    savePrefs();
    return { minutes: m };
  });

  handle('versions-list', () => (deck.path ? versions.list(deck.path).map(({ id, at, reason, label, size }) => ({ id, at, reason, label, size })) : []));
  handle('version-restore', (_e, id) => restoreVersion(id));
  handle('version-save-copy', (_e, id) => saveVersionCopy(id));

  handle('copy-slide', (_e, o) => copySlide(o));
  handle('copy-deck', (_e, o) => copyDeck(o));
  handle('open-in-editor', (_e, id) => openInEditor(id));
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
  handle('slides-set-ids', (_e, { ids, values, rev }) => slideOp(rev, () => {
    if (!hpIdsOk(ids)) throw new Error('Slidesen kunde inte kopplas till källfilen.');
    if (!deck.setSlideIds(ids, values)) throw new Error('Alla slides har redan ett fast id.');
  }));

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
  fontUse.source.clear();
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
    if (move && readText(deck.path).text !== deck.diskText) throw new Error(`”${deck.name}” har ändrats utanför appen. Läs in den igen (⌘R) och försök sedan.`);
    deck.insertSlides(target.ids, at, chunks.map(unproxyFonts), list.map((i) => imp.info.notes[i] || ''));
    inserted = true;
    let moved = false;
    if (move) {
      // Spara först det här decket, ta sedan bort slidesen ur det andra.
      selfWrite = Date.now();
      deck.save();
      snap('save');
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

// Typsnitt som visades via appen (hpres://…/__fonts/…?u=…) skrivs tillbaka som de riktiga
// Google Fonts-adresserna innan något hamnar i en fil.
function unproxyFonts(html) {
  return String(html).replace(/hpres:\/\/(?:deck|source)\/__fonts\/(?:css|file)\?u=([^"')\s&<>]+)/g, (m, u) => {
    try { const d = decodeURIComponent(u); return /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(d) ? d : m; } catch { return m; }
  });
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
        { label: 'Tidigare versioner…', enabled: open, click: menuAction('versions') },
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
        // Utvecklarverktyg bara när appen körs från källkoden (eller med HP_DEVTOOLS=1).
        ...(DEVTOOLS ? [{ role: 'toggleDevTools', label: 'Utvecklarverktyg' }] : []),
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
        { type: 'separator' },
        { label: 'Kopiera slide för Claude', accelerator: 'Alt+CmdOrCtrl+C', enabled: open, click: menuAction('copy-slide') },
        {
          label: 'Kopiera decket för Claude',
          enabled: open,
          submenu: [
            { label: 'Som text', accelerator: 'Shift+Alt+CmdOrCtrl+C', click: menuAction('copy-deck:plain') },
            { label: 'Med fråga: förbered frågor och svar', click: menuAction('copy-deck:qa') },
            { label: 'Med fråga: korta till målets längd', click: menuAction('copy-deck:cut') },
            { label: 'Med fråga: granska berättelsen', click: menuAction('copy-deck:story') },
          ],
        },
        { label: 'Visa i kodeditor', accelerator: 'Alt+CmdOrCtrl+O', enabled: open, click: menuAction('open-editor') },
        { label: 'Ge slides fasta id', enabled: open, click: menuAction('slide-ids') },
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
        { type: 'separator' },
        { label: 'Fönsterläge – presentatörsvy och publik i egna fönster', type: 'checkbox', checked: presenting ? presenting.windowed : windowedPref(), click: (item) => setWindowed(item.checked) },
        { label: 'Testa utan nät', type: 'checkbox', checked: testOffline, click: (item) => setTestOffline(item.checked) },
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
    else {
      quitting = false;
      // Avbröts en avslutning mitt i ett bildspel hann publikfönstret stängas: öppna det igen.
      if (presenting && !presenting.rehearse && !audienceWin) layoutPresentation();
    }
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
    installPermissionPolicy(session.defaultSession);
    wireIpc();
    updateMenu();
    const f = fileFromArgv(process.argv);
    if (f) pendingOpen = path.resolve(f);
    createMainWindow();

    // I fönsterläge ligger fönstren kvar där du har lagt dem när en skärm kopplas in eller ur.
    const relayout = () => { if (presenting) layoutPresentation({ place: !presenting.windowed }); };
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!mainWin) createMainWindow(); });
}
