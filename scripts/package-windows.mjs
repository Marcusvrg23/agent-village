import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(['package.json', 'server.js', 'src', 'public', 'electron']);
const outputs = await packager({
  dir: root, out: path.join(root, 'release'), name: 'Codex Ops Room',
  platform: 'win32', arch: 'x64', asar: true, overwrite: false,
  download: { cacheRoot: path.join(root, '.tmp', 'electron-cache') },
  prune: true,
  ignore: (entry) => {
    if (!entry) return false;
    const first = entry.replaceAll('\\', '/').replace(/^\//, '').split('/')[0];
    return !allowed.has(first);
  },
  win32metadata: { CompanyName: 'Local', FileDescription: 'Codex Ops Room local read-only monitor', ProductName: 'Codex Ops Room' },
});
console.log(outputs.map((directory) => path.join(directory, 'Codex Ops Room.exe')).join('\n'));
