/**
 * One guard for a whole defect class (docs/architecture.md §10, "Path spellings").
 *
 * RUNE anchors, resolves and normalizes the paths an operator hands it, but a secret registry
 * holds exactly the bytes the operator supplied. Every output that names a RUNE-derived
 * spelling therefore meets masks that cannot match it and prints the secret in the clear.
 *
 * Each scenario below declares a `secret` input whose value *is* the path RUNE will name,
 * spelled so that RUNE rewrites it — `SPELLINGS` covers all four derivations §10 forbids:
 * anchoring, resolving and normalizing through a "." segment or a win32 forward slash, and
 * escaping through a control character. The one assertion helper checks every sink the run
 * touches — stdout, stderr, the log file and the result file — for the supplied spelling, the
 * resolved spelling, and their JSON- and control-escaped forms. Adding a path-bearing output
 * means adding one entry to `SCENARIOS`, not a new test.
 *
 * §10 exempts exactly one field: the structured `manifest.path` of a plan or a result keeps
 * RUNE's resolved spelling, because it is machine identity. A scenario names that FIELD in
 * `exemptFields`, and the helper asserts the field really holds the resolved spelling before
 * blanking it and scanning everything else. Keying on the field rather than on its bytes is
 * what makes it an allow-list: the same spelling leaking from any other field still fails.
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

/** Rewrites an absolute path into a spelling RUNE rewrites again before a sink sees it. */
type Rewrite = (path: string) => string;

interface Spelling {
  readonly name: string;
  readonly rewrite: Rewrite;
  /** Limits the spelling to the one host that rewrites it. */
  readonly platform?: NodeJS.Platform;
  /**
   * True when no host stores such a path portably, so it runs only against scenarios that
   * merely report the path. Those never open it, and the spelling exercises §10's fourth
   * derivation — escaping — instead of anchoring.
   */
  readonly unopenable?: true;
}

const SPELLINGS: readonly Spelling[] = [
  {
    // Platform-neutral: `path.resolve` drops a `.` segment everywhere.
    name: 'a "." segment',
    rewrite: (path) => {
      const cut = path.lastIndexOf(sep);
      return `${path.slice(0, cut)}${sep}.${path.slice(cut)}`;
    },
  },
  {
    // `path.resolve` rewrites every forward slash into a backslash.
    name: 'forward slashes',
    rewrite: (path) => path.replaceAll('\\', '/'),
    platform: 'win32',
  },
  {
    // A terminal sink escapes controls visibly, which is how R12-SEC-1 defeated the mask.
    name: 'a control character',
    rewrite: (path) => path.replace(/([^\\/]+)$/u, 'se\tcret-$1'),
    unopenable: true,
  },
];

interface Run {
  readonly argv: readonly string[];
  /** The declared secret value, which is also the path RUNE is asked to name. */
  readonly secret: string;
  readonly exitCode: number;
  /** Files this run may write; their contents are sinks too. */
  readonly files?: readonly string[];
  /** Dotted JSON fields §10 keeps exact, asserted to hold the resolved spelling, then blanked. */
  readonly exemptFields?: readonly string[];
}

interface Scenario {
  readonly name: string;
  /** True when the run only reports this path, so nothing has to open or read it. */
  readonly reportedOnly?: true;
  readonly build: (directory: string, spell: Rewrite) => Run;
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

/** `logFile` becomes `execution.logFile`, the supplier the CLI uses when no flag is given. */
function writeManifest(
  directory: string,
  inputs: readonly string[] = [],
  logFile?: string,
): string {
  const path = join(directory, 'installer.yaml');
  // Single quotes: a backslash is literal in a single-quoted YAML scalar, an escape in a
  // double-quoted one, so only this spelling reaches the engine as the operator wrote it.
  const execution = logFile === undefined ? [] : ['execution:', `  logFile: '${logFile}'`];
  writeFileSync(path, [...MANIFEST, ...inputs, 'steps: []', ...execution, ''].join('\n'), 'utf8');
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
    reportedOnly: true,
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
    reportedOnly: true,
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
    // §10: `execution.logFile` is the other supplier of that path, and the CLI and the engine
    // derive its precedence separately — so the preview and the diagnostic are pinned to the
    // manifest's own spelling too, and a drift between the two derivations fails one of them.
    name: 'the dry-run plan preview of a manifest log path',
    build: (directory, spell) => {
      const secret = spell(join(directory, 'logs', 'secret-log-1234.log'));
      return {
        argv: [
          'run',
          writeManifest(directory, [], secret),
          '--non-interactive',
          '--dry-run',
          '--set',
          `token=${secret}`,
        ],
        secret,
        exitCode: 0,
      };
    },
  },
  {
    // §10: the RUNE-406 diagnostic for that supplier names that same manifest spelling.
    name: 'the RUNE-406 diagnostic for a manifest log path',
    build: (directory, spell) => {
      const secret = spell(blocked(directory, 'secret-log-1234.log'));
      return {
        argv: [
          'run',
          writeManifest(directory, [], secret),
          '--non-interactive',
          '--set',
          `token=${secret}`,
        ],
        secret,
        exitCode: 1,
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
    reportedOnly: true,
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
        exemptFields: ['manifest.path'],
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
        exemptFields: ['manifest.path'],
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

/** Stands in for a field §10 keeps exact, so the surrounding content stays scannable. */
const EXEMPT = '<exact by contract>';

/** Reads a dotted field out of a parsed result document; undefined when the path is absent. */
function fieldAt(document: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    return typeof node === 'object' && node !== null
      ? (node as Record<string, unknown>)[key]
      : undefined;
  }, document);
}

/** Blanks a dotted field in place, so every other field stays under the full guard. */
function blankFieldAt(document: unknown, path: string): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = fieldAt(document, keys.join('.'));
  (parent as Record<string, unknown>)[last] = EXEMPT;
}

/** How a terminal sink prints a path: RUNE escapes controls visibly and leaves the rest. */
function controlEscaped(text: string): string {
  return [...text]
    .map((character) => (character < ' ' ? jsonEscaped(character) : character))
    .join('');
}

/** Every spelling of the secret that would disclose it if it reached a sink. */
function disclosingSpellings(secret: string): readonly string[] {
  const anchored = resolve(secret);
  const spellings = [secret, anchored];
  return [
    ...new Set([...spellings, ...spellings.map(jsonEscaped), ...spellings.map(controlEscaped)]),
  ];
}

async function expectNoSpellingInAnySink(scenario: Scenario, spell: Rewrite): Promise<void> {
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
  const exemptFields = subject.exemptFields ?? [];
  // Only a written file may carry an exempt field: stdout and stderr stay under the full guard.
  const guarded = written.map((content) => {
    if (exemptFields.length === 0) {
      return content;
    }
    const document: unknown = JSON.parse(content);
    for (const field of exemptFields) {
      // An exemption the field does not actually hold would widen the allow-list silently.
      expect(fieldAt(document, field)).toBe(resolve(subject.secret));
      blankFieldAt(document, field);
    }
    return JSON.stringify(document);
  });
  const sinks = [...io.out, ...io.err, ...guarded].join('\n');
  for (const spelling of disclosingSpellings(subject.secret)) {
    expect(sinks).not.toContain(spelling);
  }
}

describe('paths RUNE names and declared secrets', () => {
  for (const spelling of SPELLINGS) {
    const scenarios = SCENARIOS.filter(
      (scenario) => spelling.unopenable !== true || scenario.reportedOnly === true,
    );
    it
      .runIf(spelling.platform === undefined || spelling.platform === process.platform)
      .each(scenarios)(
      `masks a secret spelled with ${spelling.name} in $name`,
      async (scenario) => {
        await expectNoSpellingInAnySink(scenario, spelling.rewrite);
      },
    );
  }
});
