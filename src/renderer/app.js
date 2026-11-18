// app.js — huvudfönstrets UI: startsida, normalvy, rutnät, redigering och presentatörsvy.
import { SlideView } from './slideview.js';
import { cleanInfo, cleanOutline } from './deckinfo.mjs';
import { parseBudget, planFor, pace, clock, roughMinutes, warnAt } from './timing.mjs';

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
  budgets: [],         // sekunder per slide ur anteckningarna ("~1.5 min · …"), eller null
  plan: null,          // planen för hela talet (timing.mjs)
  talkMin: null,       // talets mållängd i minuter (sparas per fil)
  slideEnter: 0,       // timerns tid (s) när du kom till nuvarande slide
  windowed: false,     // fönsterläge: presentatörsvy och publik i egna fönster
  testOffline: false,  // Testa utan nät är på
  versions: null,      // listan i dialogen Tidigare versioner, när den är öppen
};

const ui = {
  start: $('start'), workspace: $('workspace'), presenter: $('presenter'),
  thumbList: $('thumbList'), gridList: $('gridList'), pStrip: $('pStrip'), pGridList: $('pGridList'),
};

const mainView = new SlideView($('stage'), { mode: 'main', interactive: true });
let pCur = null;

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
  updatePrefs(s);
  // Huvudprocessen har redan stängt importen när decket stängs eller byts.
  if (state.imp && (!s.open || (s.reload && s.path !== state.loadedPath))) { state.imp = null; $('importDlg').hidden = true; }
  if (state.versions && (!s.open || s.path !== state.versionsPath)) closeVersions();
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

// Fönsterläge och Testa utan nät gäller oavsett vilken fil som är öppen.
function updatePrefs(s) {
  if (typeof s.windowed === 'boolean') state.windowed = s.windowed;
  if (typeof s.testOffline === 'boolean') state.testOffline = s.testOffline;
  $('windowedBtn').classList.toggle('on', state.windowed);
  $('pWindowed').classList.toggle('on', state.presenting ? !!state.presenting.windowed : state.windowed);
  $('offlineMark').hidden = !state.testOffline;
}

function updateChrome() {
  const d = state.deck;
  if (!d) return;
  renderStatusRight();
  $('docName').textContent = d.name;
  $('docName').parentElement.title = d.path;
  $('dirtyMark').hidden = !d.dirty;
  $('readOnlyMark').hidden = !d.readOnly;
  $('editBtn').disabled = !!d.readOnly;
  $('saveBtn').disabled = !d.dirty;
  $('undoBtn').disabled = !d.canUndo;
  $('redoBtn').disabled = !d.canRedo;
  renderFileChip();
}

// ”Ny version av filen” under bildspelet: följer huvudprocessens pendingFile.
function renderFileChip() {
  $('pFileChip').hidden = !(state.presenting && state.deck && state.deck.pendingFile);
}

// Statusraden till höger: planerad tid enligt anteckningarna, målet och typsnitten.
function renderStatusRight() {
  const bits = [];
  if (state.plan) {
    const known = state.budgets.reduce((t, b) => t + (b > 0 ? b : 0), 0);
    bits.push(state.plan.missing
      ? `${roughMinutes(known)} i anteckningarna för ${state.plan.explicit} av ${count()} slides`
      : `≈ ${roughMinutes(known)} enligt anteckningarna`);
  }
  if (state.talkMin) bits.push(`mål ${state.talkMin} min`);
  const f = state.deck && state.deck.fonts;
  if (f && f.count) bits.push(f.ready === f.count ? 'Google Fonts sparade för visning utan nät ✓' : `Google Fonts: ${f.ready} av ${f.count} sparade – öppna decket med nät en gång`);
  $('statusRight').textContent = bits.join(' · ');
}

// Budgetar och plan ur anteckningarna (och målet, om det finns).
function computePlan() {
  state.budgets = state.info && !state.info.whole ? state.info.notes.map(parseBudget) : [];
  state.plan = planFor(state.budgets, state.talkMin ? state.talkMin * 60 : null);
  renderStatusRight();
}

async function loadDeck(s) {
  const sameFile = state.loadedPath === s.path;
  const pending = sameFile ? state.pending : null;
  state.pending = null;
  const startIndex = pending ? pending.index : sameFile ? state.index : (s.lastIndex || 0);
  const oldInfo = sameFile ? state.info : null;
  const oldIds = oldInfo ? oldInfo.ids.join(',') : null;
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
  if (!sameFile) { const t = await hp.talkGet().catch(() => null); state.talkMin = t && t.minutes ? t.minutes : null; }
  computePlan();
  document.documentElement.style.setProperty('--ratio', String(info.size.w / info.size.h));
  if (pending && pending.thumbs && pending.thumbs.length === info.count) { state.thumbs = pending.thumbs; buildThumbLists(); }
  else if (!sameFile || countChanged || pending || orderChanged) { state.thumbs = []; buildThumbLists(); }
  else refreshTitles();

  // Har filen skrivits om (t.ex. av Claude) hittas sliden igen på sitt fasta id, även om
  // den har flyttats. Annars: samma plats som förut.
  const follow = (idx) => {
    const sid = oldInfo && oldInfo.slideIds && oldInfo.slideIds[idx];
    const j = sid && info.slideIds ? info.slideIds.indexOf(sid) : -1;
    return j >= 0 ? j : idx;
  };
  // Läget kan ha ändrats medan decket laddades (t.ex. när bildspelet avslutades).
  const target = pending ? pending.index : sameFile && state.index >= 0 ? follow(state.index) : startIndex;
  state.index = -1;
  go(clamp(target, 0, info.count - 1));
  if (state.edit) mainView.call('setEdit', true);
  $('statusMid').textContent = info.whole
    ? 'Hittade inga separata slides — visar hela sidan'
    : `${info.count} slides · ${info.size.w}×${info.size.h} · hittade via ${info.strategy}`;
  $('gridInfo').textContent = `${info.count} slides`;

  hp.requestThumbs(state.token, null, state.hpsel);

  if (state.presenting) {
    const run = state.presenting;
    renderFileChip();
    if (!pending && state.pIndex < (oldInfo ? oldInfo.count : 0)) state.pIndex = follow(state.pIndex);
    await loadPresenterViews(true);
    if (state.presenting !== run) return; // bildspelet avslutades medan vyn laddades
    pGo(Math.min(state.pIndex, count()), true);
    // Under bildspelet behövs inte huvudvyns kopia av decket: en levande kopia mindre.
    mainView.unload();
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
  if (state.presenting && t.index === state.pIndex + 1) showNext(t.index);
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

async function restructure(run, pending, message, guard = canRestructure) {
  if (!guard()) return;
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

// Bara aktuell slide visas levande i presentatörsvyn. Nästa slide visas som miniatyrbild,
// så att datorn inte kör ännu en kopia av decket under bildspelet.
async function loadPresenterViews(force) {
  if (!pCur) pCur = new SlideView($('pCurStage'), { mode: 'current', interactive: false });
  if (force || pCur.url !== url('current')) await pCur.load(url('current'), state.pIndex).catch((err) => toast(err.message, 'error'));
}

function showNext(i) {
  const img = $('pNextImg');
  const ph = $('pNextStage');
  if (!state.info || i >= count()) { img.hidden = true; ph.textContent = ''; return; }
  ph.textContent = state.info.titles[i] || `Slide ${i + 1}`;
  const src = state.thumbs[i];
  if (src) { if (img.getAttribute('src') !== src) img.src = src; img.hidden = false; }
  else { img.hidden = true; img.removeAttribute('src'); }
}

async function startPresenting({ from = 0, rehearse = false } = {}) {
  if (!state.info || state.presenting || state.starting) return;
  state.starting = true; // ett dubbelklick startar inte två bildspel
  try {
    await commitPending();
    if (!state.info || state.presenting) return;
    if (state.edit) setEdit(false);
    state.pIndex = clamp(from, 0, count() - 1);
    state.blank = null;
    const res = await hp.presentStart({ rehearse, hpsel: state.hpsel, size: state.info.size });
    if (!res || !state.info || !state.deck) return;
    const run = { rehearse, dual: res.dual, windowed: !!res.windowed };
    state.presenting = run;
    showScreen('presenter');
    renderFileChip();
    // Startar du om bildspelet strax efter att du avslutat det (t.ex. efter en Esc av
    // misstag) fortsätter timern där den var. Inte efter en övning, och inte när du
    // börjar om från första sliden. T nollställer.
    const resume = timer.path === state.deck.path && timer.rehearse === rehearse && timer.acc > 1000
      && Date.now() - timer.stoppedAt < 15 * 60e3 && !(state.pIndex === 0 && timer.lastIndex > 0);
    timer.path = state.deck.path;
    timer.rehearse = rehearse;
    if (resume) { timer.resume(); toast(`Timern fortsätter på ${clock(timer.elapsed() / 1000)} — T nollställer.`); }
    else resetTimer();
    state.slideEnter = timer.elapsed() / 1000;
    markCurrent();
    // Huvudvyns kopia av decket behövs inte under bildspelet. Laddas en ny version just
    // nu gör loadDeck det när den är klar.
    if (!state.loading) mainView.unload();
    await loadPresenterViews(false);
    if (state.presenting !== run) return; // avslutat medan vyn laddades
    pGo(state.pIndex, true);
    updateBanner(res);
    updatePrefs({});
  } finally {
    state.starting = false;
  }
}

// Nollställer timern. Tempot räknas från sliden du står på, inte från första sliden.
function resetTimer() {
  timer.reset();
  state.slideEnter = 0;
  state.paceFrom = state.pIndex;
  renderPace();
}

hp.onPresentLayout((l) => {
  if (!state.presenting) return;
  state.presenting.dual = l.dual;
  state.presenting.windowed = !!l.windowed;
  updatePrefs({});
  updateBanner(l);
});

function updateBanner(l) {
  const b = $('pBanner');
  $('pSwap').hidden = !l.dual;
  if (state.presenting && state.presenting.rehearse) {
    b.textContent = 'Övningsläge — inget publikfönster visas. Esc avslutar.';
  } else if (l.windowed) {
    b.textContent = `Fönsterläge — dela fönstret ”Publik – ${state.deck ? state.deck.name : ''}” i Teams eller Zoom. F byter till helskärm.`;
  } else if (!l.dual) {
    b.textContent = 'Bara en skärm — publiken ligger i helskärm ovanpå. Tryck F för fönsterläge med presentatörsvyn bredvid.';
  } else { b.hidden = true; return; }
  b.hidden = false;
  clearTimeout(updateBanner.t);
  updateBanner.t = setTimeout(() => { b.hidden = true; }, 7000);
}

hp.onPresentStopped(() => exitPresenterUI());

hp.onFilePending(() => { if (state.deck) state.deck.pendingFile = true; renderFileChip(); });
$('pLoadNow').addEventListener('click', async () => { $('pFileChip').hidden = true; await hp.loadPending(); });

function exitPresenterUI() {
  if (!state.presenting) return;
  state.presenting = null;
  timer.lastIndex = state.pIndex;
  timer.freeze();
  togglePGrid(false);
  showTargetPop(false);
  $('pFileChip').hidden = true;
  if (pCur) pCur.unload();
  showScreen(state.deck ? 'workspace' : 'start');
  updatePrefs({});
  restoreMainView(clamp(state.pIndex, 0, count() - 1));
}

// Laddar huvudvyn igen efter bildspelet (den lades ner under tiden).
async function restoreMainView(i) {
  if (!state.deck || !state.info) return;
  state.index = i; // en laddning som redan pågår hamnar då här
  if (state.loading) return;
  // Filen ändrades under bildspelet och huvudvyn har inte hunnit med: ladda allt.
  if (state.deck.rev !== state.infoRev) { await loadDeck(state.deck); return; }
  if (!mainView.ready || mainView.url !== url('main')) {
    state.loading = true;
    let info = null;
    try { info = await mainView.load(url('main'), i); }
    catch (err) {
      state.loading = false;
      $('stageMsg').textContent = 'Kunde inte visa presentationen: ' + err.message;
      $('stageMsg').hidden = false;
      return;
    }
    if (!info) return; // ersatt av en nyare laddning
    state.loading = false;
  }
  const at = state.index;
  state.index = -1;
  go(clamp(at, 0, count() - 1));
  if (state.edit) mainView.call('setEdit', true);
  mainView.relayout();
}

function stopPresenting() { hp.presentStop(); }

function pGo(i, force = false) {
  const n = count();
  i = clamp(i, 0, n); // n = "slut på bildspelet"
  if (i === state.pIndex && !force) return;
  if (i !== state.pIndex) state.slideEnter = timer.elapsed() / 1000;
  state.pIndex = i;
  const ended = i >= n;
  if (pCur) pCur.show(Math.min(i, n - 1));
  showNext(i + 1);
  $('pNextEnd').hidden = i + 1 < n;
  $('pNextEnd').textContent = ended ? '' : 'Slut på bildspelet';
  const notes = ended ? '' : (state.info.notes[i] || '');
  $('pNotes').textContent = notes || (ended ? '' : 'Inga anteckningar.');
  $('pNotes').classList.toggle('empty', !notes);
  renderCount();
  renderPace();
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

// Tid på sliden mot dess budget, och om du ligger före, i fas eller efter planen.
function renderPace() {
  const el = $('pPace');
  const n = count();
  if (!state.presenting || !state.plan || state.pIndex >= n) { el.hidden = true; return; }
  const i = state.pIndex;
  const now = timer.elapsed() / 1000;
  const onSlide = Math.max(0, now - state.slideEnter);
  const budget = state.plan.per[i];
  const explicit = state.budgets[i] > 0;
  // Startade du mitt i decket räknas planen därifrån.
  const from = clamp(state.paceFrom || 0, 0, state.plan.starts.length - 1);
  const p = pace(state.plan, i, now + (state.plan.starts[from] || 0));
  const span = (cls, text) => { const x = document.createElement('span'); x.className = cls; x.textContent = text; return x; };
  el.replaceChildren(
    span(onSlide > budget ? 'long' : '', `Sliden ${clock(onSlide)} / ${explicit ? '' : '≈'}${clock(budget)}`),
    ' · ',
    p.state === 'on' ? span('on', 'i fas') : span(p.state, `${clock(p.delta)} ${p.state === 'ahead' ? 'före' : 'efter'} planen`),
  );
  el.title = explicit ? 'Budget ur anteckningarna' : 'Den här sliden saknar budget i anteckningarna; tiden är uppskattad.';
  el.hidden = false;
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

function toggleWindowed() { hp.presentWindowed(!(state.presenting ? state.presenting.windowed : state.windowed)); }

$('pPrev').addEventListener('click', () => pGo(state.pIndex - 1));
// Knappar i presentatörsvyn behåller inte fokus, så Enter och mellanslag bläddrar
// i stället för att trycka på knappen igen.
$('presenter').addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button');
  if (b && !b.closest('#pTargetPop')) b.blur();
});
$('pNext').addEventListener('click', () => pGo(state.pIndex + 1));
$('pBlack').addEventListener('click', () => setBlank('black'));
$('pWhite').addEventListener('click', () => setBlank('white'));
$('pGridBtn').addEventListener('click', () => togglePGrid());
$('pGridClose').addEventListener('click', () => togglePGrid(false));
$('pSwap').addEventListener('click', () => hp.presentSwap());
$('pEnd').addEventListener('click', stopPresenting);
$('pWindowed').addEventListener('click', toggleWindowed);
$('windowedBtn').addEventListener('click', toggleWindowed);

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

/* ---- timern: förfluten tid, eller tid kvar när talet har ett mål */

let timerMode = 'remaining';
try { timerMode = localStorage.getItem('timerMode') === 'elapsed' ? 'elapsed' : 'remaining'; } catch (_) {}

const timer = {
  acc: 0, start: 0, running: false, iv: null, path: null, stoppedAt: 0,
  elapsed() { return this.acc + (this.running ? Date.now() - this.start : 0); },
  reset() { this.acc = 0; this.start = Date.now(); this.running = true; this.run(); this.render(); },
  resume() { this.start = Date.now(); this.running = true; this.run(); this.render(); },
  toggle() {
    if (this.running) { this.acc += Date.now() - this.start; this.running = false; }
    else { this.start = Date.now(); this.running = true; }
    this.render();
  },
  // När bildspelet avslutas: tiden står still och kan fortsätta om du startar igen strax.
  freeze() {
    if (this.running) { this.acc += Date.now() - this.start; this.running = false; }
    this.stoppedAt = Date.now();
    clearInterval(this.iv); this.iv = null;
  },
  run() { clearInterval(this.iv); this.iv = setInterval(() => this.render(), 500); },
  render() {
    const el = this.elapsed() / 1000;
    const target = state.talkMin ? state.talkMin * 60 : null;
    const t = $('pTimer');
    const rem = target ? target - el : null;
    let main, sub;
    if (target && timerMode === 'remaining') {
      main = rem >= 0 ? clock(rem) : '+' + clock(-rem);
      sub = rem >= 0 ? `kvar av ${state.talkMin} min` : `över ${state.talkMin} min`;
    } else {
      main = clock(el);
      sub = target ? (rem >= 0 ? `${clock(rem)} kvar av ${state.talkMin} min` : `${clock(-rem)} över ${state.talkMin} min`) : 'förfluten tid';
    }
    if (target && rem > 0 && this.running) {
      const end = new Date(Date.now() + rem * 1000);
      sub += ` · slut ${end.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (!this.running) sub = 'pausad · ' + sub;
    t.textContent = main;
    t.classList.toggle('over', !!target && rem < 0);
    t.classList.toggle('warn', !!target && rem >= 0 && rem <= warnAt(target));
    t.classList.toggle('paused', !this.running);
    $('pTimerSub').textContent = sub;
    $('pPause').textContent = this.running ? '⏸' : '▶';
    $('pTargetBtn').textContent = state.talkMin ? `${state.talkMin} min` : 'Mål';
    $('pClock').textContent = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    renderPace();
  },
};
$('pPause').addEventListener('click', () => timer.toggle());
$('pReset').addEventListener('click', () => resetTimer());
$('pTimer').addEventListener('click', () => {
  if (!state.talkMin) { showTargetPop(true); return; }
  timerMode = timerMode === 'remaining' ? 'elapsed' : 'remaining';
  try { localStorage.setItem('timerMode', timerMode); } catch (_) {}
  timer.render();
});

function showTargetPop(show) {
  const pop = $('pTargetPop');
  pop.hidden = !show;
  if (show) { $('pTargetMin').value = state.talkMin || ''; $('pTargetMin').focus(); $('pTargetMin').select(); }
  else if (document.activeElement && pop.contains(document.activeElement)) document.activeElement.blur();
}

async function setTalkMin(minutes) {
  const res = await hp.talkSet(minutes);
  state.talkMin = res && res.minutes ? res.minutes : null;
  computePlan();
  timer.render();
}

$('pTargetBtn').addEventListener('click', () => showTargetPop($('pTargetPop').hidden));
$('pTargetPop').addEventListener('submit', async (e) => {
  e.preventDefault();
  const m = parseInt($('pTargetMin').value, 10);
  showTargetPop(false);
  await setTalkMin(Number.isInteger(m) && m > 0 ? Math.min(600, m) : null);
});
$('pTargetNone').addEventListener('click', async () => { showTargetPop(false); await setTalkMin(null); });

/* ====================================================== tidigare versioner */

async function openVersions() {
  if (!state.deck) return;
  await commitPending();
  const list = await hp.versionsList();
  if (!state.deck) return;
  state.versions = list;
  state.versionsPath = state.deck.path;
  $('verName').textContent = state.deck.name;
  const ol = $('verList');
  ol.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'ver-empty';
    li.textContent = 'Inga sparade versioner ännu.';
    ol.appendChild(li);
  }
  list.forEach((v, k) => {
    const li = document.createElement('li');
    const when = new Date(v.at);
    const a = document.createElement('div');
    const w = document.createElement('div');
    w.className = 'v-when';
    w.textContent = when.toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'medium' });
    const m = document.createElement('div');
    m.className = 'v-meta';
    m.textContent = `${v.label} · ${v.size >= 1048576 ? (v.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(v.size / 1024)) + ' kB'}`;
    a.append(w, m);
    const cur = document.createElement('span');
    cur.className = 'v-cur';
    cur.textContent = k === 0 ? 'senast' : '';
    const copy = document.createElement('button');
    copy.className = 'btn small';
    copy.textContent = 'Spara kopia…';
    copy.addEventListener('click', async () => {
      const r = await hp.versionSaveCopy(v.id);
      if (r && r.error) toast(r.error, 'error');
      else if (r && r.ok) toast(`Sparad som ${r.name}.`);
    });
    const restore = document.createElement('button');
    restore.className = 'btn small primary';
    restore.textContent = 'Återställ';
    restore.addEventListener('click', async () => {
      if (!confirm(`Återställ versionen från ${w.textContent}?\n\nFilen ersätts med den här versionen. Versionen du har nu finns kvar i listan.`)) return;
      const r = await hp.versionRestore(v.id);
      if (r && r.error) { toast(r.error, 'error'); return; }
      if (r && r.ok) { closeVersions(); toast('Versionen är återställd.'); }
    });
    li.append(a, cur, copy, restore);
    ol.appendChild(li);
  });
  $('versionsDlg').hidden = false;
}

function closeVersions() {
  state.versions = null;
  state.versionsPath = null;
  $('versionsDlg').hidden = true;
}
$('verClose').addEventListener('click', closeVersions);

/* ====================================================== text till Claude */

const budgetText = (i) => (state.budgets[i] > 0 ? `~${clock(state.budgets[i])} min` : '');

async function copySlideForClaude() {
  const info = state.info;
  if (!info || info.whole) { toast('Det här decket har inga separata slides.', 'error'); return; }
  await commitPending();
  if (state.loading || !state.deck || state.deck.rev !== state.infoRev) { toast('Vänta tills presentationen har laddats om.', 'error'); return; }
  const i = state.index;
  const res = await hp.copySlide({
    ids: info.ids, index: i, rev: state.infoRev, title: info.titles[i], notes: info.notes[i],
    slideId: info.slideIds[i], size: info.size, budget: budgetText(i),
  });
  if (!res || res.error) { toast((res && res.error) || 'Kunde inte kopiera sliden.', 'error'); return; }
  toast(`Slide ${i + 1} kopierad för Claude${res.line ? ` (rad ${res.line} i filen)` : ''} — klistra in den i Claude.`);
}

async function copyDeckForClaude(recipe) {
  const info = state.info;
  if (info && info.whole) { toast('Det här decket har inga separata slides.', 'error'); return; }
  if (state.presenting) { toast('Avsluta bildspelet först.', 'error'); return; }
  if (!info || !mainView.ready) { toast('Vänta tills presentationen har laddats.', 'error'); return; }
  if (recipe === 'cut' && !state.talkMin) { toast('Sätt ett mål för talet först (Mål i presentatörsvyn), så vet Claude hur kort decket ska bli.', 'error'); return; }
  await commitPending();
  const outline = cleanOutline(await mainView.call('outline').catch(() => null), info.count);
  const slides = info.titles.map((title, i) => ({ title, text: outline[i], notes: info.notes[i], slideId: info.slideIds[i], budget: budgetText(i) }));
  const res = await hp.copyDeck({
    recipe, slides, size: info.size,
    totalMin: state.plan && !state.plan.missing ? Math.max(1, Math.round(state.plan.total / 60)) : null,
    targetMin: state.talkMin,
  });
  if (!res || res.error) { toast((res && res.error) || 'Kunde inte kopiera decket.', 'error'); return; }
  toast(`Decket kopierat för Claude (${res.kb} kB text, utan bilder) — klistra in det i Claude.`);
}

async function openInEditor() {
  const info = state.info;
  if (!info || info.whole) { toast('Det här decket har inga separata slides.', 'error'); return; }
  await commitPending();
  const sel = state.edit && mainView.selection && typeof mainView.selection.id === 'string' ? mainView.selection.id : null;
  const id = sel || info.ids[state.index];
  const res = await hp.openInEditor(id);
  if (!res || res.error) { toast((res && res.error) || 'Kunde inte öppna en kodeditor.', 'error'); return; }
  toast(`Öppnar i ${res.editor}${res.noLine ? '' : ` på rad ${res.line}`}${res.dirty ? ' — spara först, annars stämmer inte raden' : ''}.`);
}

// Fasta id ur slidens rubrik: "Vad kostar det?" → "vad-kostar-det".
function slugify(title, i) {
  const base = String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return !base || /^slide-\d+$/.test(base) ? `slide-${i + 1}` : base;
}

// Id läggs till i varje slides egen starttagg, så slidesen behöver inte ligga i samma
// behållare (som när ordningen ändras).
function canAddIds() {
  const info = state.info;
  if (state.deck && state.deck.readOnly) { toast('Filen är inte sparad som UTF-8 och är därför skrivskyddad.', 'error'); return false; }
  if (state.loading || state.busy || !state.deck || state.deck.rev !== state.infoRev) { toast('Vänta tills presentationen har laddats om.', 'error'); return false; }
  if (!info || info.whole) { toast('Det här decket har inga separata slides.', 'error'); return false; }
  if (!info.ids || info.ids.some((x) => x == null)) { toast('Hittade inte alla slides i källfilen.', 'error'); return false; }
  return true;
}

function assignSlideIds() {
  const info = state.info;
  if (!canAddIds()) return;
  const taken = new Set(info.slideIds.filter(Boolean));
  const ids = [];
  const values = [];
  const seen = new Set(); // klonade slides delar element i källan
  info.slideIds.forEach((sid, i) => {
    if (sid || seen.has(info.ids[i])) return;
    seen.add(info.ids[i]);
    let v = slugify(info.titles[i], i);
    for (let n = 2; taken.has(v); n++) v = `${slugify(info.titles[i], i).slice(0, 36)}-${n}`;
    taken.add(v);
    ids.push(info.ids[i]);
    values.push(v);
  });
  if (!ids.length) { toast('Alla slides har redan fasta id.'); return; }
  restructure((_all, rev) => hp.setSlideIds(ids, values, rev), { index: state.index, thumbs: state.thumbs.slice() },
    `${ids.length} slide${ids.length === 1 ? '' : 's'} fick fasta id (data-slide-id) — spara för att skriva dem till filen. ⌘Z ångrar.`, canAddIds);
}

/* ============================================================== keyboard */

function isTyping() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'INPUT') return !/^(checkbox|radio|range|button|submit|reset|color|file)$/i.test(a.type);
  return a.tagName === 'TEXTAREA' || a.isContentEditable;
}

function handleKey(k) {
  if (state.imp) { if (k.key === 'Escape') closeImport(); return; }
  if (state.versions) { if (k.key === 'Escape') closeVersions(); return; }
  if (k.metaKey || k.ctrlKey) return;
  const key = k.key;

  if (state.presenting) {
    const n = count();
    // Från decket i publikfönstret: bara bläddring, släckning och Esc. Annars kunde ett
    // skript i decket byta fönsterläge eller stoppa klockan.
    if (k.viaDeck && /^[fFsStTgG]$/.test(key)) return;
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
      case 't': case 'T': resetTimer(); return;
      case 's': case 'S': timer.toggle(); return;
      case 'f': case 'F': if (!state.presenting.rehearse) toggleWindowed(); return;
      case 'Escape':
        if (!$('pTargetPop').hidden) { showTargetPop(false); return; }
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
  if (state.versions && e.key === 'Escape') { closeVersions(); return; }
  if (e.key === 'Escape' && !$('pTargetPop').hidden) { showTargetPop(false); return; }
  if (state.versions && !isTyping()) return;
  if (isTyping()) return;
  const nav = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', ' ', 'PageUp', 'PageDown', 'Home', 'End'];
  const inForm = e.target && (e.target.tagName === 'SELECT' || (e.target.closest && e.target.closest('#importDlg, #versionsDlg, #pTargetPop')));
  if (inForm) return;
  if (nav.includes(e.key) && !e.metaKey) e.preventDefault();
  if (e.target && e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) {
    // Under bildspelet bläddrar Enter och mellanslag, även om en knapp har fokus.
    if (!state.presenting) return;
    e.preventDefault();
    e.target.blur();
  }
  handleKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey });
});

mainView.on('key', (k) => { if (k && typeof k.key === 'string') handleKey({ ...k, fromDeck: true }); });

// Klick i sliden når inte appens dokument (den ligger i en iframe), men fönstret
// tappar fokus till iframen. Då räknas sliden som senast klickad.
window.addEventListener('blur', () => { if (document.activeElement === mainView.iframe) state.lastPane = 'stage'; });
hp.onRemoteKey((k) => handleKey(k));

/* ================================================================== menu */

hp.onMenu((a) => {
  if ((state.imp || state.versions) && !['save', 'save-as', 'close', 'toggle-notes'].includes(a)) return;
  if (a.startsWith('copy-deck:')) { if (!state.presenting) copyDeckForClaude(a.slice(10)); return; }
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
    case 'versions': if (!state.presenting) openVersions(); break;
    case 'copy-slide': if (!state.presenting) copySlideForClaude(); break;
    case 'open-editor': if (!state.presenting) openInEditor(); break;
    case 'slide-ids': if (!state.presenting) assignSlideIds(); break;
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
