import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../scripts/launch-linux.sh', import.meta.url));
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rune-linux-launcher-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function invoke(args: readonly string[], relativePath = false, exitCode = 0) {
  const bundle = join(directory, 'bundle with spaces');
  const cwd = join(directory, 'caller with spaces');
  mkdirSync(bundle);
  mkdirSync(cwd);
  const executable = join(bundle, 'rune-gui-shell');
  copyFileSync(wrapper, executable);
  chmodSync(executable, 0o755);
  const native = join(bundle, 'rune-gui-shell-bin');
  writeFileSync(
    native,
    [
      '#!/bin/sh',
      'printf "%s\\0" "$$" "$PWD" "$#"',
      'printf "%s\\0" "$@"',
      'printf "ready\\n" >&3',
      'IFS= read -r response <&3',
      'printf "%s\\0" "$response"',
      'printf "%s\\0" "$headless" "$skip_operand" "$argument" "$native"',
      'exit "${RUNE_TEST_EXIT:-0}"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const child = spawn(relativePath ? relative(cwd, executable) : executable, args, {
    cwd,
    env: {
      PATH: '',
      RUNE_TEST_EXIT: String(exitCode),
      headless: 'inherited headless',
      skip_operand: 'inherited skip',
      argument: 'inherited argument',
      native: 'inherited native',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    shell: false,
    timeout: 5000,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  const control = child.stdio[3] as Duplex;
  control.once('data', () => control.write('duplex fd preserved\n'));
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(status).toBe(exitCode);
    expect(Buffer.concat(stderr).toString()).toBe('');
    const fields = Buffer.concat(stdout).toString().split('\0');
    expect(fields[0]).toBe(String(child.pid));
    expect(fields[1]).toBe(cwd);
    const count = Number(fields[2]);
    expect(fields.slice(3 + count)).toEqual([
      'duplex fd preserved',
      'inherited headless',
      'inherited skip',
      'inherited argument',
      'inherited native',
      '',
    ]);
    return fields.slice(3, 3 + count);
  } finally {
    control.destroy();
    child.kill();
  }
}

describe.runIf(process.platform === 'linux')('packaged Linux launcher', () => {
  it.each([
    ['--', 'installer.yaml', '--non-interactive'],
    ['--non-interactive', '--', 'installer.yaml'],
    ['installer.yaml', '--non-interactive'],
    ['--', 'installer.yaml', '--values', '--non-interactive', '--non-interactive'],
  ])('selects the native headless backend for a real option: %j', async (...args) => {
    expect(await invoke(args)).toEqual(['--ozone-platform=headless', ...args]);
  });

  it.each(['--', '--set', '--values', '--locale', '--result', '--log-file'])(
    'does not treat the operand of %s as an option',
    async (option) => {
      const args = [option, '--non-interactive'];
      expect(await invoke(args)).toEqual(args);
    },
  );

  it('preserves literal whitespace, quotes, substitutions, empty values, cwd, pid and fd3', async () => {
    const args = [
      '--',
      'manifest --non-interactive.yaml',
      '--set',
      'text=two words\n"quotes" \'literal\' $HOME $(printf injected)',
      '--locale',
      '',
    ];
    expect(await invoke(args, true, 7)).toEqual(args);
  });

  it('selects the headless backend for the standalone version probe with an empty PATH', async () => {
    expect(await invoke(['--rune-version-probe'])).toEqual([
      '--ozone-platform=headless',
      '--rune-version-probe',
    ]);
  });

  it.each([
    ['--rune-version-probe', 'installer.yaml'],
    ['--', '--rune-version-probe'],
    ['--values', '--rune-version-probe'],
    ['--locale', '--rune-version-probe'],
    ['--result', '--rune-version-probe'],
    ['--log-file', '--rune-version-probe'],
  ])('does not treat a non-standalone probe spelling as the probe mode: %j', async (...args) => {
    expect(await invoke(args)).toEqual(args);
  });
});
