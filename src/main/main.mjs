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
import { DeckStore } from './deckstore.mjs';
import { ThumbRenderer } from './thumbs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = 'hpres';
const ORIGIN = `${SCHEME}://app`;
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

const deck = new DeckStore({ backupDir: path.join(app.getPath('userData'), 'Säkerhetskopior') });
const thumbs = new ThumbRenderer((t) => send(mainWin, 'thumb', t));

/* ------------------------------------------------------------------ helpers */

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function deckBaseUrl(p) {
  return `${ORIGIN}/fs${p.split('/').map(encodeURIComponent).join('/')}`;
}

function deckUrl(mode) {
  return `${deckBaseUrl(deck.path)}?hp=${mode}&rev=${deck.rev}`;
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

function handleProtocol(req) {
  const u = new URL(req.url);
  if (u.host !== 'app') return new Response('Okänd värd', { status: 404 });
  const p = decodeURIComponent(u.pathname);

  if (p.startsWith('/ui/')) {
    const file = path.normalize(path.join(UI_DIR, p.slice(4)));
    if (!isInside(file, UI_DIR)) return new Response('Nej', { status: 403 });
    return serveFile(file, req);
  }

  if (p.startsWith('/fs/')) {
    const abs = path.normalize(p.slice(3));
    // Decket kör sina egna skript. De får bara läsa filer i deckets egen mapp
    // (och undermappar), inte resten av disken.
    if (!deck.path || !isInside(abs, path.dirname(deck.path))) {
      return new Response('Utanför deckets mapp', { status: 403 });
    }
    if (u.searchParams.has('hp') && abs === deck.path) {
      return new Response(deck.servedHtml(CONTROLLER_URL), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return serveFile(abs, req);
  }
  return new Response('Hittades inte', { status: 404 });
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

async function confirmDiscard() {
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
  if (deck.path && deck.path !== p && !(await confirmDiscard())) return null;
  if (presenting) stopPresenting();
  try {
    deck.load(p);
  } catch (err) {
    dialog.showErrorBox('Kunde inte öppna filen', `${p}\n\n${err.message}`);
    return null;
  }
  const entry = touchRecent(p);
  watchFile(p);
  thumbs.cancel();
  return pushState({ reload: true, lastIndex: entry.lastIndex || 0 });
}

function closeDeck() {
  unwatch();
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

function watchFile(p) {
  unwatch();
  try {
    watcher = fs.watch(p, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => onFileChanged(p), 350);
    });
  } catch (err) { console.error('watch', err); }
}

async function onFileChanged(p) {
  if (p !== deck.path || !fs.existsSync(p)) return;
  if (Date.now() - selfWrite < 1500) return;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
  if (text === deck.diskText) return;
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

function displaysFor() {
  const all = screen.getAllDisplays();
  const presenterDisplay = screen.getDisplayMatching(mainWin.getBounds());
  const others = all.filter((d) => d.id !== presenterDisplay.id);
  let audienceDisplay = others[0] || presenterDisplay;
  let pres = presenterDisplay;
  if (presenting && presenting.swapped && others.length) [audienceDisplay, pres] = [pres, audienceDisplay];
  return { all, presenterDisplay: pres, audienceDisplay, dual: others.length > 0 };
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
    swapped: false,
    blocker: powerSaveBlocker.start('prevent-display-sleep'),
    restore: { bounds: mainWin.getBounds(), maximized: mainWin.isMaximized(), simple: mainWin.isSimpleFullScreen() },
  };
  layoutPresentation();
  const { dual } = displaysFor();
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
}

function syncAudience(state) {
  if (!state) return;
  lastSync = { ...state, url: deck.path ? deckUrl('audience') : null };
  send(audienceWin, 'sync', lastSync);
}

/* -------------------------------------------------------------------- IPC */

function wireIpc() {
  ipcMain.handle('open-dialog', () => showOpenDialog());
  ipcMain.handle('open-path', (_e, p) => openDeck(p));
  ipcMain.handle('close-deck', async () => { if (await confirmDiscard()) closeDeck(); });
  ipcMain.handle('recent', () => readRecent());
  ipcMain.handle('forget-recent', (_e, p) => writeRecent(readRecent().filter((r) => r.path !== p)));
  ipcMain.handle('state', () => publicState());
  ipcMain.handle('remember-index', (_e, i) => { if (deck.path) touchRecent(deck.path, { lastIndex: i }); });
  ipcMain.handle('reveal', () => { if (deck.path) shell.showItemInFolder(deck.path); });

  ipcMain.handle('edit-inner', (_e, { id, html }) => {
    try { deck.replaceInner(id, html); return pushState(); }
    catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('edit-remove', (_e, { id }) => {
    try { deck.remove(id); return pushState(); }
    catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('undo', () => { const ok = deck.undo(); return pushState({ reload: ok }); });
  ipcMain.handle('redo', () => { const ok = deck.redo(); return pushState({ reload: ok }); });
  ipcMain.handle('save', () => doSave());
  ipcMain.handle('save-as', () => doSaveAs());

  ipcMain.handle('thumbs', (_e, { token, indices }) => {
    if (!deck.path) return;
    thumbs.render(deckUrl('thumb'), token, indices || null);
  });

  ipcMain.handle('present-start', (_e, opts) => startPresenting(opts));
  ipcMain.handle('present-stop', () => stopPresenting());
  ipcMain.handle('present-swap', () => {
    if (!presenting) return;
    presenting.swapped = !presenting.swapped;
    layoutPresentation();
  });
  ipcMain.on('present-sync', (_e, state) => syncAudience(state));
  ipcMain.on('audience-ready', () => syncAudience(lastSync));
  ipcMain.on('audience-key', (_e, k) => send(mainWin, 'remote-key', k));
  ipcMain.handle('displays', () => {
    const all = screen.getAllDisplays();
    return { count: all.length, fakeDual: FAKE_DUAL };
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
      label: 'Bildspel',
      submenu: [
        { label: 'Presentera från början', accelerator: 'Shift+CmdOrCtrl+Enter', enabled: open, click: menuAction('present-start') },
        { label: 'Presentera från aktuell slide', accelerator: 'CmdOrCtrl+Enter', enabled: open, click: menuAction('present-current') },
        { label: 'Öva med presentatörsvy', accelerator: 'Alt+CmdOrCtrl+Enter', enabled: open, click: menuAction('present-rehearse') },
        { type: 'separator' },
        { label: 'Byt skärmar', enabled: !!presenting, click: () => { if (presenting) { presenting.swapped = !presenting.swapped; layoutPresentation(); } } },
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
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Länkar i decks ska inte ta över appfönstret.
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/ui/`)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  mainWin.on('close', async (e) => {
    if (quitting || !deck.dirty) return;
    e.preventDefault();
    if (await confirmDiscard()) { deck.savedInst = deck.inst; mainWin.close(); }
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

  app.on('before-quit', () => { quitting = !deck.dirty; });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!mainWin) createMainWindow(); });
}
