// preload.cjs — det enda appens UI får prata med huvudprocessen genom.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('hp', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  closeDeck: () => ipcRenderer.invoke('close-deck'),
  recent: () => ipcRenderer.invoke('recent'),
  forgetRecent: (p) => ipcRenderer.invoke('forget-recent', p),
  state: () => ipcRenderer.invoke('state'),
  rememberIndex: (i) => ipcRenderer.invoke('remember-index', i),
  reveal: () => ipcRenderer.invoke('reveal'),
  pathForFile: (file) => webUtils.getPathForFile(file),

  editInner: (id, html) => ipcRenderer.invoke('edit-inner', { id, html }),
  editRemove: (id) => ipcRenderer.invoke('edit-remove', { id }),
  undo: () => ipcRenderer.invoke('undo'),
  redo: () => ipcRenderer.invoke('redo'),
  save: () => ipcRenderer.invoke('save'),
  saveAs: () => ipcRenderer.invoke('save-as'),

  requestThumbs: (token, indices) => ipcRenderer.invoke('thumbs', { token, indices }),

  presentStart: (opts) => ipcRenderer.invoke('present-start', opts),
  presentStop: () => ipcRenderer.invoke('present-stop'),
  presentSwap: () => ipcRenderer.invoke('present-swap'),
  presentSync: (state) => ipcRenderer.send('present-sync', state),
  displays: () => ipcRenderer.invoke('displays'),

  audienceReady: () => ipcRenderer.send('audience-ready'),
  audienceKey: (k) => ipcRenderer.send('audience-key', k),

  onDeckState: on('deck-state'),
  onThumb: on('thumb'),
  onMenu: on('menu'),
  onRemoteKey: on('remote-key'),
  onPresentLayout: on('present-layout'),
  onPresentStopped: on('present-stopped'),
  onSync: on('sync'),
});
