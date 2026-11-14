// Ritar appikonen som HTML, fotograferar den i 1024×1024 och gör en .icns.
//   npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'build');
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:185px;
  background:linear-gradient(145deg,#4f8ff7 0%,#3b6ff0 40%,#6d3df0 100%);
  box-shadow:0 18px 40px rgba(0,0,0,.35), inset 0 2px 0 rgba(255,255,255,.25);overflow:hidden">
  <div style="position:absolute;inset:0;background:radial-gradient(600px 400px at 30% 0%,rgba(255,255,255,.28),transparent 70%)"></div>
  <!-- presentatörsskärm (bak) -->
  <div style="position:absolute;left:150px;top:420px;width:330px;height:220px;border-radius:26px;background:rgba(255,255,255,.42)"></div>
  <!-- publikskärm (fram) -->
  <div style="position:absolute;left:300px;top:210px;width:400px;height:270px;border-radius:30px;background:#fff;box-shadow:0 20px 40px rgba(20,20,60,.35)">
    <div style="position:absolute;left:44px;top:46px;width:170px;height:22px;border-radius:11px;background:#3b6ff0"></div>
    <div style="position:absolute;left:44px;top:92px;width:260px;height:14px;border-radius:7px;background:#c9d3ea"></div>
    <div style="position:absolute;left:44px;top:120px;width:220px;height:14px;border-radius:7px;background:#c9d3ea"></div>
    <div style="position:absolute;right:40px;bottom:36px;width:0;height:0;border-left:58px solid #6d3df0;border-top:36px solid transparent;border-bottom:36px solid transparent"></div>
  </div>
  <!-- kodtecken -->
  <div style="position:absolute;left:520px;top:560px;font:700 150px/1 ui-monospace,Menlo,monospace;color:rgba(255,255,255,.92);letter-spacing:-10px">&lt;/&gt;</div>
</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  const png = path.join(OUT, 'icon.png');
  fs.writeFileSync(png, img.resize({ width: 1024, height: 1024 }).toPNG());
  const set = path.join(OUT, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), png, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'icon.icns')]);
  fs.rmSync(set, { recursive: true, force: true });
  console.log('Ikon skapad:', path.join(OUT, 'icon.icns'));
  app.quit();
});
