// audience.js — publikfönstret: bara sliden, styrd av presentatörsvyn.
import { SlideView } from './slideview.js';
const hp = window.hp;
const view = new SlideView(document.getElementById('stage'), { mode: 'audience', interactive: true });
const cover = document.getElementById('cover');
let loading = null;

const forward = (k) => hp.audienceKey(k);
view.on('key', forward);
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  forward({ key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey });
});

hp.onSync(async (s) => {
  if (!s || !s.url) return;
  if (view.url !== s.url) {
    loading = view.load(s.url, s.index);
    await loading.catch(() => {});
  } else if (loading) {
    await loading.catch(() => {});
  }
  view.show(s.index);
  cover.className = s.ended ? 'ended' : (s.blank || '');
  cover.textContent = s.ended ? 'Slut på bildspelet' : '';
});

// Dölj muspekaren när den inte rörs.
let idle;
const wake = () => { document.body.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => document.body.classList.add('idle'), 1800); };
document.addEventListener('mousemove', wake, true);
wake();

hp.audienceReady();
