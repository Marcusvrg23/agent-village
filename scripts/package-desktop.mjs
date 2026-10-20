// Empacota o app desktop (Electron) para o sistema atual ou para o indicado:
//   npm run package:desktop                 → sistema e arquitetura desta máquina
//   npm run package:desktop -- --platform linux --arch x64
// Rode no próprio sistema de destino (o macOS só empacota bem no macOS). O app não é assinado: no macOS,
// abra com botão direito › Abrir na primeira vez.
import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
if (!['win32', 'darwin', 'linux'].includes(platform)) {
  console.error(`Sistema não suportado: ${platform} (use win32, darwin ou linux).`);
  process.exit(1);
}
// The status line tap and the permission hooks run from the source folder (`npm run village:setup`), with Node.
const allowed = new Set(['package.json', 'server.js', 'src', 'public', 'electron']);
const outputs = await packager({
  dir: root, out: path.join(root, 'release'), name: 'Codex Ops Room', platform, arch, asar: true, overwrite: false,
  download: { cacheRoot: path.join(root, '.tmp', 'electron-cache') },
  prune: true,
  ignore: (entry) => {
    if (!entry) return false;
    const first = entry.replaceAll('\\', '/').replace(/^\//, '').split('/')[0];
    return !allowed.has(first);
  },
  appBundleId: 'local.agent-village',
  win32metadata: { CompanyName: 'Local', FileDescription: 'Agent Village (local)', ProductName: 'Codex Ops Room' },
});
console.log(outputs.join('\n'));
