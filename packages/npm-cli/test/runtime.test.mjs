import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { cachedRuntime, downloadArchive, releaseDigest, requirePlatform, version } from '../src/runtime.mjs';

test('unsupported machines fail before acquiring a runtime', () => {
  requirePlatform('darwin', 'arm64', '23.0.0');
  for (const machine of [['linux', 'arm64', '24.0'], ['darwin', 'x64', '24.0'], ['darwin', 'arm64', '22.0']]) {
    assert.throws(() => requirePlatform(...machine), /macOS 14/);
  }
});

test('release metadata must identify the exact official notarized version', () => {
  const manifest = {
    kind: 'electron-release-package', version, platform: 'macos', architecture: 'arm64', team_id: '93RF7VQ26C',
    notarization_status: 'Accepted', files: { [`Hetu-${version}-macos-arm64.zip`]: 'a'.repeat(64) },
  };
  assert.equal(releaseDigest(manifest), 'a'.repeat(64));
  for (const change of [{ kind: 'electron-development-package' }, { kind: 'electron-local-install-package' }, { version: '0.0.0' }, { platform: 'linux' }, { architecture: 'x64' },
    { team_id: 'ABCDEFGHIJ' }, { notarization_status: 'In Progress' }, { files: {} }]) {
    assert.throws(() => releaseDigest({ ...manifest, ...change }), /不匹配/);
  }
});

test('downloads accept exact bytes and reject tampering or HTTP errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hetu-npm-download-'));
  try {
    const bytes = Buffer.from('release archive fixture');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const destination = join(directory, 'valid.zip');
    await downloadArchive(new Response(bytes), destination, digest);
    assert.deepEqual(await readFile(destination), bytes);
    await assert.rejects(downloadArchive(new Response('altered'), join(directory, 'tampered.zip'), digest), /SHA-256/);
    await assert.rejects(downloadArchive(new Response(null, { status: 404 }), join(directory, 'missing.zip'), digest), /HTTP 404/);
    await assert.rejects(downloadArchive(new Response(bytes), destination, digest), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const runtimeURL = new URL('../src/runtime.mjs', import.meta.url).href;

test('private installation verifies once, rejects incomplete receipts and never trusts a failed verification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hetu-npm-cache-'));
  try {
    const helpers = join(directory, 'Hetu.app/Contents/Resources/bin');
    await mkdir(helpers, { recursive: true });
    for (const name of ['hetu', 'hetu-mcp']) await writeFile(join(helpers, name), 'fixture');
    await assert.rejects(cachedRuntime(directory, () => { throw new Error('signature rejected'); }), /signature rejected/);
    await assert.rejects(readFile(join(directory, 'installation.json')), { code: 'ENOENT' });
    let validations = 0;
    assert.equal(await cachedRuntime(directory, () => { validations++; }), join(directory, 'Hetu.app'));
    assert.equal(validations, 1);
    await cachedRuntime(directory, () => assert.fail('warm launch repeated system verification'));
    await rm(join(helpers, 'hetu-mcp'));
    await assert.rejects(cachedRuntime(directory), /缓存不完整/);
    await writeFile(join(helpers, 'hetu-mcp'), 'fixture');
    await writeFile(join(directory, 'installation.json'), JSON.stringify({ schema_version: 1, version: '0.0.0', team_id: '93RF7VQ26C' }));
    await assert.rejects(cachedRuntime(directory), /版本不匹配/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function relay(source, args = []) {
  return spawn(process.execPath, ['--input-type=module', '-e', `
    import { forward } from ${JSON.stringify(runtimeURL)};
    const result = await forward(process.execPath, ['-e', ${JSON.stringify(source)}, ...process.argv.slice(1)]);
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code;
  `, '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
}

test('native invocation retains argument boundaries, stdin, streams and exit code', async () => {
  const child = relay(`
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      console.log(JSON.stringify({ args: process.argv.slice(1), input }));
      console.error('diagnostic'); process.exitCode = 23;
    });
  `, ['one two', '$(literal)', '中文']);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const completed = once(child, 'close');
  child.stdin.end('MCP request\n');
  assert.deepEqual(await completed, [23, null]);
  assert.deepEqual(JSON.parse(stdout), { args: ['one two', '$(literal)', '中文'], input: 'MCP request\n' });
  assert.equal(stderr.trim(), 'diagnostic');
});

test('cancellation reaches the native process and retains its signal', { timeout: 10000 }, async () => {
  const child = relay("console.log('ready'); setInterval(() => {}, 1000)");
  try {
    const completed = once(child, 'close');
    await once(child.stdout, 'data');
    child.kill('SIGTERM');
    assert.deepEqual(await completed, [null, 'SIGTERM']);
  } finally {
    child.kill('SIGKILL');
  }
});
