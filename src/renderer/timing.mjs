// timing.mjs — tidsbudgetar ur anteckningarna och tempot under en presentation.
//
// Många decks börjar varje slides anteckningar med en budget, t.ex. "~1.5 min · …"
// eller "~45 s — …". Här läses den ut, och en plan räknas fram för hela talet.
// Inga beroenden: används av appens fönster och av enhetstesterna.

const UNIT = { minuter: 60, minutes: 60, minute: 60, mins: 60, min: 60, m: 60, sekunder: 1, seconds: 1, sek: 1, sec: 1, s: 1 };
const NUM = '(\\d+(?:[.,]\\d+)?)';
const UNITS = '(minuter|minutes|minute|mins|min|m|sekunder|seconds|sek|sec|s)';
// Med ~, ≈ eller "ca" först räcker det att enheten inte följs av en bokstav.
// "1 min 30 s" och "1m30s": sekunderna efter minuterna räknas med.
const SECS = '(?:\\s*(\\d+)\\s*(?:sekunder|seconds|sek|sec|s)(?![\\p{L}]))?';
const LOOSE = new RegExp(`^\\s*(?:~|≈|ca\\.?)\\s*${NUM}(?:\\s*[–-]\\s*${NUM})?\\s*${UNITS}(?![\\p{L}])${SECS}`, 'iu');
// Utan det måste budgeten stå för sig själv: följd av ·, |, —, –, :, en radbrytning eller slutet.
const STRICT = new RegExp(`^\\s*${NUM}(?:\\s*[–-]\\s*${NUM})?\\s*${UNITS}(?![\\p{L}])${SECS}\\s*(?:[·|—–:]|\\n|$)`, 'iu');

const num = (s) => parseFloat(String(s).replace(',', '.'));

// Sekunder, eller null om anteckningen inte börjar med en budget.
export function parseBudget(note) {
  if (typeof note !== 'string' || !note) return null;
  const m = LOOSE.exec(note) || STRICT.exec(note);
  if (!m) return null;
  const a = num(m[1]);
  const b = m[2] ? num(m[2]) : a;
  const unit = UNIT[m[3].toLowerCase()];
  const extra = m[4] && unit === 60 ? parseInt(m[4], 10) : 0;
  const sec = Math.round(((a + b) / 2) * unit + extra);
  return sec > 0 && sec <= 3600 ? sec : null;
}

// En plan för hela talet. Slides utan budget får en jämn del av det som är kvar av
// målet, eller (utan mål) snittet av de budgetar som finns. null = inga budgetar alls.
export function planFor(budgets, targetSec = null) {
  if (!Array.isArray(budgets) || !budgets.length) return null;
  const known = budgets.filter((b) => b > 0);
  if (!known.length) return null;
  const sumKnown = known.reduce((a, b) => a + b, 0);
  const missing = budgets.length - known.length;
  let fill = 0;
  // Med ett mål som redan är förbrukat av budgetarna får de övriga ingen tid alls, så att
  // planen aldrig blir längre än målet.
  if (missing) fill = targetSec ? Math.max(0, targetSec - sumKnown) / missing : sumKnown / known.length;
  const per = budgets.map((b) => (b > 0 ? b : fill));
  const starts = [];
  let t = 0;
  for (const p of per) { starts.push(t); t += p; }
  return { per, starts, total: t, explicit: known.length, missing };
}

// Ligger du före, i fas eller efter planen när du har pratat `elapsed` sekunder på slide `index`?
// I fas betyder att tiden ligger inom den här slidens del av planen (med lite marginal).
export function pace(plan, index, elapsed, slack = 5) {
  if (!plan) return null;
  const i = Math.max(0, Math.min(plan.per.length - 1, index));
  const start = plan.starts[i];
  const end = start + plan.per[i];
  if (elapsed < start - slack) return { state: 'ahead', delta: start - elapsed };
  if (elapsed > end + slack) return { state: 'behind', delta: elapsed - end };
  return { state: 'on', delta: 0 };
}

// 75 → "1:15", 3725 → "1:02:05". Negativa tal får minustecken.
export function clock(sec) {
  const neg = sec < 0;
  let s = Math.floor(Math.abs(sec));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return (neg ? '−' : '') + body;
}

// "≈ 24 min" för statusraden.
export function roughMinutes(sec) {
  if (sec < 60) return `${Math.round(sec)} s`;
  return `${Math.round(sec / 60)} min`;
}

// När ska timern bli gul? Sista tiondelen av målet, minst 1 och högst 5 minuter.
export function warnAt(targetSec) {
  return Math.max(60, Math.min(300, targetSec * 0.1));
}
