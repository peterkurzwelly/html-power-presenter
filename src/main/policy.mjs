// policy.mjs — vad decken får be om: nästan ingenting.
//
// Electron ger webbsidor kamera, mikrofon, notiser m.m. om ingen säger nej. Ett deck
// behöver inget av det, så allt nekas utom att kopiera text till urklipp (en kodruta
// med "Kopiera"-knapp). Gäller alla fönster: appen, decket, miniatyrer och import.

const ALLOWED = new Set(['clipboard-sanitized-write']);

const originOf = (url) => {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return ''; }
};

export function allowPermission(permission) {
  return ALLOWED.has(permission);
}

export function installPermissionPolicy(ses) {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ok = allowPermission(permission);
    if (!ok && process.env.HP_VERBOSE) console.log('[policy] nekade', permission, originOf(details && details.requestingUrl));
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => allowPermission(permission));
  if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
}

// "Testa utan nät": alla nätverksanrop (http, https, ws, wss) stoppas, som om datorn
// saknade nät. Det som appen själv visar (decket, dess filer och sparade typsnitt)
// går via hpres:// och fungerar som vanligt. Den här modulen är den enda som sätter
// webRequest-lyssnare, så att inga två funktioner skriver över varandras.
export function setOfflineTest(ses, on) {
  if (on) ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
  else ses.webRequest.onBeforeRequest(null);
}
