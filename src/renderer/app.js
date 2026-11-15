// app.js — huvudfönstrets UI: startsida, normalvy, rutnät, redigering och presentatörsvy.
import { SlideView } from './slideview.js';
import { cleanInfo } from './deckinfo.mjs';

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
  pending: null,       // väntad slide och miniatyrer efter att slides flyttats
  imp: null,           // pågående import från ett annat deck
  lastPane: 'stage',   // var du klickade senast: 'sidebar', 'grid' eller 'stage'
  infoRev: -1,         // deckets version när state.info lästes (för slide-ändringar)
  loading: false,      // vyn laddas om just nu
  busy: false,         // en slide-ändring väntar på svar
  hpsel: null,         // slide-regeln som hittade slidesen förra gången (samma fil)
  thumbsSeen: new Set(), // miniatyrer som kommit för nuvarande token
};

const ui = {
  start: $('start'), workspace: $('workspace'), presenter: $('presenter'),
  thumbList: $('thumbList'), gridList: $('gridList'), pStrip: $('pStrip'), pGridList: $('pGridList'),
};

const mainView = new SlideView($('stage'), { mode: 'main', interactive: true });
let pCur = null;
let pNext = null;

const url = (mode) => `${state.deck.baseUrl}?hp=${mode}&rev=${state.deck.rev}${state.hpsel ? '&hpsel=' + encodeURIComponent(state.hpsel) : ''}`;
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
  if (dragFrom !== null) { dragFrom = null; clearDropMarks(); return; }
  if (state.imp) { toast('Stäng dialogen först.', 'error'); return; }
  const file = [...(e.dataTransfer.files || [])].find((f) => /\.html?$/i.test(f.name));
  if (!file) { toast('Släpp en .html-fil.', 'error'); return; }
  hp.openPath(hp.pathForFile(file));
});

/* ============================================================ deck state */

hp.onDeckState(async (s) => {
  state.deck = s.open ? s : null;
  // Huvudprocessen har redan stängt importen när decket stängs eller byts.
  if (state.imp && (!s.open || (s.reload && s.path !== state.loadedPath))) { state.imp = null; $('importDlg').hidden = true; }
  if (!s.open) {
    state.loading = false;
    state.loadedPath = null;
    state.info = null;
    mainView.unload();
    showScreen('start');
    renderRecent();
    return;
  }
  // Spara som… byter filnamn utan att ladda om: det är fortfarande samma deck.
  if (!s.reload && state.loadedPath && s.path !== state.loadedPath) state.loadedPath = s.path;
  updateChrome();
  if (s.reload) await loadDeck(s);
});

function updateChrome() {
  const d = state.deck;
  if (!d) return;
  $('docName').textContent = d.name;
  $('docName').parentElement.title = d.path;
  $('dirtyMark').hidden = !d.dirty;
  $('readOnlyMark').hidden = !d.readOnly;
  $('editBtn').disabled = !!d.readOnly;
  $('saveBtn').disabled = !d.dirty;
  $('undoBtn').disabled = !d.canUndo;
  $('redoBtn').disabled = !d.canRedo;
}

async function loadDeck(s) {
  const sameFile = state.loadedPath === s.path;
  const pending = sameFile ? state.pending : null;
  state.pending = null;
  const startIndex = pending ? pending.index : sameFile ? state.index : (s.lastIndex || 0);
  const oldIds = sameFile && state.info ? state.info.ids.join(',') : null;
  state.loadedPath = s.path;
  state.token += 1;
  state.thumbsSeen = new Set();
  state.loading = true;
  if (!sameFile) { state.thumbs = []; state.hpsel = null; }
  state.selection = null;
  hideSelTools();
  if (!state.presenting) showScreen('workspace');
  $('stageMsg').hidden = true;

  let info;
  try {
    info = await mainView.load(url('main'), startIndex);
  } catch (err) {
    state.loading = false;
    $('stageMsg').textContent = 'Kunde inte visa presentationen: ' + err.message;
    $('stageMsg').hidden = false;
    return;
  }
  if (!info) return; // ersatt av en nyare laddning
  const countChanged = !state.info || state.info.count !== info.count;
  // Samma antal men annan ordning (t.ex. ⌘Z efter en flytt): miniatyrerna stämmer inte.
  const orderChanged = oldIds !== null && info.ids.join(',') !== oldIds;
  state.info = info;
  state.infoRev = s.rev;
  state.loading = false;
  state.hpsel = info.whole ? null : info.strategy;
  document.documentElement.style.setProperty('--ratio', String(info.size.w / info.size.h));
  if (pending && pending.thumbs && pending.thumbs.length === info.count) { state.thumbs = pending.thumbs; buildThumbLists(); }
  else if (!sameFile || countChanged || pending || orderChanged) { state.thumbs = []; buildThumbLists(); }
  else refreshTitles();

  state.index = -1;
  go(clamp(startIndex, 0, info.count - 1));
  if (state.edit) mainView.call('setEdit', true);
  $('statusMid').textContent = info.whole
    ? 'Hittade inga separata slides — visar hela sidan'
    : `${info.count} slides · ${info.size.w}×${info.size.h} · hittade via ${info.strategy}`;
  $('gridInfo').textContent = `${info.count} slides`;

  hp.requestThumbs(state.token, null, state.hpsel);

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
    makeDraggable(li, i, 'y');
    ui.thumbList.appendChild(li);

    // Rutnät
    const g = gridItem(i, () => go(i), () => { go(i); setView('normal'); });
    makeDraggable(g, i, 'x');
    ui.gridList.appendChild(g);
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
  state.thumbsSeen.add(t.index);
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
    // Saknas fortfarande miniatyrer från första genomgången: rendera alla igen,
    // annars skulle den här beställningen avbryta resten.
    const missing = state.thumbsSeen.size < count();
    hp.requestThumbs(state.token, missing ? null : list, state.hpsel);
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
  if (on && state.deck && state.deck.readOnly) { toast('Filen är inte sparad som UTF-8 och är därför skrivskyddad.', 'error'); return; }
  if (on && state.info.whole) { toast('Redigering kräver att decket har separata slides.', 'error'); return; }
  state.edit = !!on;
  $('editBtn').classList.toggle('on', state.edit);
  $('editBar').hidden = !state.edit;
  if (state.edit && state.view !== 'normal') setView('normal');
  mainView.call('setEdit', state.edit);
  if (!state.edit) hideSelTools();
  mainView.focus();
}

$('editBtn').addEventListener('click', () => setEdit(!state.edit));
$('editDone').addEventListener('click', () => setEdit(false));

// När du börjar skriva i en text: går den att spara säkert? (Inte om deckets egna
// skript har ändrat den, t.ex. formler eller kodfärgning.)
// Händelser från decket kan komma från deckets egna skript, så appen godtar bara en
// ändring när du är i redigeringsläge och har börjat redigera just den texten.
let editCheck = null;   // { id, ok: Promise<boolean> } för texten du redigerar
let pendingEdit = Promise.resolve();
mainView.on('editBegin', (d) => {
  if (!state.edit || !d || typeof d.id !== 'string' || typeof d.html !== 'string') { mainView.call('cancelEdit', d && d.id); return; }
  const check = { id: d.id, ok: hp.canEdit(d.id, d.html).then((r) => !!(r && r.ok) || (toast(r ? r.reason : 'Texten kan inte redigeras här.', 'error'), mainView.call('cancelEdit', d.id), false)) };
  editCheck = check;
});

// Skickar en pågående textändring och väntar tills huvudprocessen har tagit emot den.
async function commitPending() {
  if (mainView.ready) await mainView.call('commit');
  await pendingEdit;
}

// Huvudprocessen ber om en pågående textändring innan den stänger eller öppnar något.
hp.onFlush(async (id) => {
  await commitPending().catch(() => {});
  hp.flushed(id);
});

mainView.on('edit', (e) => {
  const check = editCheck;
  if (!e || typeof e.html !== 'string' || typeof e.orig !== 'string' || !check || check.id !== e.id) return;
  editCheck = null;
  // Sliden där ändringen gjordes (du kan hinna byta slide innan den är sparad).
  const slide = Number.isInteger(e.slide) && e.slide >= 0 && e.slide < count() ? e.slide : state.index;
  pendingEdit = (async () => {
    if (!(await check.ok)) return;
    const res = await hp.editInner(e.id, e.html, e.orig);
    if (res && res.error) {
      toast('Ändringen kunde inte sparas: ' + res.error, 'error');
      await reloadAll();
      return;
    }
    queueThumb(slide);
    // Rubriken kan ha ändrats: uppdatera titlar och anteckningar.
    const fresh = await mainView.call('info').catch(() => null);
    if (fresh && state.info) {
      try {
        const c = cleanInfo(fresh);
        if (c.count === state.info.count) { state.info.titles = c.titles; state.info.notes = c.notes; refreshTitles(); }
      } catch (_) { /* behåll de gamla */ }
    }
  })().catch(() => {});
});

mainView.on('select', (s) => {
  state.selection = s;
  if (!s || !state.edit) { hideSelTools(); return; }
  if (document.activeElement && document.activeElement !== mainView.iframe) document.activeElement.blur();
  mainView.focus();
  showSelTools(s);
});

mainView.on('requestDelete', () => { if (state.edit) deleteSelected(); });

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
  if (!mainView.ready || !state.edit) return;
  await commitPending();
  const id = mainView.selection && mainView.selection.id;
  if (!id) return;
  const res = await hp.editRemove(id);
  if (res && res.error) { toast('Kunde inte ta bort: ' + res.error, 'error'); return; }
  mainView.call('removeById', id);
  hideSelTools();
  queueThumb(state.index);
  toast('Borttaget — ⌘Z ångrar.');
}

$('selDelete').addEventListener('click', deleteSelected);
$('selParent').addEventListener('click', () => mainView.call('selectParent'));
$('selEdit').addEventListener('click', () => mainView.call('editSelected'));
$('selTools').addEventListener('mousedown', (e) => e.preventDefault());

// Klick utanför sliden avslutar redigeringen.
$('stageWrap').addEventListener('mousedown', (e) => {
  if (e.target === $('stageWrap') || e.target === $('stage')) mainView.call('deselect');
});
$('sidebar').addEventListener('mousedown', () => { mainView.call('commit'); });

async function undo(redo = false) {
  if (mainView.editing) { mainView.call('execUndo', redo); return; }
  if (redo) await hp.redo(); else await hp.undo();
}

$('undoBtn').addEventListener('click', () => undo(false));
$('redoBtn').addEventListener('click', () => undo(true));
$('saveBtn').addEventListener('click', () => save());

async function save(as = false) {
  await commitPending(); // en pågående textändring skickas före sparningen
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

/* ======================================================== slide order */

// Flytt, duplicering och borttagning sker i källfilen (huvudprocessen). Vyerna laddas
// om efteråt; miniatyrerna flyttas med direkt så att inget blinkar.

function canRestructure() {
  const info = state.info;
  if (state.deck && state.deck.readOnly) { toast('Filen är inte sparad som UTF-8 och är därför skrivskyddad.', 'error'); return false; }
  if (state.loading || state.busy || !state.deck || state.deck.rev !== state.infoRev) { toast('Vänta tills presentationen har laddats om.', 'error'); return false; }
  if (!info || info.whole) { toast('Det här decket har inga separata slides.', 'error'); return false; }
  if (!info.siblings || !info.ids || info.ids.some((x) => x == null)) {
    toast('Slidesen i det här decket ligger inte i samma behållare i källfilen, så ordningen kan inte ändras här.', 'error');
    return false;
  }
  return true;
}

async function restructure(run, pending, message) {
  if (!canRestructure()) return;
  state.busy = true;
  try {
    await commitPending();
    if (state.deck.rev !== state.infoRev) { toast('Vänta tills presentationen har laddats om.', 'error'); return; }
    state.pending = pending;
    const res = await run(state.info.ids, state.infoRev);
    if (res && res.error) { state.pending = null; toast(res.error, 'error'); return; }
    if (message) toast(message);
  } finally {
    state.busy = false;
  }
}

// Flytta slide `from` till insättningsplats `to` (0…antal, räknat före flytten).
function moveSlide(from, to) {
  const n = count();
  if (from < 0 || from >= n) return;
  to = clamp(to, 0, n);
  const dest = to > from ? to - 1 : to;
  if (dest === from) return;
  const order = [...Array(n).keys()];
  order.splice(from, 1);
  order.splice(dest, 0, from);
  const thumbs = order.map((i) => state.thumbs[i]);
  restructure((ids, rev) => hp.reorderSlides(ids, order, rev), { index: dest, thumbs }, `Slide ${from + 1} flyttad till plats ${dest + 1} — ⌘Z ångrar.`);
}

function duplicateSlide(i) {
  if (i < 0 || i >= count()) return;
  const thumbs = state.thumbs.slice();
  thumbs.splice(i + 1, 0, state.thumbs[i]);
  restructure((ids, rev) => hp.duplicateSlide(ids, i, rev), { index: i + 1, thumbs }, `Slide ${i + 1} duplicerad.`);
}

function deleteSlide(i) {
  const n = count();
  if (i < 0 || i >= n) return;
  if (n <= 1) { toast('Ett deck måste ha minst en slide kvar.', 'error'); return; }
  const thumbs = state.thumbs.slice();
  thumbs.splice(i, 1);
  restructure((ids, rev) => hp.removeSlides(ids, [i], rev), { index: Math.min(i, n - 2), thumbs }, `Slide ${i + 1} borttagen — ⌘Z ångrar.`);
}

/* ---- dra och släpp i sidopanelen och rutnätet */

let dragFrom = null;

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'dragging'));
}

function makeDraggable(li, i, axis) {
  li.draggable = true;
  const before = (e) => {
    const r = li.getBoundingClientRect();
    return axis === 'y' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
  };
  li.addEventListener('dragstart', (e) => {
    if (state.presenting) { e.preventDefault(); return; }
    dragFrom = i;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `slide ${i + 1}`);
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => { dragFrom = null; clearDropMarks(); });
  li.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const b = before(e);
    li.parentElement.querySelectorAll('.drop-before, .drop-after').forEach((el) => { if (el !== li) el.classList.remove('drop-before', 'drop-after'); });
    li.classList.toggle('drop-before', b);
    li.classList.toggle('drop-after', !b);
  });
  li.addEventListener('drop', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    e.stopPropagation();
    const from = dragFrom;
    const to = before(e) ? i : i + 1;
    dragFrom = null;
    clearDropMarks();
    moveSlide(from, to);
  });
}

// Var du klickade senast avgör om ⌫ tar bort en slide (sidopanel/rutnät) eller inte.
$('sidebar').addEventListener('mousedown', () => { state.lastPane = 'sidebar'; });
$('gridView').addEventListener('mousedown', () => { state.lastPane = 'grid'; });
$('stageWrap').addEventListener('mousedown', () => { state.lastPane = 'stage'; });

/* ============================================ slides från en annan presentation */

async function openImport() {
  if (!state.info || !canRestructure()) return;
  await commitPending();
  const res = await hp.importPick();
  if (!res) return;
  state.imp = { token: res.token, name: res.name, info: null, thumbs: [], sel: new Set(), anchor: null, at: state.index };
  $('impName').textContent = res.name.replace(/\.html?$/i, '');
  $('impMoveName').textContent = res.name;
  $('impStyles').checked = !!res.suggestKeepStyles;
  $('impStylesHint').textContent = res.suggestKeepStyles
    ? 'Den här presentationen verkar ha en annan design. Med valet på ser sliden ut som i originalet.'
    : 'Samma design som den här presentationen — sliden tar den här presentationens utseende.';
  $('impMove').checked = false;
  $('impWhere').options[0].textContent = `efter slide ${state.index + 1} (aktuell)`;
  $('impWhere').value = 'after';
  $('impGrid').innerHTML = '<li class="imp-wait">Laddar slides…</li>';
  $('impFolderHint').hidden = !!res.sameFolder;
  updateImportButton();
  $('importDlg').hidden = false;
  hideSelTools();
}

function closeImport() {
  if (!state.imp) return;
  state.imp = null;
  $('importDlg').hidden = true;
  hp.importCancel();
}

hp.onImportInfo(({ token, info }) => {
  const imp = state.imp;
  if (!imp || imp.token !== token) return;
  imp.info = info;
  const grid = $('impGrid');
  grid.style.setProperty('--ratio', String(info.size.w / info.size.h));
  grid.innerHTML = '';
  if (info.whole || !info.count) {
    grid.innerHTML = '<li class="imp-wait">Hittade inga separata slides i den filen.</li>';
    return;
  }
  for (let i = 0; i < info.count; i++) {
    const li = document.createElement('li');
    li.dataset.i = i;
    const fig = document.createElement('div');
    fig.className = 'thumb';
    fig.dataset.imp = i;
    fig.innerHTML = '<div class="ph"></div><span class="check">✓</span>';
    fig.querySelector('.ph').textContent = info.titles[i] || `Slide ${i + 1}`;
    if (imp.thumbs[i]) { const img = document.createElement('img'); img.src = imp.thumbs[i]; fig.prepend(img); }
    li.appendChild(fig);
    li.insertAdjacentHTML('beforeend', `<div class="cap"><b>${i + 1}</b><span></span></div>`);
    li.querySelector('.cap span').textContent = info.titles[i] || '';
    li.addEventListener('click', (e) => toggleImportSel(i, e.shiftKey, e.metaKey));
    grid.appendChild(li);
  }
  updateImportButton();
});

hp.onImportThumb((t) => {
  const imp = state.imp;
  if (!imp || t.token !== imp.token) return;
  imp.thumbs[t.index] = t.url;
  const fig = document.querySelector(`#impGrid .thumb[data-imp="${t.index}"]`);
  if (!fig) return;
  let img = fig.querySelector('img');
  if (!img) { img = document.createElement('img'); fig.prepend(img); }
  img.src = t.url;
});

function toggleImportSel(i, range) {
  const imp = state.imp;
  if (!imp) return;
  if (range && imp.anchor !== null) {
    const [a, b] = [Math.min(imp.anchor, i), Math.max(imp.anchor, i)];
    for (let k = a; k <= b; k++) imp.sel.add(k);
  } else {
    if (imp.sel.has(i)) imp.sel.delete(i); else imp.sel.add(i);
    imp.anchor = i;
  }
  document.querySelectorAll('#impGrid li').forEach((li) => li.classList.toggle('sel', imp.sel.has(+li.dataset.i)));
  updateImportButton();
}

function updateImportButton() {
  const n = state.imp ? state.imp.sel.size : 0;
  const move = $('impMove').checked;
  $('impGo').disabled = !n || !(state.imp && state.imp.info);
  $('impGo').textContent = n ? `${move ? 'Flytta' : 'Infoga'} ${n} slide${n === 1 ? '' : 's'}` : 'Välj slides';
}

$('importBtn').addEventListener('click', openImport);
$('impMove').addEventListener('change', updateImportButton);
$('impCancel').addEventListener('click', closeImport);
$('impClose').addEventListener('click', closeImport);
$('impAll').addEventListener('click', () => {
  const imp = state.imp;
  if (!imp || !imp.info) return;
  const all = imp.sel.size === imp.info.count;
  imp.sel = all ? new Set() : new Set([...Array(imp.info.count).keys()]);
  document.querySelectorAll('#impGrid li').forEach((li) => li.classList.toggle('sel', imp.sel.has(+li.dataset.i)));
  updateImportButton();
});

$('impGo').addEventListener('click', async () => {
  const imp = state.imp;
  if (!imp || !imp.info || !imp.sel.size) return;
  const indices = [...imp.sel].sort((a, b) => a - b);
  const move = $('impMove').checked;
  if (move && !confirm(`Flytta ${indices.length} slide${indices.length === 1 ? '' : 's'}?\n\nDen här presentationen sparas och slidesen tas bort ur ”${imp.name}”. Det går inte att ångra med ⌘Z, men säkerhetskopior av båda filerna sparas.`)) return;
  if (state.loading || state.deck.rev !== state.infoRev) { toast('Vänta tills presentationen har laddats om.', 'error'); return; }
  const where = $('impWhere').value;
  const after = where === 'start' ? -1 : where === 'end' ? count() - 1 : clamp(imp.at, 0, count() - 1);
  const info = state.info;
  const thumbs = state.thumbs.slice();
  thumbs.splice(after + 1, 0, ...indices.map((i) => imp.thumbs[i]));
  state.pending = { index: after + 1, thumbs };
  $('impGo').disabled = true;
  $('impGo').textContent = 'Arbetar…';
  const res = await hp.importRun({
    token: imp.token,
    indices,
    after,
    move,
    keepStyles: $('impStyles').checked,
    target: { ids: info.ids, slideTag: info.slideTag, commonClasses: info.commonClasses, strategy: info.strategy, size: info.size, jsonNotes: info.jsonNotes },
    rev: state.infoRev,
  });
  if (!res || res.error) {
    state.pending = null;
    if (res && res.inserted) { state.imp = null; $('importDlg').hidden = true; }
    else updateImportButton();
    toast((res && res.error) || 'Något gick fel.', 'error');
    return;
  }
  state.imp = null;
  $('importDlg').hidden = true;
  const bits = [`${res.moved ? 'Flyttade' : 'Infogade'} ${res.count} slide${res.count === 1 ? '' : 's'} från ${res.from}`];
  if (res.copied.length) bits.push(`kopierade ${res.copied.length} fil${res.copied.length === 1 ? '' : 'er'} till mappen`);
  bits.push(res.moved ? 'kan inte ångras, säkerhetskopior finns' : '⌘Z ångrar');
  toast(bits.join(' · '));
});

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
  await commitPending();
  if (state.edit) setEdit(false);
  state.pIndex = clamp(from, 0, count() - 1);
  state.blank = null;
  const res = await hp.presentStart({ rehearse, hpsel: state.hpsel });
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
  const el = $('pCount');
  const span = (cls, text) => { const x = document.createElement(cls === 'b' ? 'b' : 'span'); if (cls !== 'b') x.className = cls; x.textContent = text; return x; };
  el.replaceChildren();
  if (ended) el.append('Slut ', span('muted', `· ${n} slides`));
  else el.append('Slide ', span('b', String(state.pIndex + 1)), ` av ${n}`);
  if (state.gotoBuf) el.append(span('goto', `Gå till ${state.gotoBuf}…`));
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
  if (!a) return false;
  if (a.tagName === 'INPUT') return !/^(checkbox|radio|range|button|submit|reset|color|file)$/i.test(a.type);
  return a.tagName === 'TEXTAREA' || a.isContentEditable;
}

function handleKey(k) {
  if (state.imp) { if (k.key === 'Escape') closeImport(); return; }
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
      case 'Backspace': case 'Delete': if (!k.fromDeck) deleteSlide(state.index); return;
      default: return;
    }
  }

  switch (key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': go(state.index + 1); return;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': go(state.index - 1); return;
    case 'Home': go(0); return;
    case 'End': go(count() - 1); return;
    case 'Escape': if (state.edit) { if (state.selection) mainView.call('deselect'); else setEdit(false); } return;
    case 'Backspace': case 'Delete':
      if (state.edit && state.selection && state.selection.kind === 'element') deleteSelected();
      // Bara när du senast klickade i sidopanelen, och aldrig för en tangent som
      // kom inifrån sliden (där kan du skriva i decket).
      else if (state.lastPane === 'sidebar' && !k.fromDeck) deleteSlide(state.index);
      return;
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
  if (state.imp && e.key === 'Escape') { closeImport(); return; }
  if (isTyping()) return;
  const nav = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', ' ', 'PageUp', 'PageDown', 'Home', 'End'];
  const inForm = e.target && (e.target.tagName === 'SELECT' || (e.target.closest && e.target.closest('#importDlg')));
  if (inForm) return;
  if (nav.includes(e.key) && !e.metaKey) e.preventDefault();
  if (e.target && e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
  handleKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey });
});

mainView.on('key', (k) => { if (k && typeof k.key === 'string') handleKey({ ...k, fromDeck: true }); });

// Klick i sliden når inte appens dokument (den ligger i en iframe), men fönstret
// tappar fokus till iframen. Då räknas sliden som senast klickad.
window.addEventListener('blur', () => { if (document.activeElement === mainView.iframe) state.lastPane = 'stage'; });
hp.onRemoteKey((k) => handleKey(k));

/* ================================================================== menu */

hp.onMenu((a) => {
  if (state.imp && !['save', 'save-as', 'close', 'toggle-notes'].includes(a)) return;
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
    case 'slide-duplicate': if (!state.presenting) duplicateSlide(state.index); break;
    case 'slide-delete': if (!state.presenting) deleteSlide(state.index); break;
    case 'slide-up': if (!state.presenting) moveSlide(state.index, state.index - 1); break;
    case 'slide-down': if (!state.presenting) moveSlide(state.index, state.index + 2); break;
    case 'slide-first': if (!state.presenting) moveSlide(state.index, 0); break;
    case 'slide-last': if (!state.presenting) moveSlide(state.index, count()); break;
    case 'import': if (!state.presenting) openImport(); break;
    default: break;
  }
});

async function reloadFromDisk() {
  if (!state.deck) return;
  await hp.reloadDeck();
}

/* ================================================================== boot */

(async function boot() {
  const s = await hp.state();
  if (s.open) { state.deck = s; updateChrome(); await loadDeck({ ...s, reload: true }); }
  else { showScreen('start'); renderRecent(); }
})();

window.addEventListener('resize', () => { if (state.selection && state.edit) showSelTools(state.selection); });
