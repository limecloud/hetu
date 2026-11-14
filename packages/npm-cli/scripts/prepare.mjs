import { copyFile, readFile } from 'node:fs/promises';
const root = new URL('../../../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const workspace = JSON.parse(await readFile(new URL('package.json', root)));
if (pkg.version !== workspace.version) throw new Error('npm 启动器与河图版本不一致。');
await copyFile(new URL('LICENSE', root), new URL('../LICENSE', import.meta.url));
