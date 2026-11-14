// Bygger "HTML Presenter.app" (Apple Silicon) i dist/.
//   npm run package          → bara bygg
//   npm run install-app      → bygg och installera i ~/Applications
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const install = process.argv.includes('--install');
const NAME = 'HTML Presenter';

const [outDir] = await packager({
  dir: root,
  name: NAME,
  executableName: NAME,
  platform: 'darwin',
  arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  out: path.join(root, 'dist'),
  overwrite: true,
  asar: true,
  prune: true,
  icon: path.join(root, 'build', 'icon.icns'),
  appBundleId: 'se.evolai.htmlpresenter',
  appCategoryType: 'public.app-category.productivity',
  appCopyright: 'Peter Kurzwelly',
  ignore: [/^\/\.git($|\/)/, /^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/docs($|\/)/, /^\/examples($|\/)/, /^\/\.gitignore$/, /^\/build\/icon\.png$/, /^\/\.claude($|\/)/, /^\/README\.md$/],
  extendInfo: {
    CFBundleDocumentTypes: [{
      CFBundleTypeName: 'HTML-presentation',
      CFBundleTypeRole: 'Viewer',
      LSHandlerRank: 'Alternate',
      LSItemContentTypes: ['public.html'],
    }],
    NSHumanReadableCopyright: 'Peter Kurzwelly',
  },
});

const appPath = path.join(outDir, `${NAME}.app`);
// Ad hoc-signering så att macOS på Apple Silicon kör appen efter att Info.plist ändrats.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
console.log('Byggd:', appPath);

if (install) {
  const dest = path.join(os.homedir(), 'Applications', `${NAME}.app`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync('ditto', [appPath, dest]);
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  try { execFileSync(lsregister, ['-f', dest]); } catch { /* inte kritiskt */ }
  console.log('Installerad:', dest);
}
