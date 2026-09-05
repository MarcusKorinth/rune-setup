/**
 * One guard for a whole defect class (docs/architecture.md §10, "Path spellings").
 *
 * RUNE anchors, resolves and normalizes the paths an operator hands it, but a secret registry
 * holds exactly the bytes the operator supplied. Every output that names a RUNE-derived
 * spelling therefore meets masks that cannot match it and prints the secret in the clear.
 *
 * Each scenario below declares a `secret` input whose value *is* the path RUNE will name,
 * spelled so that `resolve` rewrites it, and the one assertion helper checks every sink the
 * run touches — stdout, stderr, the log file and the result file — for the supplied spelling,
 * the resolved spelling and both of their JSON-escaped forms. Adding a path-bearing output
 * means adding one entry to `SCENARIOS`, not a new test.
 *
 * §10 exempts exactly one field: the structured `manifest.path` of a plan or a result keeps
 * RUNE's resolved spelling, because it is machine identity. A scenario names that spelling in
 * `exact`, which the helper asserts is really written and then removes from the file before
 * scanning the rest — an allow-list, so the exemption cannot widen unnoticed.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type CliIo } from '../src/cli.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

/** Rewrites an absolute path into a spelling `resolve` normalizes back to it. */
type Spelling = (path: string) => string;

/** Platform-neutral: `path.resolve` drops a `.` segment everywhere. */
const dotSegment: Spelling = (path) => {
  const cut = path.lastIndexOf(sep);
  return `${path.slice(0, cut)}${sep}.${path.slice(cut)}`;
};

/** Windows only: `path.resolve` rewrites every forward slash into a backslash. */
const forwardSlash: Spelling = (path) => path.replaceAll('\\', '/');

interface Run {
  readonly argv: readonly string[];
  /** The declared secret value, which is also the path RUNE is asked to name. */
  readonly secret: string;
  readonly exitCode: number;
  /** Files this run may write; their contents are sinks too. */
  readonly files?: readonly string[];
  /** Spellings §10 keeps exact in a written file, asserted present and then excluded. */
  readonly exact?: readonly string[];
}

interface Scenario {
  readonly name: string;
  readonly build: (directory: string, spell: Spelling) => Run;
}

const MANIFEST = [
  'schemaVersion: 1',
  'product:',
  '  name: Example',
  '  version: "1.0.0"',
  'inputs:',
  '  token:',
  '    type: secret',
];

function writeManifest(directory: string, inputs: readonly string[] = []): string {
  const path = join(directory, 'installer.yaml');
  writeFileSync(path, [...MANIFEST, ...inputs, 'steps: []', ''].join('\n'), 'utf8');
  return path;
}

/** An existing regular file, so creating a directory below it fails with a real errno. */
function blocked(directory: string, name: string): string {
  const blocker = join(directory, 'blocker');
  if (!existsSync(blocker)) {
    writeFileSync(blocker, 'occupied', 'utf8');
  }
  return join(blocker, name);
}

const SCENARIOS: readonly Scenario[] = [
  {
    // §10: the RUNE-406 log-sink diagnostic names the operator's `--log-file` spelling.
    name: 'the RUNE-406 log-file diagnostic',
    build: (directory, spell) => {
      const secret = spell(blocked(directory, 'secret-log-1234.log'));
      return {
        argv: [
          'run',
          writeManifest(directory),
          '--non-interactive',
          '--set',
          `token=${secret}`,
          '--log-file',
          secret,
        ],
        secret,
        exitCode: 1,
      };
    },
  },
  {
    // §10: the dry-run preview names the same spelling as the diagnostic for that path.
    name: 'the dry-run plan preview of the log path',
    build: (directory, spell) => {
      const secret = spell(join(directory, 'logs', 'secret-log-1234.log'));
      return {
        argv: [
          'run',
          writeManifest(directory),
          '--non-interactive',
          '--dry-run',
          '--set',
          `token=${secret}`,
          '--log-file',
          secret,
        ],
        secret,
        exitCode: 0,
      };
    },
  },
  {
    // §10: a real run's own sinks — the log file it writes and the result file it delivers.
    name: 'the log file and the result file of a real run',
    build: (directory, spell) => {
      const logFile = join(directory, 'logs', 'secret-log-1234.log');
      const resultFile = join(directory, 'out', 'result-1234.json');
      const secret = spell(logFile);
      return {
        argv: [
          'run',
          writeManifest(directory),
          '--non-interactive',
          '--set',
          `token=${secret}`,
          '--log-file',
          secret,
          '--result',
          resultFile,
        ],
        secret,
        exitCode: 0,
        files: [logFile, resultFile],
      };
    },
  },
  {
    // §10: the RUNE-407 delivery diagnostic names the operator's `--result` spelling.
    name: 'the RUNE-407 result-delivery diagnostic',
    build: (directory, spell) => {
      const secret = spell(blocked(directory, 'secret-result-1234.json'));
      return {
        argv: [
          'run',
          writeManifest(directory),
          '--non-interactive',
          '--set',
          `token=${secret}`,
          '--result',
          secret,
        ],
        secret,
        exitCode: 1,
      };
    },
  },
  {
    // §10: the success line for the same destination names that spelling too.
    name: 'the result-written announcement',
    build: (directory, spell) => {
      const resultFile = join(directory, 'out', 'secret-result-1234.json');
      const secret = spell(resultFile);
      return {
        argv: [
          'run',
          writeManifest(directory),
          '--non-interactive',
          '--set',
          `token=${secret}`,
          '--result',
          secret,
        ],
        secret,
        exitCode: 0,
        files: [resultFile],
      };
    },
  },
  {
    // §10: the plan heading names the manifest as the operator spelled it on the command line,
    // while the plan delivered beside it keeps `manifest.path` resolved — the one exempt field.
    name: 'the dry-run plan heading',
    build: (directory, spell) => {
      const secret = spell(writeManifest(directory));
      const resultFile = join(directory, 'out', 'plan-1234.json');
      return {
        argv: [
          'run',
          secret,
          '--non-interactive',
          '--dry-run',
          '--set',
          `token=${secret}`,
          '--result',
          resultFile,
        ],
        secret,
        exitCode: 0,
        files: [resultFile],
        exact: [jsonEscaped(resolve(secret))],
      };
    },
  },
  {
    // §10: a located diagnostic points at the file as its supplier spelled it — in the same
    // result document whose exempt `manifest.path` names that one file resolved.
    name: 'the RUNE-201 missing-input location',
    build: (directory, spell) => {
      const secret = spell(writeManifest(directory, ['  other:', '    type: text']));
      const resultFile = join(directory, 'out', 'failure-1234.json');
      return {
        argv: [
          'run',
          secret,
          '--non-interactive',
          '--set',
          `token=${secret}`,
          '--result',
          resultFile,
        ],
        secret,
        exitCode: 4,
        files: [resultFile],
        exact: [jsonEscaped(resolve(secret))],
      };
    },
  },
  {
    // §10: the same rule for the values files, whose loader has always named its argument.
    name: 'a values-file load diagnostic',
    build: (directory, spell) => {
      const valuesFile = join(directory, 'values.yaml');
      writeFileSync(valuesFile, '- not a mapping\n', 'utf8');
      const secret = spell(valuesFile);
      return {
        argv: [
          'run',
          writeManifest(directory),
          '--non-interactive',
          '--values',
          secret,
          '--set',
          `token=${secret}`,
        ],
        secret,
        exitCode: 4,
      };
    },
  },
];

/** How a path reads inside a JSON string — the result file, or a JSON-rendered plan value. */
function jsonEscaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** Stands in for a spelling §10 keeps exact, so the surrounding content stays scannable. */
const EXEMPT = '<exact by contract>';

/** Every spelling of the secret that would disclose it if it reached a sink. */
function disclosingSpellings(secret: string): readonly string[] {
  const anchored = resolve(secret);
  return [...new Set([secret, anchored, jsonEscaped(secret), jsonEscaped(anchored)])];
}

async function expectNoSpellingInAnySink(scenario: Scenario, spell: Spelling): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'rune-path-spelling-'));
  const subject = scenario.build(directory, spell);
  const io = capture();

  const code = await run([...subject.argv], io);

  expect(code).toBe(subject.exitCode);
  const written = (subject.files ?? []).map((file) =>
    existsSync(file) ? readFileSync(file, 'utf8') : '',
  );
  // A file this run was supposed to write proves the sink was exercised, not skipped.
  expect(written.every((content) => content !== '')).toBe(true);
  const exact = subject.exact ?? [];
  for (const spelling of exact) {
    // An exemption nothing writes would silently widen the allow-list instead of naming it.
    expect(written.join('\n')).toContain(spelling);
  }
  // Only the file is allowed to carry them: stdout and stderr stay under the full guard.
  const guarded = written.map((content) =>
    exact.reduce((rest, spelling) => rest.replaceAll(spelling, EXEMPT), content),
  );
  const sinks = [...io.out, ...io.err, ...guarded].join('\n');
  for (const spelling of disclosingSpellings(subject.secret)) {
    expect(sinks).not.toContain(spelling);
  }
}

describe('paths RUNE names and declared secrets', () => {
  it.each(SCENARIOS)('masks a secret spelled with a "." segment in $name', async (scenario) => {
    await expectNoSpellingInAnySink(scenario, dotSegment);
  });

  it.runIf(process.platform === 'win32').each(SCENARIOS)(
    'masks a secret spelled with forward slashes in $name',
    async (scenario) => {
      await expectNoSpellingInAnySink(scenario, forwardSlash);
    },
  );
});
