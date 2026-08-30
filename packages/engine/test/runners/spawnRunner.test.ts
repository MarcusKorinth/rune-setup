import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { SecretString } from '../../src/engine/secrets.js';
import type { ResolvedCommand } from '../../src/engine/plan.js';
import { SpawnRunner } from '../../src/runners/spawnRunner.js';

/** A real command on any platform: this very Node binary. */
function nodeCommand(script: string, overrides: Partial<ResolvedCommand> = {}): ResolvedCommand {
  return {
    argv: [process.execPath, '-e', script],
    cwd: process.cwd(),
    env: {},
    timeoutSeconds: null,
    successExitCodes: [0],
    ...overrides,
  };
}

function run(
  command: ResolvedCommand,
  options: { cancel?: CancelToken; onOutput?: (stream: string, line: string) => void } = {},
) {
  return new SpawnRunner().run({
    command,
    extraEnv: { RUNE_RUN_ID: 'run', RUNE_STEP_ID: 'step' },
    cancel: options.cancel ?? new CancelToken(),
    onOutput: options.onOutput ?? (() => undefined),
  });
}

async function withInheritedEnvironment(
  name: string,
  value: string,
  runWithEnvironment: () => Promise<void>,
): Promise<void> {
  const matchesName = (candidate: string): boolean =>
    process.platform === 'win32'
      ? candidate.toUpperCase() === name.toUpperCase()
      : candidate === name;
  const previousEntries = Object.entries(process.env).filter(([candidate]) =>
    matchesName(candidate),
  );

  for (const [candidate] of previousEntries) {
    delete process.env[candidate];
  }
  process.env[name] = value;

  try {
    await runWithEnvironment();
  } finally {
    for (const candidate of Object.keys(process.env)) {
      if (matchesName(candidate)) {
        delete process.env[candidate];
      }
    }
    for (const [candidate, previousValue] of previousEntries) {
      process.env[candidate] = previousValue;
    }
  }
}

describe('SpawnRunner', () => {
  it('runs an argv command and reports its exit code', async () => {
    await expect(run(nodeCommand('process.exit(0)'))).resolves.toEqual({
      kind: 'exited',
      exitCode: 0,
    });
    await expect(run(nodeCommand('process.exit(7)'))).resolves.toEqual({
      kind: 'exited',
      exitCode: 7,
    });
  }, 15_000);

  it('delivers output as lines, tagged with the stream it came from', async () => {
    const lines: string[] = [];

    await run(nodeCommand('console.log("one\\ntwo"); console.error("oops")'), {
      onOutput: (stream, line) => lines.push(`${stream}:${line}`),
    });

    expect(lines).toContain('stdout:one');
    expect(lines).toContain('stdout:two');
    expect(lines).toContain('stderr:oops');
  });

  it('passes the environment overlay and the reserved variables to the child', async () => {
    const lines: string[] = [];

    await run(
      nodeCommand('console.log(process.env.GREETING, process.env.RUNE_STEP_ID)', {
        env: { GREETING: 'hello' },
      }),
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toContain('hello step');
  });

  it.runIf(process.platform === 'win32')(
    'replaces inherited environment names case-insensitively and reserves RUNE variables',
    async () => {
      const lines: string[] = [];

      await withInheritedEnvironment('RUNE_SPAWN_RUNNER_CASE_MARKER', 'parent', async () => {
        await run(
          nodeCommand(
            'console.log(process.env.rune_spawn_runner_case_marker, process.env.RUNE_RUN_ID, process.env.RUNE_STEP_ID)',
            {
              env: {
                rune_spawn_runner_case_marker: 'overlay',
                rune_run_id: 'manifest-run',
                Rune_Step_Id: 'manifest-step',
              },
            },
          ),
          { onOutput: (_stream, line) => lines.push(line) },
        );
      });

      expect(lines).toContain('overlay run step');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps environment names case-sensitive on POSIX',
    async () => {
      const lines: string[] = [];

      await withInheritedEnvironment('RUNE_SPAWN_RUNNER_CASE_MARKER', 'parent', async () => {
        await run(
          nodeCommand(
            'console.log(process.env.RUNE_SPAWN_RUNNER_CASE_MARKER, process.env.rune_spawn_runner_case_marker, process.env.RUNE_RUN_ID, process.env.rune_run_id)',
            {
              env: {
                rune_spawn_runner_case_marker: 'overlay',
                rune_run_id: 'manifest-run',
              },
            },
          ),
          { onOutput: (_stream, line) => lines.push(line) },
        );
      });

      expect(lines).toContain('parent overlay run manifest-run');
    },
  );

  it('unwraps a secret-wrapped argument and env value only for the child', async () => {
    const lines: string[] = [];

    await run(
      {
        ...nodeCommand('console.log(process.argv[1], process.env.TOKEN)'),
        argv: [
          process.execPath,
          '-e',
          'console.log(process.argv[1], process.env.TOKEN)',
          new SecretString('wrapped-arg'),
        ],
        env: { TOKEN: new SecretString('wrapped-env') },
      },
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toContain('wrapped-arg wrapped-env');
  });

  it('runs in the working directory the plan chose', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cwd-'));
    const lines: string[] = [];

    await run(nodeCommand('console.log(process.cwd())', { cwd: directory }), {
      onOutput: (_stream, line) => lines.push(line),
    });

    expect(lines.join('\n')).toContain(directory.slice(-10));
  }, 15_000);

  it('reports a command that does not exist as failed to start, not as a crash', async () => {
    const outcome = await run(
      nodeCommand('', { argv: ['rune-definitely-not-installed-anywhere'] }),
    );

    expect(outcome.kind).toBe('failedToStart');
  });

  it('settles a synchronous spawn validation error without exposing its secret value', async () => {
    const secretMarker = 'nul-secret-value';
    const secret = `${secretMarker}\0suffix`;

    const outcome = await run(
      nodeCommand('process.exit(0)', { env: { TOKEN: new SecretString(secret) } }),
    );

    expect(outcome).toEqual({
      kind: 'failedToStart',
      message: 'the process launch configuration is invalid',
    });
    expect(JSON.stringify(outcome)).not.toContain(secretMarker);
  });

  it('kills a process that exceeds its timeout', async () => {
    const outcome = await run(nodeCommand('setInterval(() => {}, 1000)', { timeoutSeconds: 1 }));

    expect(outcome).toEqual({ kind: 'timedOut' });
  }, 15000);

  it('kills a process when the run is cancelled', async () => {
    const cancel = new CancelToken();
    const pending = run(nodeCommand('setInterval(() => {}, 1000)'), { cancel });
    setTimeout(() => cancel.cancel(), 200);

    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
  }, 15000);

  it('keeps the timeout outcome when cancellation follows before the process closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cancel = new CancelToken();
    const pending = run(nodeCommand('setInterval(() => {}, 1000)', { timeoutSeconds: 1 }), {
      cancel,
    });

    try {
      vi.advanceTimersByTime(1000);
      cancel.cancel();
    } finally {
      vi.useRealTimers();
    }

    await expect(pending).resolves.toEqual({ kind: 'timedOut' });
  }, 15000);

  it('keeps the cancelled outcome when the timeout follows before the process closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cancel = new CancelToken();
    const pending = run(nodeCommand('setInterval(() => {}, 1000)', { timeoutSeconds: 1 }), {
      cancel,
    });

    try {
      cancel.cancel();
      vi.advanceTimersByTime(1000);
    } finally {
      vi.useRealTimers();
    }

    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
  }, 15000);
});
