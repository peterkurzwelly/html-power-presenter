// deckinfo.mjs — kontrollerar det ett deck rapporterar om sig självt (antal slides, storlek,
// titlar…). Används av både appens fönster och huvudprocessen.

// Det decket rapporterar om sig självt kommer från deckets kod och kan vara vad som
// helst. Bara rätt typer släpps igenom; allt annat stoppar laddningen.
const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const strList = (v, n, max) => Array.from({ length: n }, (_, i) => str(Array.isArray(v) ? v[i] : '', max));
export function cleanInfo(info) {
  if (!info || typeof info !== 'object') throw new Error('Decket svarade med något oväntat.');
  const count = info.count;
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error('Decket rapporterade ett ogiltigt antal slides.');
  const w = info.size && info.size.w, h = info.size && info.size.h;
  if (![w, h].every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 50 && x <= 20000)) throw new Error('Decket rapporterade en ogiltig slidestorlek.');
  const whole = !!info.whole;
  const ids = Array.isArray(info.ids) ? info.ids.slice(0, count).map((x) => (typeof x === 'string' && /^\d{1,9}$/.test(x) ? x : null)) : [];
  return {
    count,
    size: { w, h },
    index: Number.isInteger(info.index) ? Math.max(0, Math.min(count - 1, info.index)) : 0,
    strategy: str(info.strategy, 200),
    whole,
    activeClasses: (Array.isArray(info.activeClasses) ? info.activeClasses : []).filter((c) => typeof c === 'string' && /^[\w-]{1,80}$/.test(c)).slice(0, 10),
    title: str(info.title, 300),
    titles: strList(info.titles, count, 300),
    notes: strList(info.notes, whole ? 1 : count, 20000),
    ids: whole ? [] : (ids.length === count ? ids : []),
    siblings: !!info.siblings,
    slideTag: /^[a-z][a-z0-9-]{0,40}$/.test(info.slideTag || '') ? info.slideTag : '',
    commonClasses: (Array.isArray(info.commonClasses) ? info.commonClasses : []).filter((c) => typeof c === 'string' && /^[\w-]{1,80}$/.test(c)).slice(0, 20),
    jsonNotes: !!info.jsonNotes,
    slideIds: Array.from({ length: whole ? 0 : count }, (_, i) => {
      const v = Array.isArray(info.slideIds) ? info.slideIds[i] : '';
      return typeof v === 'string' && /^[A-Za-z0-9][\w-]{0,63}$/.test(v) ? v : '';
    }),
  };
}

// Det decket svarar på 'outline': en kort text per slide.
export function cleanOutline(list, count) {
  return Array.from({ length: count }, (_, i) => (Array.isArray(list) && typeof list[i] === 'string' ? list[i].slice(0, 4000) : ''));
}
