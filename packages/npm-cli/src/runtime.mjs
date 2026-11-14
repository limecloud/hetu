import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const team = '93RF7VQ26C';
const asset = `Hetu-${version}-macos-arm64.zip`;
const origin = `https://github.com/limecloud/hetu/releases/download/v${version}/`;

export function requirePlatform(platform = process.platform, arch = process.arch, kernel = release()) {
  if (platform !== 'darwin' || arch !== 'arm64' || Number(kernel.split('.')[0]) < 23) {
    throw new Error('河图 v' + version + ' 原生运行时支持 macOS 14+ 的 Apple Silicon Mac。');
  }
}

export function releaseDigest(manifest) {
  const digest = manifest.files?.[asset];
  if (manifest.version !== version || manifest.platform !== 'macos' || manifest.architecture !== 'arm64'
      || manifest.team_id !== team || manifest.notarization_status !== 'Accepted' || !/^[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new Error('河图发行清单的版本、平台、签名团队或公证状态不匹配。');
  }
  return digest;
}

export async function downloadArchive(response, destination, expectedDigest) {
  if (!response.ok || !response.body) throw new Error(`下载河图运行时失败（HTTP ${response.status}）。`);
  let size = 0;
  const hash = createHash('sha256');
  const check = new Transform({ transform(chunk, encoding, done) {
    size += chunk.length;
    if (size > 512 * 1024 * 1024) return done(new Error('河图运行时超出下载大小限制。'));
    hash.update(chunk); done(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), check, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  if (hash.digest('hex') !== expectedDigest) throw new Error('河图运行时 SHA-256 不匹配，已停止安装。');
}

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`河图运行时校验失败：${binary}（${result.status}）。`);
  return result.stdout + result.stderr;
}

function appVersion(app) {
  return command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]).trim();
}

function verifyApp(app) {
  if (appVersion(app) !== version) throw new Error('河图原生运行时与 npm 包版本不一致。');
  if (command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')]).trim() !== 'run.limeai.hetu') {
    throw new Error('河图运行时应用身份不匹配。');
  }
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  for (const path of [app, ...['hetu', 'hetu-mcp'].map(name => join(app, 'Contents/Helpers', name))]) {
    const signature = command('/usr/bin/codesign', ['--display', '--verbose=4', path]);
    if (!signature.includes(`TeamIdentifier=${team}\n`) || !signature.includes('Authority=Developer ID Application:')) {
      throw new Error('河图运行时没有使用官方 Developer ID 签名。');
    }
  }
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  return app;
}

async function runtime() {
  requirePlatform();
  if (process.env.HETU_APP_PATH) return verifyApp(process.env.HETU_APP_PATH);
  for (const app of ['/Applications/Hetu.app', join(homedir(), 'Applications/Hetu.app')]) {
    if (existsSync(app) && appVersion(app) === version) return verifyApp(app);
  }
  const parent = join(homedir(), 'Library/Caches/Hetu/npm');
  const target = join(parent, version);
  const app = join(target, 'Hetu.app');
  if (existsSync(target)) return verifyApp(app);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(parent, '.install-'));
  try {
    process.stderr.write(`正在获取河图 v${version} 官方原生运行时；首次运行需要下载。\n`);
    const response = await fetch(origin + 'release-manifest.json', { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`河图 v${version} 发行清单尚不可用（HTTP ${response.status}）。`);
    const digest = releaseDigest(await response.json());
    const archive = join(temporary, 'runtime.zip');
    await downloadArchive(await fetch(origin + asset, { signal: AbortSignal.timeout(300_000) }), archive, digest);
    // 只接受发行包内的相对路径，再由系统工具解压与验证官方签名。
    const entries = command('/usr/bin/unzip', ['-Z1', archive]).split('\n').filter(Boolean);
    if (entries.some(path => path.startsWith('/') || path.includes('\\') || path.split('/').includes('..'))) {
      throw new Error('河图发行包包含非法路径。');
    }
    const extracted = join(temporary, 'extracted');
    command('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
    verifyApp(join(extracted, 'Hetu.app'));
    try { await rename(extracted, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      // 另一进程先完成安装时，只使用同样通过验证的精确版本。
    }
    return verifyApp(app);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function forward(binary, args) {
  const child = spawn(binary, args, { stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map(signal => () => { child.kill(signal); });
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
    });
  } finally {
    signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
  }
}

export async function main(binary) {
  try {
    const app = await runtime();
    const result = await forward(join(app, 'Contents/Helpers', binary), process.argv.slice(2));
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
