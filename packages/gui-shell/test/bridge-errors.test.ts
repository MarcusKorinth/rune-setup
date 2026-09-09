import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CancelledError,
  ConditionError,
  ExecutionError,
  InputError,
  InternalError,
  ManifestError,
  PlatformError,
  ResolutionError,
  RuneError,
  Session,
  UsageError,
} from '@rune/engine';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { registerBridge } from '../src/main/bridge.js';
import type { BridgeReply } from '../src/preload/types.js';
import { throughPreload } from './bridge-fixture.js';

const secret = 'private-bridge-secret';
const options = {
  location: { file: `${secret}/answers.yaml`, line: 7, column: 9 },
  cause: new Error(`internal cause ${secret}`),
};
const message = `invalid value ${secret}`;
const errors = [
  [new RuneError('RUNE-202', message, options), 4],
  [new UsageError(message, options), 2],
  [new PlatformError(message, options), 2],
  [new ManifestError('RUNE-104', message, options), 3],
  [new InputError('RUNE-202', message, options), 4],
  [new ResolutionError('RUNE-301', message, options), 5],
  [new ConditionError('RUNE-312', message, options), 5],
  [new ExecutionError('RUNE-406', message, options), 1],
  [new CancelledError(message, options), 6],
  [new InternalError(message, options), 70],
] as const;

async function failingCall(error: unknown, secretValue = secret): Promise<() => unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'rune-bridge-errors-'));
  const manifest = join(directory, 'installer.yaml');
  writeFileSync(
    manifest,
    [
      'schemaVersion: 1',
      'product: { name: Example, version: "1.0.0" }',
      'inputs: { token: { type: secret } }',
      'steps: []',
    ].join('\n'),
  );
  const session = await Session.open(manifest, {
    mode: 'gui',
    environment: {},
    overrides: { token: secretValue },
  });
  vi.spyOn(Session.prototype, 'warnings').mockImplementation(() => {
    throw error;
  });
  const handlers = new Map<string, () => unknown>();
  registerBridge(session, { events: { send: vi.fn() } }, (channel, handler) => {
    handlers.set(channel, handler);
  });
  return handlers.get('rune:warnings')!;
}

describe('structured bridge errors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps machine codes exact when the code is itself a registered secret', async () => {
    const handler = await failingCall(new InputError('RUNE-202', 'invalid RUNE-202'), 'RUNE-202');
    await expect(throughPreload(handler)()).rejects.toEqual({
      kind: 'rune-error',
      code: 'RUNE-202',
      exitCode: 4,
      location: null,
      message: 'invalid ***',
      displayText: '*** (exit 4): invalid ***',
    });
  });

  it('fails closed when JSON escaping would create a registered secret in error fields', async () => {
    const handler = await failingCall(
      new InputError('RUNE-202', 'private\\path', {
        location: { file: 'private\\path', line: 7, column: 9 },
      }),
      'private\\\\path',
    );
    await expect(throughPreload(handler)()).rejects.toEqual({
      kind: 'rune-error',
      code: 'RUNE-202',
      exitCode: 4,
      location: { file: '***', line: 7, column: 9 },
      message: '***',
      displayText: '***',
    });
  });

  it.each(errors)('preserves %s metadata through main and preload', async (error, exitCode) => {
    const handler = await failingCall(error);
    const reply = (await handler()) as BridgeReply<unknown>;
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('expected a failure reply');
    expect(reply.error).toEqual({
      kind: 'rune-error',
      code: error.code,
      message: error.message.replaceAll(secret, '***'),
      location: { file: '***/answers.yaml', line: 7, column: 9 },
      exitCode,
      displayText: `${error.code} (exit ${exitCode}): ***/answers.yaml:7:9: ${error.message.replaceAll(secret, '***')}`,
    });
    expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);
    expect(JSON.stringify(reply)).not.toContain(secret);
    expect(reply.error).not.toBeInstanceOf(Error);
    expect(reply.error).not.toHaveProperty('stack');
    expect(reply.error).not.toHaveProperty('cause');
    await expect(throughPreload(handler)()).rejects.toEqual(reply.error);
  });

  it.each<unknown>([
    new Error(secret),
    secret,
    { message: secret },
    null,
    undefined,
    42n,
    {
      toString: () => {
        throw new Error(secret);
      },
    },
  ])('uses value-free fallback for unknown thrown value %#', async (error) => {
    const handler = await failingCall(error);
    await expect(throughPreload(handler)()).rejects.toEqual({
      kind: 'rune-error',
      code: 'RUNE-500',
      exitCode: 70,
      message: 'An unexpected shell error occurred.',
      location: null,
      displayText: 'RUNE-500 (exit 70): An unexpected shell error occurred.',
    });
  });
});
