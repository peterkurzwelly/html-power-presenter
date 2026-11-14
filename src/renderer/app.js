// app.js — huvudfönstrets UI: startsida, normalvy, rutnät, redigering och presentatörsvy.
import { SlideView } from './slideview.js';

const $ = (id) => document.getElementById(id);
const hp = window.hp;

const state = {
  deck: null,          // från huvudprocessen: path, name, rev, dirty, canUndo, canRedo, baseUrl
  info: null,          // från kontrollern: count, size, titles, notes, strategy
  loadedPath: null,
  index: 0,
  view: 'normal',      // normal | grid
  edit: false,
  notesOpen: true,
  thumbs: [],
  token: 0,
  presenting: null,    // { rehearse, dual }
  pIndex: 0,           // i presentatörsläget, kan vara === count (slut)
  blank: null,         // 'black' | 'white' | null
  gotoBuf: '',
  selection: null,
};

const ui = {
  start: $('start'), workspace: $('workspace'), presenter: $('presenter'),
  thumbList: $('thumbList'), gridList: $('gridList'), pStrip: $('pStrip'), pGridList: $('pGridList'),
};

const mainView = new SlideView($('stage'), { mode: 'main', interactive: true });
let pCur = null;
let pNext = null;

const url = (mode) => `${state.deck.baseUrl}?hp=${mode}&rev=${state.deck.rev}`;
const count = () => (state.info ? state.info.count : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ================================================================ toast */

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : 2600);
}

/* =============================================================== screens */

function showScreen(name) {
  ui.start.hidden = name !== 'start';
  ui.workspace.hidden = name !== 'workspace';
  ui.presenter.hidden = name !== 'presenter';
}

/* ================================================================= start */

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'nyss';
  if (s < 3600) return `${Math.round(s / 60)} min sedan`;
  if (s < 86400) return `${Math.round(s / 3600)} tim sedan`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'i går' : `${d} dagar sedan`;
}

async function renderRecent() {
  const list = await hp.recent();
  const ul = $('recentList');
  ul.innerHTML = '';
  $('recentEmpty').hidden = list.length > 0;
  list.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="r-name"></span><span class="r-path"></span><span class="r-when"></span><button class="r-x" title="Ta bort från listan">✕</button>';
    li.querySelector('.r-name').textContent = r.name.replace(/\.html?$/i, '');
    li.querySelector('.r-path').innerHTML = '<bdi></bdi>';
    li.querySelector('.r-path bdi').textContent = r.path.replace(/^\/Users\/[^/]+/, '~');
    li.querySelector('.r-when').textContent = timeAgo(r.openedAt);
    li.addEventListener('click', () => hp.openPath(r.path));
    li.querySelector('.r-x').addEventListener('click', async (e) => { e.stopPropagation(); await hp.forgetRecent(r.path); renderRecent(); });
    ul.appendChild(li);
  });
}

$('openBtn').addEventListener('click', () => hp.openDialog());
$('homeBtn').addEventListener('click', () => hp.closeDeck());

// Dra och släpp var som helst i fönstret.
document.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('over'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  const file = [...(e.dataTransfer.files || [])].find((f) => /\.html?$/i.test(f.name));
  if (!file) { toast('Släpp en .html-fil.', 'error'); return; }
  hp.openPath(hp.pathForFile(file));
});

/* ============================================================ deck state */

hp.onDeckState(async (s) => {
  state.deck = s.open ? s : null;
  if (!s.open) {
    state.loadedPath = null;
    state.info = null;
    mainView.unload();
    showScreen('start');
    renderRecent();
    return;
  }
  updateChrome();
  if (s.reload) await loadDeck(s);
});

function updateChrome() {
  const d = state.deck;
  if (!d) return;
  $('docName').textContent = d.name;
  $('docName').parentElement.title = d.path;
  $('dirtyMark').hidden = !d.dirty;
  $('saveBtn').disabled = !d.dirty;
  $('undoBtn').disabled = !d.canUndo;
  $('redoBtn').disabled = !d.canRedo;
}

async function loadDeck(s) {
  const sameFile = state.loadedPath === s.path;
  const startIndex = sameFile ? state.index : (s.lastIndex || 0);
  state.loadedPath = s.path;
  state.token += 1;
  if (!sameFile) { state.thumbs = []; state.selection = null; hideSelTools(); }
  if (!state.presenting) showScreen('workspace');
  $('stageMsg').hidden = true;

  let info;
  try {
    info = await mainView.load(url('main'), startIndex);
  } catch (err) {
    $('stageMsg').textContent = 'Kunde inte visa presentationen: ' + err.message;
    $('stageMsg').hidden = false;
    return;
  }
  if (!info) return; // ersatt av en nyare laddning
  const countChanged = !state.info || state.info.count !== info.count;
  state.info = info;
  document.documentElement.style.setProperty('--ratio', String(info.size.w / info.size.h));
  if (!sameFile || countChanged) { state.thumbs = []; buildThumbLists(); }
  else refreshTitles();

  state.index = -1;
  go(clamp(startIndex, 0, info.count - 1));
  if (state.edit) mainView.api.setEdit(true);
  $('statusMid').textContent = info.whole
    ? 'Hittade inga separata slides — visar hela sidan'
    : `${info.count} slides · ${info.size.w}×${info.size.h} · hittade via ${info.strategy}`;
  $('gridInfo').textContent = `${info.count} slides`;

  hp.requestThumbs(state.token, null);

  if (state.presenting) {
    await loadPresenterViews(true);
    pGo(Math.min(state.pIndex, count()), true);
  }
}

/* ============================================================ thumbnails */

function thumbFigure(i) {
  const fig = document.createElement('div');
  fig.className = 'thumb';
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.textContent = state.info.titles[i] || `Slide ${i + 1}`;
  if (state.thumbs[i]) {
    const img = document.createElement('img');
    img.src = state.thumbs[i];
    img.dataset.thumb = i;
    fig.appendChild(img);
  }
  fig.appendChild(ph);
  fig.dataset.fig = i;
  return fig;
}

function buildThumbLists() {
  const n = count();
  ui.thumbList.innerHTML = '';
  ui.gridList.innerHTML = '';
  ui.pStrip.innerHTML = '';
  ui.pGridList.innerHTML = '';
  for (let i = 0; i < n; i++) {
    // Sidopanel
    const li = document.createElement('li');
    li.dataset.i = i;
    li.innerHTML = `<span class="num">${i + 1}</span>`;
    li.appendChild(thumbFigure(i));
    li.addEventListener('click', () => go(i));
    li.addEventListener('dblclick', () => startPresenting({ from: i }));
    ui.thumbList.appendChild(li);

    // Rutnät
    ui.gridList.appendChild(gridItem(i, () => go(i), () => { go(i); setView('normal'); }));
    // Presentatörens remsa och rutnät
    const s = document.createElement('li');
    s.dataset.i = i;
    s.appendChild(thumbFigure(i));
    s.insertAdjacentHTML('beforeend', `<span class="n">${i + 1}</span>`);
    s.addEventListener('click', () => pGo(i));
    ui.pStrip.appendChild(s);
    ui.pGridList.appendChild(gridItem(i, () => { pGo(i); togglePGrid(false); }));
  }
  markCurrent();
}

function gridItem(i, onClick, onDbl) {
  const li = document.createElement('li');
  li.dataset.i = i;
  li.appendChild(thumbFigure(i));
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${i + 1}</b><span></span>`;
  cap.querySelector('span').textContent = state.info.titles[i] || '';
  li.appendChild(cap);
  li.addEventListener('click', onClick);
  if (onDbl) li.addEventListener('dblclick', onDbl);
  return li;
}

function refreshTitles() {
  document.querySelectorAll('.thumb .ph').forEach((ph) => {
    const i = +ph.parentElement.dataset.fig;
    ph.textContent = state.info.titles[i] || `Slide ${i + 1}`;
  });
  document.querySelectorAll('.grid-list li').forEach((li) => {
    const span = li.querySelector('.cap span');
    if (span) span.textContent = state.info.titles[+li.dataset.i] || '';
  });
}

hp.onThumb((t) => {
  if (t.token !== state.token) return;
  state.thumbs[t.index] = t.url;
  document.querySelectorAll(`.thumb[data-fig="${t.index}"]`).forEach((fig) => {
    let img = fig.querySelector('img');
    if (!img) { img = document.createElement('img'); fig.prepend(img); }
    img.src = t.url;
  });
});

let thumbQueue = new Set();
let thumbTimer = null;
function queueThumb(i) {
  thumbQueue.add(i);
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const list = [...thumbQueue];
    thumbQueue = new Set();
    hp.requestThumbs(state.token, list);
  }, 500);
}

function markCurrent() {
  const i = state.presenting ? Math.min(state.pIndex, count() - 1) : state.index;
  for (const list of [ui.thumbList, ui.gridList, ui.pStrip, ui.pGridList]) {
    const old = list.querySelector('li.cur');
    if (old) old.classList.remove('cur');
    const cur = list.children[i];
    if (cur) {
      cur.classList.add('cur');
      if (list.offsetParent) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

/* ============================================================ normal view */

let rememberTimer = null;
function go(i) {
  if (!state.info) return;
  i = clamp(i, 0, count() - 1);
  if (i === state.index) return;
  state.index = i;
  hideSelTools();
  mainView.show(i);
  markCurrent();
  const notes = state.info.notes[i] || '';
  $('notesTitle').textContent = `Anteckningar · slide ${i + 1}`;
  $('notesText').textContent = notes || 'Inga anteckningar för den här sliden.';
  $('notesText').classList.toggle('empty', !notes);
  $('statusLeft').textContent = `Slide ${i + 1} av ${count()}`;
  clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => hp.rememberIndex(state.index), 600);
}

function setView(v) {
  if (v === state.view || !state.info) return;
  state.view = v;
  if (v === 'grid' && state.edit) setEdit(false);
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('normalView').hidden = v !== 'normal';
  $('gridView').hidden = v !== 'grid';
  $('sidebar').hidden = v === 'grid';
  hideSelTools();
  requestAnimationFrame(markCurrent);
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('gridSize').addEventListener('input', (e) => ui.gridList.style.setProperty('--tw', e.target.value + 'px'));
try { const gs = localStorage.getItem('gridSize'); if (gs) { $('gridSize').value = gs; ui.gridList.style.setProperty('--tw', gs + 'px'); } } catch (_) {}
$('gridSize').addEventListener('change', (e) => { try { localStorage.setItem('gridSize', e.target.value); } catch (_) {} });

function toggleNotes() {
  state.notesOpen = !state.notesOpen;
  $('notesPane').classList.toggle('collapsed', !state.notesOpen);
}

/* ================================================================ editing */

function setEdit(on) {
  if (!state.info) return;
  if (on && state.info.whole) { toast('Redigering kräver att decket har separata slides.', 'error'); return; }
  state.edit = !!on;
  $('editBtn').classList.toggle('on', state.edit);
  $('editBar').hidden = !state.edit;
  if (state.edit && state.view !== 'normal') setView('normal');
  if (mainView.api) mainView.api.setEdit(state.edit);
  if (!state.edit) hideSelTools();
  mainView.focus();
}

$('editBtn').addEventListener('click', () => setEdit(!state.edit));
$('editDone').addEventListener('click', () => setEdit(false));

mainView.on('edit', async (e) => {
  const res = await hp.editInner(e.id, e.html);
  if (res && res.error) {
    toast('Ändringen kunde inte sparas: ' + res.error, 'error');
    await reloadAll();
    return;
  }
  queueThumb(e.slide);
});

mainView.on('select', (s) => {
  state.selection = s;
  if (!s || !state.edit) { hideSelTools(); return; }
  if (document.activeElement && document.activeElement !== mainView.iframe) document.activeElement.blur();
  mainView.focus();
  showSelTools(s);
});

mainView.on('requestDelete', () => deleteSelected());

function showSelTools(s) {
  const box = $('selTools');
  $('selLabel').textContent = s.kind === 'text' ? 'Redigerar ' + s.label : s.label + (s.text ? ` · ”${s.text}”` : '');
  $('selEdit').hidden = s.kind === 'text' || !s.editable;
  $('selParent').hidden = !s.canParent;
  $('selDelete').textContent = s.kind === 'text' ? 'Ta bort hela texten' : 'Ta bort';
  box.hidden = false;
  const r = mainView.toHost(s.rect);
  const wrap = $('stageWrap').getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let top = r.top - bh - 10;
  if (top < wrap.top + 4) top = Math.min(r.top + r.height + 10, wrap.bottom - bh - 4);
  let left = clamp(r.left, wrap.left + 4, wrap.right - bw - 4);
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}

function hideSelTools() { $('selTools').hidden = true; }

async function deleteSelected() {
  if (!mainView.api) return;
  mainView.api.commit();
  const id = mainView.api.selectedId();
  if (!id) return;
  const res = await hp.editRemove(id);
  if (res && res.error) { toast('Kunde inte ta bort: ' + res.error, 'error'); return; }
  mainView.api.removeById(id);
  hideSelTools();
  queueThumb(state.index);
  toast('Borttaget — ⌘Z ångrar.');
}

$('selDelete').addEventListener('click', deleteSelected);
$('selParent').addEventListener('click', () => mainView.api && mainView.api.selectParent());
$('selEdit').addEventListener('click', () => mainView.api && mainView.api.editSelected());
$('selTools').addEventListener('mousedown', (e) => e.preventDefault());

// Klick utanför sliden avslutar redigeringen.
$('stageWrap').addEventListener('mousedown', (e) => {
  if (e.target === $('stageWrap') || e.target === $('stage')) { if (mainView.api) mainView.api.deselect(); }
});
$('sidebar').addEventListener('mousedown', () => { if (mainView.api) mainView.api.commit(); });

async function undo(redo = false) {
  if (mainView.api && mainView.api.editing) { mainView.api.execUndo(redo); return; }
  if (redo) await hp.redo(); else await hp.undo();
}

$('undoBtn').addEventListener('click', () => undo(false));
$('redoBtn').addEventListener('click', () => undo(true));
$('saveBtn').addEventListener('click', () => save());

async function save(as = false) {
  if (mainView.api) mainView.api.commit();
  await new Promise((r) => setTimeout(r, 30)); // låt en pågående ändring hinna fram
  const ok = as ? await hp.saveAs() : await hp.save();
  if (ok) toast('Sparat ✓');
}

async function reloadAll() {
  if (!state.deck) return;
  const s = await hp.state();
  state.deck = s;
  updateChrome();
  await loadDeck(s);
}

/* ============================================================ presenting */

$('presentBtn').addEventListener('click', (e) => startPresenting({ from: e.shiftKey ? 0 : state.index }));
$('rehearseBtn').addEventListener('click', () => startPresenting({ from: state.index, rehearse: true }));

async function loadPresenterViews(force) {
  if (!pCur) {
    pCur = new SlideView($('pCurStage'), { mode: 'current', interactive: false });
    pNext = new SlideView($('pNextStage'), { mode: 'next', interactive: false });
  }
  const tasks = [];
  if (force || pCur.url !== url('current')) tasks.push(pCur.load(url('current'), state.pIndex));
  if (force || pNext.url !== url('next')) tasks.push(pNext.load(url('next'), state.pIndex + 1));
  await Promise.all(tasks).catch((err) => toast(err.message, 'error'));
}

async function startPresenting({ from = 0, rehearse = false } = {}) {
  if (!state.info) return;
  if (state.edit) setEdit(false);
  if (mainView.api) mainView.api.commit();
  state.pIndex = clamp(from, 0, count() - 1);
  state.blank = null;
  const res = await hp.presentStart({ rehearse });
  if (!res) return;
  state.presenting = { rehearse, dual: res.dual };
  showScreen('presenter');
  timer.reset();
  markCurrent();
  await loadPresenterViews(false);
  pGo(state.pIndex, true);
  updateBanner(res);
}

hp.onPresentLayout((l) => {
  if (!state.presenting) return;
  state.presenting.dual = l.dual;
  updateBanner(l);
});

function updateBanner(l) {
  const b = $('pBanner');
  $('pSwap').hidden = !l.dual;
  if (l.fake) {
    b.textContent = 'Testläge — publikfönstret visas som ett vanligt fönster.';
    b.hidden = false;
  } else if (state.presenting && state.presenting.rehearse) {
    b.textContent = 'Övningsläge — inget publikfönster visas. Esc avslutar.';
    b.hidden = false;
  } else if (!l.dual) {
    b.textContent = 'Bara en skärm hittades — publikfönstret ligger i helskärm ovanpå. Anslut en skärm så flyttas det dit.';
    b.hidden = false;
  } else b.hidden = true;
  clearTimeout(updateBanner.t);
  updateBanner.t = setTimeout(() => { b.hidden = true; }, 6000);
}

hp.onPresentStopped(() => exitPresenterUI());

function exitPresenterUI() {
  if (!state.presenting) return;
  state.presenting = null;
  timer.stop();
  togglePGrid(false);
  if (pCur) { pCur.unload(); pNext.unload(); }
  showScreen(state.deck ? 'workspace' : 'start');
  const target = clamp(state.pIndex, 0, count() - 1);
  state.index = -1;
  go(target);
  mainView.relayout();
}

function stopPresenting() { hp.presentStop(); }

function pGo(i, force = false) {
  const n = count();
  i = clamp(i, 0, n); // n = "slut på bildspelet"
  if (i === state.pIndex && !force) return;
  state.pIndex = i;
  const ended = i >= n;
  if (pCur) pCur.show(Math.min(i, n - 1));
  if (pNext) { if (i + 1 < n) pNext.show(i + 1); }
  $('pNextEnd').hidden = i + 1 < n;
  $('pNextEnd').textContent = ended ? '' : 'Slut på bildspelet';
  const notes = ended ? '' : (state.info.notes[i] || '');
  $('pNotes').textContent = notes || (ended ? '' : 'Inga anteckningar.');
  $('pNotes').classList.toggle('empty', !notes);
  renderCount();
  renderOverlay();
  markCurrent();
  sync();
}

function renderCount() {
  const n = count();
  const ended = state.pIndex >= n;
  const goto = state.gotoBuf ? `<span class="goto">Gå till ${state.gotoBuf}…</span>` : '';
  $('pCount').innerHTML = ended ? `Slut <span class="muted">· ${n} slides</span>${goto}` : `Slide <b>${state.pIndex + 1}</b> av ${n}${goto}`;
}

function renderOverlay() {
  const o = $('pCurOverlay');
  const ended = state.pIndex >= count();
  o.className = 'p-overlay' + (state.blank === 'white' ? ' white' : '');
  if (ended) { o.textContent = 'Slut på bildspelet — Esc avslutar'; o.hidden = false; }
  else if (state.blank) { o.textContent = state.blank === 'black' ? 'Publiken ser en svart skärm (B)' : 'Publiken ser en vit skärm (W)'; o.hidden = false; }
  else o.hidden = true;
  $('pBlack').classList.toggle('on', state.blank === 'black');
  $('pWhite').classList.toggle('on', state.blank === 'white');
}

function sync() {
  if (!state.presenting) return;
  const n = count();
  hp.presentSync({ index: Math.min(state.pIndex, n - 1), ended: state.pIndex >= n, blank: state.blank, size: state.info.size });
}

function setBlank(kind) {
  state.blank = state.blank === kind ? null : kind;
  renderOverlay();
  sync();
}

function togglePGrid(force) {
  const el = $('pGridOverlay');
  const show = force === undefined ? el.hidden : force;
  el.hidden = !show;
  if (show) requestAnimationFrame(markCurrent);
}

$('pPrev').addEventListener('click', () => pGo(state.pIndex - 1));
$('pNext').addEventListener('click', () => pGo(state.pIndex + 1));
$('pBlack').addEventListener('click', () => setBlank('black'));
$('pWhite').addEventListener('click', () => setBlank('white'));
$('pGridBtn').addEventListener('click', () => togglePGrid());
$('pGridClose').addEventListener('click', () => togglePGrid(false));
$('pSwap').addEventListener('click', () => hp.presentSwap());
$('pEnd').addEventListener('click', stopPresenting);

let notesSize = 20;
try { notesSize = +(localStorage.getItem('notesSize') || 20); } catch (_) {}
function setNotesSize(v) {
  notesSize = clamp(v, 12, 48);
  $('pNotes').style.setProperty('--nf', notesSize + 'px');
  try { localStorage.setItem('notesSize', notesSize); } catch (_) {}
}
setNotesSize(notesSize);
$('pFontUp').addEventListener('click', () => setNotesSize(notesSize + 2));
$('pFontDown').addEventListener('click', () => setNotesSize(notesSize - 2));

const timer = {
  start: 0, acc: 0, paused: false, iv: null,
  reset() { this.acc = 0; this.start = Date.now(); this.paused = false; this.run(); this.render(); },
  stop() { clearInterval(this.iv); this.iv = null; },
  toggle() {
    if (this.paused) { this.start = Date.now(); this.paused = false; }
    else { this.acc += Date.now() - this.start; this.paused = true; }
    this.render();
  },
  elapsed() { return this.acc + (this.paused ? 0 : Date.now() - this.start); },
  run() { this.stop(); this.iv = setInterval(() => this.render(), 500); },
  render() {
    const s = Math.floor(this.elapsed() / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    $('pTimer').textContent = (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0');
    $('pTimer').classList.toggle('paused', this.paused);
    $('pPause').textContent = this.paused ? '▶' : '⏸';
    const now = new Date();
    $('pClock').textContent = now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  },
};
$('pPause').addEventListener('click', () => timer.toggle());
$('pReset').addEventListener('click', () => timer.reset());

/* ============================================================== keyboard */

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}

function handleKey(k) {
  if (k.metaKey || k.ctrlKey) return;
  const key = k.key;

  if (state.presenting) {
    const n = count();
    if (/^[0-9]$/.test(key)) { state.gotoBuf = (state.gotoBuf + key).slice(-3); renderCount(); clearTimeout(handleKey.t); handleKey.t = setTimeout(() => { state.gotoBuf = ''; renderCount(); }, 2500); return; }
    if (key === 'Enter' && state.gotoBuf) { const t = parseInt(state.gotoBuf, 10) - 1; state.gotoBuf = ''; pGo(clamp(t, 0, n - 1)); return; }
    switch (key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter': case 'n': case 'N':
        if (state.blank) { state.blank = null; renderOverlay(); sync(); return; }
        pGo(state.pIndex + 1); return;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': case 'p': case 'P':
        if (state.blank) { state.blank = null; renderOverlay(); sync(); return; }
        pGo(state.pIndex - 1); return;
      case 'Home': pGo(0); return;
      case 'End': pGo(n - 1); return;
      case 'b': case 'B': case '.': setBlank('black'); return;
      case 'w': case 'W': case ',': setBlank('white'); return;
      case 'g': case 'G': togglePGrid(); return;
      case 't': case 'T': timer.reset(); return;
      case 'Escape':
        if (!$('pGridOverlay').hidden) { togglePGrid(false); return; }
        stopPresenting(); return;
      default: return;
    }
  }

  if (!state.info || ui.workspace.hidden) return;

  if (state.view === 'grid') {
    const cols = gridCols();
    switch (key) {
      case 'ArrowRight': go(state.index + 1); return;
      case 'ArrowLeft': go(state.index - 1); return;
      case 'ArrowDown': go(state.index + cols); return;
      case 'ArrowUp': go(state.index - cols); return;
      case 'Home': go(0); return;
      case 'End': go(count() - 1); return;
      case 'Enter': setView('normal'); return;
      case 'Escape': setView('normal'); return;
      default: return;
    }
  }

  switch (key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': go(state.index + 1); return;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': go(state.index - 1); return;
    case 'Home': go(0); return;
    case 'End': go(count() - 1); return;
    case 'Escape': if (state.edit) { if (state.selection) mainView.api.deselect(); else setEdit(false); } return;
    case 'Backspace': case 'Delete': if (state.edit && state.selection && state.selection.kind === 'element') deleteSelected(); return;
    default: return;
  }
}

function gridCols() {
  const items = ui.gridList.children;
  if (items.length < 2) return 1;
  const top = items[0].offsetTop;
  let c = 0;
  for (const it of items) { if (it.offsetTop !== top) break; c++; }
  return Math.max(1, c);
}

document.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  const nav = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', ' ', 'PageUp', 'PageDown', 'Home', 'End'];
  if (nav.includes(e.key) && !e.metaKey) e.preventDefault();
  if (e.target && e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
  handleKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey });
});

mainView.on('key', (k) => handleKey(k));
hp.onRemoteKey((k) => handleKey(k));

/* ================================================================== menu */

hp.onMenu((a) => {
  switch (a) {
    case 'save': save(false); break;
    case 'save-as': save(true); break;
    case 'reload': reloadFromDisk(); break;
    case 'close': if (state.presenting) stopPresenting(); else hp.closeDeck(); break;
    case 'undo': undo(false); break;
    case 'redo': undo(true); break;
    case 'toggle-edit': if (!state.presenting) setEdit(!state.edit); break;
    case 'view-normal': if (!state.presenting) setView('normal'); break;
    case 'view-grid': if (!state.presenting) setView('grid'); break;
    case 'toggle-notes': toggleNotes(); break;
    case 'present-start': if (!state.presenting) startPresenting({ from: 0 }); break;
    case 'present-current': if (!state.presenting) startPresenting({ from: state.index }); break;
    case 'present-rehearse': if (!state.presenting) startPresenting({ from: state.index, rehearse: true }); break;
    default: break;
  }
});

async function reloadFromDisk() {
  if (!state.deck) return;
  if (state.deck.dirty && !confirm('Läsa in filen från disk igen? Osparade ändringar försvinner.')) return;
  await hp.openPath(state.deck.path);
}

/* ================================================================== boot */

(async function boot() {
  const s = await hp.state();
  if (s.open) { state.deck = s; updateChrome(); await loadDeck({ ...s, reload: true }); }
  else { showScreen('start'); renderRecent(); }
})();

window.addEventListener('resize', () => { if (state.selection && state.edit) showSelTools(state.selection); });
