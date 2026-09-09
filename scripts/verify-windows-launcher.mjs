import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

/** Exercise transport with real Electron, after the unmodified application checks. */
export async function verifyWindowsLauncher(unpacked, environment) {
  if (process.platform !== 'win32') return;
  const resources = join(unpacked, 'resources');
  const archive = join(resources, 'app.asar');
  const saved = join(resources, 'verified-app.asar');
  const probe = join(resources, 'app');
  const executable = join(unpacked, 'rune-gui-shell.exe');
  renameSync(archive, saved);
  mkdirSync(probe);
  writeFileSync(join(probe, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  writeFileSync(
    join(probe, 'main.cjs'),
    [
      "const { app } = require('electron');",
      'app.whenReady().then(async () => {',
      "  const { spawn } = require('node:child_process');",
      "  const { join } = require('node:path');",
      "  const service = spawn(process.execPath, [join(__dirname, 'service.cjs'),",
      '    process.env.RUNE_TRANSPORT_MARKER], {',
      "    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore',",
      '    windowsHide: true, detached: true, shell: false });',
      '  service.unref();',
      "  await new Promise((resolve, reject) => { service.once('spawn', resolve);",
      "    service.once('error', reject); });",
      // Electron deliberately replaces process.stdin with an empty stream on Windows.
      // Read the inherited descriptor directly to test the OS transport.
      "  const chunks = [require('node:fs').readFileSync(0)];",
      "  process.stdout.write('\\r\\n');",
      "  process.stdout.write(JSON.stringify(process.argv.slice(1)) + '\\n');",
      '  const bytes = Buffer.alloc(1024 * 1024);',
      '  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;',
      '  process.stdout.write(bytes);',
      '  await new Promise((resolve, reject) => process.stdout.write(Buffer.concat(chunks),',
      '    (error) => error ? reject(error) : resolve()));',
      '  await new Promise((resolve, reject) =>',
      "    process.stderr.write('transport diagnostic\\n',",
      '      (error) => error ? reject(error) : resolve()));',
      '  app.exit(42);',
      '});',
    ].join('\n'),
  );
  writeFileSync(
    join(probe, 'service.cjs'),
    [
      "const fs = require('node:fs');",
      'const marker = process.argv[2];',
      'const deadline = setTimeout(() => process.exit(1), 10000);',
      'const waiting = setInterval(() => {',
      "  if (!fs.existsSync(marker + '.release')) return;",
      "  fs.writeFileSync(marker, 'complete');",
      '  clearInterval(waiting); clearTimeout(deadline);',
      '}, 50);',
    ].join('\n'),
  );
  const marker = join(resources, 'service-completed');
  let child;
  try {
    const args = ['--', 'path with spaces', 'quotes"and\\slashes\\', 'ümlaut', ''];
    const input = Buffer.from('stdin: \u0000\r\n雪');
    child = spawn(executable, args, {
      cwd: unpacked,
      env: { ...environment, RUNE_TRANSPORT_MARKER: marker },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    const output = [];
    const diagnostics = [];
    child.stderr.on('data', (chunk) => diagnostics.push(chunk));
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(input);
    // The stream stays paused until its buffers fill: the launcher must retain
    // every byte and propagate backpressure instead of dropping queued output.
    await delay(500);
    child.stdout.on('data', (chunk) => output.push(chunk));
    assert.deepEqual(await closed, { code: 42, signal: null });
    const bytes = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const expected = Buffer.concat([Buffer.from(`\r\n${JSON.stringify(args)}\n`), bytes, input]);
    assert.deepEqual(
      Buffer.concat(output),
      expected,
      'The launcher must preserve application bytes',
    );
    assert.equal(Buffer.concat(diagnostics).toString(), 'transport diagnostic\n');
    // The detached service is still running when the caller receives close;
    // neither terminating it nor retaining a caller pipe is normal completion.
    writeFileSync(marker + '.release', 'finish');
    for (let attempt = 0; attempt < 50 && !existsSync(marker); attempt += 1) await delay(100);
    assert(existsSync(marker), 'Normal launcher exit must preserve detached workflow services');
    process.stdout.write(
      'Windows launcher preserved argv, stdin, binary stdout and exit status.\n',
    );
  } finally {
    if (child?.pid && child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        timeout: 10_000,
      });
    }
    assert.equal(dirname(resolve(probe)), resolve(resources));
    rmSync(probe, { recursive: true, force: true });
    rmSync(marker, { force: true });
    rmSync(marker + '.release', { force: true });
    renameSync(saved, archive);
  }
}
