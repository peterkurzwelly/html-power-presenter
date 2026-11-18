// forclaude.mjs — text att klistra in hos Claude: en slide med sin källkod, eller hela
// decket som en kort sammanfattning. Inbäddade bilder (base64) tas bort, så att en
// 12 MB-fil inte fyller Claudes minne med bilddata.

// data:…;base64,AAAA… längre än `keep` tecken ersätts med en kort markering.
export function trimDataUris(text, keep = 120) {
  // Blanksteg räknas bara till base64-datan om det följs av en lång rad till (radbruten
  // base64 i CSS), så att attribut efter en adress utan citattecken inte försvinner.
  return String(text).replace(/data:([\w.+-]+\/[\w.+-]+)?((?:;[\w.+-]+=[\w.+-]+)*);base64,([A-Za-z0-9+/]+(?:\s+[A-Za-z0-9+/]{16,})*={0,2})/g, (all, mime = '', params = '', data) => {
    if (data.length <= keep) return all;
    const kb = Math.max(1, Math.round((data.replace(/\s+/g, '').length * 3) / 4 / 1024));
    return `data:${mime}${params};base64,…[${kb} kB borttaget]`;
  });
}

const fence = (body, lang = '') => {
  const ticks = /```/.test(body) ? '````' : '```';
  return `${ticks}${lang}\n${body}\n${ticks}`;
};

const label = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function slideForClaude({ index, count, title, slideId, file, line, dirty, size, notes, html, budget }) {
  const head = [`Slide ${index + 1} av ${count}${title ? ` · ”${label(title)}”` : ''}${slideId ? ` · id: ${slideId}` : ''}`];
  head.push(`Fil: ${file}${line ? ` (rad ${line}${dirty ? ' i appens osparade version – spara filen först, annars stämmer varken raden eller koden med filen' : ''})` : ''}`);
  if (size) head.push(`Slidestorlek: ${size.w}×${size.h}`);
  if (budget) head.push(`Tidsbudget: ${budget}`);
  const parts = [head.join('\n')];
  parts.push(`Anteckningar:\n${notes ? notes : '(inga)'}`);
  parts.push(`HTML:\n${fence(trimDataUris(html).trim(), 'html')}`);
  return parts.join('\n\n') + '\n';
}

export const RECIPES = {
  plain: null,
  qa: 'Här är mitt deck. Förbered de tio svåraste frågorna publiken kan ställa, med korta, ärliga svar som bygger på innehållet.',
  cut: (min) => `Här är mitt deck. Föreslå hur det kan kortas till ${min} minuter: vilka slides kan strykas, slås ihop eller göras valfria, och varför. Använd slidenumren och id:na.`,
  story: 'Här är mitt deck. Granska berättelsen: röd tråd, ordning, upprepningar och vad som saknas. Hänvisa till slidenumren.',
};

export function deckForClaude({ file, name, size, slides, recipe = 'plain', targetMin = 20, totalMin = null }) {
  const out = [];
  const r = RECIPES[recipe];
  if (r) out.push(typeof r === 'function' ? r(targetMin) : r, '');
  out.push(`# ${label(name)}`);
  const meta = [`Fil: ${file}`, `${slides.length} slides`];
  if (size) meta.push(`${size.w}×${size.h}`);
  if (totalMin) meta.push(`planerad tid ≈ ${totalMin} min enligt anteckningarna`);
  out.push(meta.join(' · '), '');
  slides.forEach((s, i) => {
    const bits = [`## ${i + 1}. ${label(s.title) || `Slide ${i + 1}`}`];
    const tags = [];
    if (s.slideId) tags.push(`id: ${s.slideId}`);
    if (s.budget) tags.push(`budget ${s.budget}`);
    if (tags.length) bits[0] += `  (${tags.join(', ')})`;
    const text = String(s.text || '').trim();
    if (text) bits.push(text);
    if (s.notes) bits.push(`> Anteckningar: ${String(s.notes).trim().replace(/\n/g, '\n> ')}`);
    out.push(bits.join('\n\n'), '');
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
