// thumbs.mjs — renderar miniatyrbilder av varje slide i ett osynligt fönster.
//
// Decket laddas med ?hp=thumb, vilket gör att kontrollern stänger av animationer
// och ljud. Sedan visas en slide i taget och fönstret fotograferas.

import { BrowserWindow } from 'electron';

const THUMB_WIDTH = 640;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class ThumbRenderer {
  constructor(onThumb) {
    this.onThumb = onThumb;
    this.win = null;
    this.job = 0;
    this.chain = Promise.resolve();
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      show: false,
      width: 1600,
      height: 900,
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win.webContents.setAudioMuted(true);
    this.win.webContents.setFrameRate(30);
    return this.win;
  }

  // Avbryter pågående jobb och startar ett nytt. indices = null betyder alla.
  render(url, token, indices = null) {
    const job = ++this.job;
    this.chain = this.chain
      .then(() => this._run(job, url, token, indices))
      .catch((err) => console.error('[thumbs]', err));
    return this.chain;
  }

  cancel() { this.job += 1; }

  async _run(job, url, token, indices) {
    if (job !== this.job) return;
    const win = this._ensureWindow();
    const wc = win.webContents;
    await win.loadURL(url);
    const ready = await this._waitReady(wc, job);
    if (!ready || job !== this.job) return;

    const info = await wc.executeJavaScript('window.__hp.info()');
    const { w, h } = info.size;
    win.setContentSize(w, h);
    await wait(80);
    await wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => 1) : 1').catch(() => {});

    const list = indices || Array.from({ length: info.count }, (_, i) => i);
    for (const i of list) {
      if (job !== this.job) return;
      if (i < 0 || i >= info.count) continue;
      try {
        await wc.executeJavaScript(`window.__hp.prepareCapture(${i})`);
        const image = await wc.capturePage();
        if (job !== this.job) return;
        const small = image.resize({ width: THUMB_WIDTH, quality: 'good' });
        this.onThumb({ token, index: i, count: info.count, url: 'data:image/jpeg;base64,' + small.toJPEG(84).toString('base64') });
      } catch (err) {
        console.error('[thumbs] slide', i, err.message);
      }
    }
  }

  async _waitReady(wc, job) {
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (job !== this.job) return false;
      const ok = await wc.executeJavaScript('!!(window.__hp && window.__hp.ready)').catch(() => false);
      if (ok) return true;
      await wait(60);
    }
    return false;
  }

  destroy() {
    this.cancel();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
