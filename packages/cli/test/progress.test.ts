import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Session } from '@rune/engine';
import { describe, expect, it, vi } from 'vitest';

import { progressObserver } from '../src/render.js';
import { guardStream } from '../src/streams.js';

async function strings() {
  const directory = mkdtempSync(join(tmpdir(), 'rune-progress-'));
  const manifest = join(directory, 'installer.yaml');
  writeFileSync(
    manifest,
    'schemaVersion: 1\nproduct: { name: Example, version: "1.0.0" }\nsteps: []\n',
  );
  return (await Session.open(manifest, { environment: {} })).getStrings();
}

describe('progress backpressure', () => {
  it('keeps a slow writable bounded while preserving every output line', async () => {
    const received: string[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk.toString());
        setImmediate(callback);
      },
    });
    const guard = guardStream(stream);
    const observer = progressObserver(
      { stdout: vi.fn(), stderr: guard.writeLine, drainStderr: guard.drain },
      await strings(),
    );
    let peakBufferedBytes = 0;
    for (let index = 0; index < 256; index += 1) {
      const pending = observer({
        kind: 'stepOutput',
        stepId: 'only',
        stream: 'stdout',
        line: `line-${index}`,
      });
      expect(pending).toBeInstanceOf(Promise);
      peakBufferedBytes = Math.max(peakBufferedBytes, stream.writableLength);
      await pending;
      expect(stream.writableLength).toBe(0);
    }

    expect(received).toEqual(Array.from({ length: 256 }, (_, index) => `  line-${index}\n`));
    expect(peakBufferedBytes).toBeLessThanOrEqual(Buffer.byteLength('  line-255\n'));
  });

  it('preserves synchronous rendering when the host has no drain hook', async () => {
    const stderr = vi.fn();
    const observer = progressObserver({ stdout: vi.fn(), stderr }, await strings());
    expect(
      observer({ kind: 'stepOutput', stepId: 'only', stream: 'stderr', line: 'hello' }),
    ).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith('  hello');
  });
});
