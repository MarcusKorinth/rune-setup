import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as EngineModule from '@rune/engine';

const engineMock = vi.hoisted(() => ({
  writeFailure: undefined as unknown,
  writeCalls: [] as Array<{ result: unknown; path: string }>,
  failureErrors: [] as unknown[],
}));

vi.mock('@rune/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof EngineModule>();
  return {
    ...actual,
    createFailureResult: (options: Parameters<typeof actual.createFailureResult>[0]) => {
      engineMock.failureErrors.push(options.error);
      return actual.createFailureResult(options);
    },
    writeResult: (result: Parameters<typeof actual.writeResult>[0], path: string) => {
      engineMock.writeCalls.push({ result, path });
      if (engineMock.writeFailure !== undefined) {
        throw engineMock.writeFailure;
      }
      actual.writeResult(result, path);
    },
  };
});

import { RuneError, Session, type RunResult } from '@rune/engine';
import { run, type CliIo } from '@rune/cli';
import { runResultSchema } from '../packages/engine/src/results/schema.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

const originalSessionOpen = Session.open;

beforeEach(() => {
  engineMock.writeFailure = undefined;
  engineMock.writeCalls.length = 0;
  engineMock.failureErrors.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI internal-error boundary', () => {
  it('writes a secret-safe internal result with opened-session context for an unknown plan error', async () => {
    const secret = 'cause-contains-secret-value';
    const cause = new Error(`planner exposed ${secret}`);
    const manifestPath = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: use-token',
      '    run:',
      '      command: node',
      '      args: ["-e", ""]',
    ]);
    const resultPath = join(manifestPath, '..', 'result.json');
    const io = capture();

    vi.spyOn(Session, 'open').mockImplementation(async (path, options) => {
      const session = await originalSessionOpen(path, options);
      return failAtPlan(session, cause);
    });

    const code = await run(
      [
        'run',
        manifestPath,
        '--non-interactive',
        '--set',
        `token=${secret}`,
        '--result',
        resultPath,
      ],
      io,
    );

    expect(code).toBe(70);
    expect(engineMock.writeCalls).toHaveLength(1);
    expect(engineMock.failureErrors).toHaveLength(1);
    expect((engineMock.failureErrors[0] as Error).cause).toBe(cause);
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
    expect(() => runResultSchema.parse(result)).not.toThrow();
    expect(result).toMatchObject({
      status: 'internal_error',
      exitCode: 70,
      manifest: { path: manifestPath, schemaVersion: 1 },
      product: { name: 'Example', version: '1.0.0' },
      inputs: [
        {
          id: 'token',
          value: null,
          source: 'set',
          secret: true,
          enabled: true,
          ignored: null,
        },
      ],
      steps: [],
    });
    expect(result.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(io.err.join('\n')).not.toContain(secret);
    expect((engineMock.failureErrors[0] as Error).message).not.toContain(secret);
  });

  it('does not retry or build a second result when result delivery fails', async () => {
    const writerSecret = 'writer-secret-message';
    engineMock.writeFailure = new Error(writerSecret);
    const manifestPath = fixture(MINIMAL_MANIFEST);
    const resultPath = join(manifestPath, '..', 'result.json');
    const io = capture();

    const code = await run(
      ['run', manifestPath, '--dry-run', '--non-interactive', '--result', resultPath],
      io,
    );

    expect(code).toBe(70);
    expect(engineMock.writeCalls).toHaveLength(1);
    expect(engineMock.failureErrors).toEqual([]);
    expect(io.err.join('\n')).toContain('internal error: an unexpected error occurred');
    expect(io.err.join('\n')).not.toContain(writerSecret);
    expect(io.err.join('\n')).not.toContain('Dry run: nothing was executed.');
    expect(io.err.join('\n')).not.toContain('planned:');
  });

  it('keeps the RuneError result path intact', async () => {
    const manifestPath = fixture(['schemaVersion: 1', 'product:', '  name: Invalid']);
    const resultPath = join(manifestPath, '..', 'result.json');
    const io = capture();

    expect(await run(['run', manifestPath, '--result', resultPath], io)).toBe(3);

    expect(engineMock.failureErrors).toHaveLength(1);
    expect(engineMock.writeCalls).toHaveLength(1);
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
    expect(() => runResultSchema.parse(result)).not.toThrow();
    expect(result.status).toBe('config_error');
  });

  it('does not render a config-error outcome when its result delivery fails', async () => {
    const writerSecret = 'config-writer-secret-message';
    engineMock.writeFailure = new Error(writerSecret);
    const manifestPath = fixture(['schemaVersion: 1', 'product:', '  name: Invalid']);
    const resultPath = join(manifestPath, '..', 'result.json');
    const io = capture();

    const code = await run(['run', manifestPath, '--result', resultPath], io);

    expect(code).toBe(70);
    expect(engineMock.writeCalls).toHaveLength(1);
    expect(engineMock.failureErrors).toHaveLength(1);
    expect(engineMock.failureErrors[0]).toBeInstanceOf(RuneError);
    expect(engineMock.failureErrors[0]).toMatchObject({ code: 'RUNE-103' });
    expect(io.err.join('\n')).toContain('internal error: an unexpected error occurred');
    expect(io.err.join('\n')).not.toContain(writerSecret);
    expect(io.err.join('\n')).not.toContain('config_error:');
  });

  it('keeps usage errors outside result delivery', async () => {
    const manifestPath = fixture(MINIMAL_MANIFEST);
    const resultPath = join(manifestPath, '..', 'result.json');
    const io = capture();

    expect(
      await run(['run', manifestPath, '--platform', 'windows', '--result', resultPath], io),
    ).toBe(2);
    expect(engineMock.failureErrors).toEqual([]);
    expect(engineMock.writeCalls).toEqual([]);
  });
});

const MINIMAL_MANIFEST = [
  'schemaVersion: 1',
  'product:',
  '  name: Example',
  '  version: "1.0.0"',
  'steps:',
  '  - id: noop',
  '    run:',
  '      command: node',
  '      args: ["-e", ""]',
];

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

function fixture(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-cli-internal-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(path, [...lines, ''].join('\n'), 'utf8');
  return path;
}

function failAtPlan(session: Session, cause: unknown): Session {
  return new Proxy(session, {
    get(target, property) {
      if (property === 'plan') {
        return (): never => {
          throw cause;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
