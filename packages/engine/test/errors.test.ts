import { describe, expect, it } from 'vitest';

import {
  CancelledError,
  ConditionError,
  ExecutionError,
  exitCodeFor,
  formatIssues,
  formatRuneError,
  InputError,
  InternalError,
  ManifestError,
  PlatformError,
  projectRuneError,
  ResolutionError,
  RuneError,
  UsageError,
  type RuneCode,
  type RuneIssue,
  withIssueDiagnosticParts,
} from '../src/errors.js';
import { formatDiagnostic, quotedDiagnostic } from '../src/diagnostics.js';
import { SecretRegistry } from '../src/engine/secrets.js';

/** Every code of docs/architecture.md §7 with the exit code §10 assigns to it. */
const EXPECTED_EXIT_CODES: ReadonlyArray<readonly [RuneCode, number]> = [
  ['RUNE-001', 2],
  ['RUNE-002', 2],
  ['RUNE-101', 3],
  ['RUNE-102', 3],
  ['RUNE-103', 3],
  ['RUNE-104', 3],
  ['RUNE-201', 4],
  ['RUNE-202', 4],
  ['RUNE-203', 4],
  ['RUNE-301', 5],
  ['RUNE-302', 5],
  ['RUNE-311', 5],
  ['RUNE-312', 5],
  ['RUNE-401', 1],
  ['RUNE-402', 1],
  ['RUNE-403', 1],
  ['RUNE-404', 1],
  ['RUNE-405', 1],
  ['RUNE-406', 1],
  ['RUNE-407', 1],
  ['RUNE-500', 70],
  ['RUNE-601', 6],
];

describe('exit codes', () => {
  it.each(EXPECTED_EXIT_CODES)('maps %s to exit %i', (code, expected) => {
    expect(exitCodeFor(new RuneError(code, 'boom'))).toBe(expected);
  });

  it('maps every error class to its documented code family', () => {
    expect(exitCodeFor(new UsageError('bad flag'))).toBe(2);
    expect(exitCodeFor(new PlatformError('unsupported host'))).toBe(2);
    expect(exitCodeFor(new ManifestError('RUNE-103', 'bad manifest'))).toBe(3);
    expect(exitCodeFor(new InputError('RUNE-201', 'missing'))).toBe(4);
    expect(exitCodeFor(new ResolutionError('RUNE-301', 'undefined variable'))).toBe(5);
    expect(exitCodeFor(new ConditionError('RUNE-312', 'type error'))).toBe(5);
    expect(exitCodeFor(new ExecutionError('RUNE-401', 'step failed'))).toBe(1);
    expect(exitCodeFor(new CancelledError())).toBe(6);
    expect(exitCodeFor(new InternalError('unreachable'))).toBe(70);
  });

  it('treats anything that is not a RuneError as an internal error', () => {
    expect(exitCodeFor(new TypeError('undefined is not a function'))).toBe(70);
    expect(exitCodeFor('a thrown string')).toBe(70);
    expect(exitCodeFor(undefined)).toBe(70);
  });
});

describe('RuneError', () => {
  it.each([
    ['Named', 'message', 'Named: message'],
    ['Named', '', 'Named'],
    ['', 'message', 'message'],
    ['', '', ''],
  ])(
    'preserves native RuneError header semantics for name=%j message=%j',
    (name, message, header) => {
      const original = new InputError('RUNE-202', message);
      original.name = name;
      original.stack = `${header}\n    at rune-frame`;

      const projected = projectRuneError(original, new SecretRegistry());

      expect(projected.name).toBe(name);
      expect(projected.message).toBe(message);
      expect(String(projected)).toBe(header);
      expect(projected.stack).toBe(`${header}\n    at rune-frame`);
    },
  );

  it.each([
    ['Named', 'message', 'Named: message'],
    ['Named', '', 'Named'],
    ['', 'message', 'message'],
    ['', '', ''],
  ])('preserves native cause header semantics for name=%j message=%j', (name, message, header) => {
    const cause = new Error(message);
    cause.name = name;
    cause.stack = `${header}\n    at cause-frame`;

    const projected = projectRuneError(
      new InputError('RUNE-202', 'parent', { cause }),
      new SecretRegistry(),
    );
    const projectedCause = projected.cause as Error;

    expect(projectedCause.name).toBe(name);
    expect(projectedCause.message).toBe(message);
    expect(String(projectedCause)).toBe(header);
    expect(projectedCause.stack).toBe(`${header}\n    at cause-frame`);
  });

  it('carries code, location and a single issue by default', () => {
    const location = { file: 'installer.yaml', line: 7, column: 3 };
    const error = new ManifestError('RUNE-104', 'step ids must be unique', { location });

    expect(error).toBeInstanceOf(RuneError);
    expect(error.name).toBe('ManifestError');
    expect(error.code).toBe('RUNE-104');
    expect(error.location).toEqual(location);
    expect(error.issues).toEqual([
      { code: 'RUNE-104', message: 'step ids must be unique', location },
    ]);
  });

  it('keeps the cause when one is given', () => {
    const cause = new Error('ENOENT');
    expect(new ManifestError('RUNE-101', 'cannot read', { cause }).cause).toBe(cause);
  });

  it('projects the complete InternalError text once, including its fixed suffix and stack', () => {
    const marker = 'RUNE';
    const secrets = new SecretRegistry();
    secrets.register(marker);
    const originalCause = new Error(`cause contains ${marker}`);
    const original = new InternalError(`detail contains ${marker}`, { cause: originalCause });

    const projected = projectRuneError(original, secrets);

    expect(projected).toBeInstanceOf(InternalError);
    expect(projected.code).toBe('RUNE-500');
    expect(projected.message).not.toContain(marker);
    expect(projected.stack).not.toContain(marker);
    expect(projected.issues[0]?.message).not.toContain(marker);
    expect(projected.message.match(/this is a bug/g)).toHaveLength(1);
    expect(projected.cause).toBeInstanceOf(Error);
    expect(projected.cause).not.toBe(originalCause);
    expect((projected.cause as Error).message).not.toContain(marker);
  });

  it('retains PlatformError taxonomy while projecting sink text', () => {
    const secrets = new SecretRegistry();
    secrets.register('secret');
    const projected = projectRuneError(new PlatformError('unsupported secret-host'), secrets);

    expect(projected).toBeInstanceOf(PlatformError);
    expect(projected.code).toBe('RUNE-002');
    expect(projected.message).toBe('unsupported ***-host');
  });

  it('masks composed stack headers and generic cause names recursively', () => {
    const runeHeaderSecret = 'InputError: problem';
    const causeHeaderSecret = 'Error: cause text';
    const causeNameSecret = `direct\u001bname`;
    const secrets = new SecretRegistry();
    for (const secret of [runeHeaderSecret, causeHeaderSecret, 'Error: ***', causeNameSecret]) {
      secrets.register(secret);
    }
    const namedCause = new Error('nested text');
    namedCause.name = causeNameSecret;
    const cause = new Error('cause text', { cause: namedCause });

    const projected = projectRuneError(new InputError('RUNE-202', 'problem', { cause }), secrets);
    const projectedCause = projected.cause as Error;
    const projectedNamedCause = projectedCause.cause as Error;

    expect(projected.stack).not.toContain(runeHeaderSecret);
    expect(String(projected)).toBe('problem');
    expect(String(projectedCause)).toBe('cause text');
    expect(projectedCause.stack).not.toContain(causeHeaderSecret);
    expect(projectedNamedCause.name).toBe('***');
    expect(projectedNamedCause.stack).not.toContain(causeNameSecret);
    expect(projectedNamedCause.stack).not.toContain('direct\\u001bname');
  });

  it('masks a projected diagnostic before escaping a location-message boundary', () => {
    const secret = `1: \u001binput`;
    const visibleSecret = '1: \\u001binput';
    const secrets = new SecretRegistry();
    secrets.register(secret);
    secrets.register('***:1:1: ***');
    const location = { file: 'installer.yaml', line: 1, column: 1 };
    const projected = projectRuneError(
      new InputError('RUNE-201', `\u001binput\u0085tail\u2028end`, { location }),
      secrets,
    );

    expect(projected.location).toBeUndefined();
    expect(projected.issues[0]?.location).toBeUndefined();
    expect(projected.message).toBe(formatIssues(projected.issues));
    expect(formatIssues(projected.issues)).not.toContain(secret);
    expect(formatIssues(projected.issues)).not.toContain(visibleSecret);
    expect(formatRuneError(projected)).toBe(projected.message);
    expect(formatRuneError(projected)).not.toContain(secret);
    expect(formatRuneError(projected)).not.toContain(visibleSecret);
  });

  it('binds a location-only match to public projected issue formatting', () => {
    const secret = 'installer.yaml:1:1';
    const secrets = new SecretRegistry();
    secrets.register(secret);
    const location = { file: 'installer.yaml', line: 1, column: 1 };

    const projected = projectRuneError(
      new InputError('RUNE-201', 'input is missing', { location }),
      secrets,
    );

    expect(projected).toBeInstanceOf(InputError);
    expect(projected.location).toBeUndefined();
    expect(projected.issues).toHaveLength(1);
    expect(formatRuneError(projected)).toBe(projected.message);
    expect(formatIssues(projected.issues)).toBe(projected.message);
    expect(formatIssues(projected.issues)).not.toContain(secret);
  });

  it('retains raw quoted issue parts until location-message projection', () => {
    const secret = `1:1: "A"B\\C`;
    const visibleSecret = '1:1: "A\\"B\\\\C';
    const secrets = new SecretRegistry();
    secrets.register(secret);
    const location = { file: 'installer.yaml', line: 1, column: 1 };
    const parts = [quotedDiagnostic('A"B\\CTAIL')];
    const issue = withIssueDiagnosticParts(
      { code: 'RUNE-202', message: formatDiagnostic(parts), location },
      parts,
    );
    const originalCause = new Error('safe cause');
    const original = new InputError('RUNE-202', formatIssues([issue]), {
      location,
      issues: [issue],
      cause: originalCause,
    });

    const projected = projectRuneError(original, secrets);

    expect(projected).toBeInstanceOf(InputError);
    expect(projected.code).toBe('RUNE-202');
    expect(projected.location).toBeUndefined();
    expect(projected.issues).toHaveLength(1);
    expect(projected.cause).toBeInstanceOf(Error);
    for (const diagnostic of [formatRuneError(projected), formatIssues(projected.issues)]) {
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(visibleSecret);
    }
    expect(formatRuneError(projected)).toBe(projected.message);
    expect(formatIssues(projected.issues)).toBe(projected.message);
  });

  it('uses a stable canonical issue when numeric location fields contain a secret', () => {
    const secrets = new SecretRegistry();
    secrets.register('1:10');
    const projected = projectRuneError(
      InputError.fromIssues('RUNE-202', [
        {
          code: 'RUNE-202',
          message: 'invalid',
          location: { file: 'installer.yaml', line: 1, column: 10 },
        },
        {
          code: 'RUNE-202',
          message: 'still located',
          location: { file: 'installer.yaml', line: 2, column: 1 },
        },
      ]),
      secrets,
    );

    const cloned = structuredClone(projected.issues[0]!);
    expect(cloned.location).toBeUndefined();
    expect(formatIssues([cloned])).toBe(projected.issues[0]?.message);
    expect(projected.message).not.toContain('1:10');
    expect(projected.location).toBe(projected.issues[1]?.location);
  });

  it('keeps aggregate public diagnostics identical through cross-record masking', () => {
    const secrets = new SecretRegistry();
    secrets.register('AAAA\nBBBB');
    const projected = projectRuneError(
      InputError.fromIssues('RUNE-202', [
        { code: 'RUNE-202', message: 'AAAA', location: undefined },
        { code: 'RUNE-202', message: 'BBBB', location: undefined },
      ]),
      secrets,
    );

    expect(projected.issues).toHaveLength(2);
    expect(projected.message).toBe(formatRuneError(projected));
    expect(projected.message).toBe(formatIssues(projected.issues));
    expect(projected.message.match(/\n/gu)).toHaveLength(1);
  });

  it('derives top-level location from the first projected issue that remains located', () => {
    const secrets = new SecretRegistry();
    secrets.register(`1: \u001binput`);
    const projected = projectRuneError(
      InputError.fromIssues('RUNE-202', [
        {
          code: 'RUNE-202',
          message: `\u001binput`,
          location: { file: 'values.yaml', line: 1, column: 1 },
        },
        {
          code: 'RUNE-202',
          message: 'second',
          location: { file: 'values.yaml', line: 2, column: 1 },
        },
      ]),
      secrets,
    );

    expect(projected.issues[0]?.location).toBeUndefined();
    expect(projected.issues[1]?.location).toEqual({ file: 'values.yaml', line: 2, column: 1 });
    expect(projected.location).toBe(projected.issues[1]?.location);
  });

  it('makes RuneError stringification safe when its class-message header is secret', () => {
    const secret = `InputError: \u001binput`;
    const secrets = new SecretRegistry();
    secrets.register(secret);
    const projected = projectRuneError(new InputError('RUNE-202', `\u001binput`), secrets);

    expect(projected).toBeInstanceOf(InputError);
    expect(String(projected)).toBe(projected.message);
    expect(String(projected)).not.toContain(secret);
    expect(String(projected)).not.toContain('InputError: \\u001binput');
    expect(projected.stack).not.toContain(secret);
  });

  it('rejects secrets created by error, cause and stack rendering', () => {
    const renderedSecret = String.raw`\u001b`;
    const secrets = new SecretRegistry();
    secrets.register(renderedSecret);

    const genericCause = new Error('\u001b', { cause: '\u001b' });
    genericCause.stack = `Error: \u001b\n    at cause-\u001b`;
    const errors = [
      new InputError('RUNE-202', '\u001b'),
      new InputError('RUNE-202', '\u001b', {
        issues: [{ code: 'RUNE-202', message: 'different', location: undefined }],
      }),
      new InternalError('\u001b'),
      new InputError('RUNE-202', 'parent', { cause: genericCause }),
      new InputError('RUNE-202', 'parent', { cause: '\u001b' }),
    ];
    errors[0]!.stack = `InputError: \u001b\n    at rune-\u001b`;

    for (const original of errors) {
      const projected = projectRuneError(original, secrets);
      const surfaces = [projected.message, String(projected), projected.stack ?? ''];
      if (projected.cause instanceof Error) {
        surfaces.push(
          projected.cause.message,
          String(projected.cause),
          projected.cause.stack ?? '',
          String(projected.cause.cause ?? ''),
        );
      } else {
        surfaces.push(String(projected.cause ?? ''));
      }
      expect(surfaces.join('\n')).not.toContain(renderedSecret);
    }

    const projected = projectRuneError(errors[0]!, secrets);
    const copies = [structuredClone(projected.issues[0]!), { ...projected.issues[0]! }];
    const dynamic = JSON.parse(JSON.stringify({ dynamic: projected.issues[0]!.message })) as {
      readonly dynamic: string;
    };
    expect([...copies.map((issue) => issue.message), dynamic.dynamic].join('\n')).not.toContain(
      renderedSecret,
    );
    expect(projected.stack).toBe(`${String(projected)}\n`);
    const projectedCause = projectRuneError(errors[3]!, secrets).cause as Error;
    expect(projectedCause.stack).toBe(`${String(projectedCause)}\n`);
  });

  it.each([
    [String.raw`\"\"`, '""'],
    [String.raw`\ud800`, '\ud800'],
    [String.raw`\udfff`, '\udfff'],
  ])('keeps projected issue JSON string content free of %s', (secret, value) => {
    const secrets = new SecretRegistry();
    secrets.register(secret);
    const projected = projectRuneError(new InputError('RUNE-202', value), secrets);
    const copies = [structuredClone(projected.issues[0]!), { ...projected.issues[0]! }];

    for (const dynamic of [projected.message, ...copies.map((issue) => issue.message)]) {
      expect(JSON.stringify(dynamic).slice(1, -1)).not.toContain(secret);
    }
  });

  it('drops stack frames when the final header-suffix composition is a secret', () => {
    const secrets = new SecretRegistry();
    secrets.register('safeTAIL');
    const original = new InputError('RUNE-202', 'safe');
    original.stack = 'InputError: safeTAIL\n    at frame';

    const projected = projectRuneError(original, secrets);

    expect(projected.stack).toBe('InputError: safe\n');
    expect(projected.stack?.split('\n')).toEqual(['InputError: safe', '']);
    expect(projected.stack).not.toContain('safeTAIL');
  });

  it('retains the safe RuneError header when its optional stack LF is a secret', () => {
    const secrets = new SecretRegistry();
    const renderedSecret = String.raw`InputError: safe***\n`;
    secrets.register('TAIL');
    secrets.register(renderedSecret);
    const original = new InputError('RUNE-202', 'safeTAIL');
    original.stack = 'InputError: safeTAIL\n    at frame';

    const projected = projectRuneError(original, secrets);
    const jsonContent = JSON.stringify(projected.stack).slice(1, -1);

    expect(projected.stack).toBe(String(projected));
    expect(projected.stack).not.toContain('TAIL');
    expect(projected.stack).not.toContain(renderedSecret);
    expect(jsonContent).not.toContain(renderedSecret);
  });

  it('retains the safe generic cause header through the same fallback', () => {
    const secrets = new SecretRegistry();
    const renderedSecret = String.raw`Error: safe***\n`;
    secrets.register('TAIL');
    secrets.register(renderedSecret);
    const cause = new Error('safeTAIL');
    cause.stack = 'Error: safeTAIL\n    at frame';

    const projected = projectRuneError(new InputError('RUNE-202', 'parent', { cause }), secrets)
      .cause as Error;
    const jsonContent = JSON.stringify(projected.stack).slice(1, -1);

    expect(projected.stack).toBe(String(projected));
    expect(projected.stack).not.toContain('TAIL');
    expect(projected.stack).not.toContain(renderedSecret);
    expect(jsonContent).not.toContain(renderedSecret);
  });

  it('retains issue LFs while dropping an unsafe optional stack-frame LF', () => {
    const secrets = new SecretRegistry();
    const renderedSecret = String.raw`zzTAIL\n`;
    secrets.register(renderedSecret);
    const original = InputError.fromIssues(
      'RUNE-202',
      ['aaa', 'zzTAIL'].map((message) => ({
        code: 'RUNE-202' as const,
        message,
        location: undefined,
      })),
    );
    original.stack = `${String(original)}\n    at frame`;

    const projected = projectRuneError(original, secrets);
    const jsonContent = JSON.stringify(projected.stack).slice(1, -1);

    expect(projected.stack).toBe(String(projected));
    expect(projected.stack?.split('\n')).toHaveLength(2);
    expect(projected.stack).not.toContain(renderedSecret);
    expect(jsonContent).not.toContain(renderedSecret);
  });

  it('keeps projected issue cardinality through fallback collisions', () => {
    const protectedTexts = ['AAAA\nBBBB\nCCCC', String.raw`***\n\n`, String.raw`\n\n`];
    const secrets = new SecretRegistry();
    for (const secret of protectedTexts) secrets.register(secret);
    const projected = projectRuneError(
      InputError.fromIssues(
        'RUNE-202',
        ['AAAA', 'BBBB', 'CCCC'].map((message) => ({
          code: 'RUNE-202' as const,
          message,
          location: undefined,
        })),
      ),
      secrets,
    );
    const diagnostic = formatIssues(projected.issues);
    const jsonContent = JSON.stringify(diagnostic).slice(1, -1);

    expect(projected.issues).toHaveLength(3);
    expect(diagnostic).toBe(projected.message);
    expect(diagnostic.split('\n')).toHaveLength(3);
    for (const secret of protectedTexts) {
      expect(diagnostic).not.toContain(secret);
      expect(jsonContent).not.toContain(secret);
    }
  });

  it('retains LF topology for RuneError and cause stacks with unknown headers', () => {
    const cause = new Error('cause');
    cause.stack = 'custom cause\r\n\ncause frame';
    const original = new InputError('RUNE-202', 'rune', { cause });
    original.stack = 'custom rune\r\n\nrune frame';

    const projected = projectRuneError(original, new SecretRegistry());
    const projectedCause = projected.cause as Error;

    expect(projected.stack).toBe('custom rune\\r\n\nrune frame');
    expect(projectedCause.stack).toBe('custom cause\\r\n\ncause frame');
    expect(projected.stack?.match(/\n/gu)).toHaveLength(2);
    expect(projectedCause.stack?.match(/\n/gu)).toHaveLength(2);
  });

  it('collects many issues into one error whose message lists them all', () => {
    const issues: RuneIssue[] = [
      {
        code: 'RUNE-104',
        message: 'first problem',
        location: { file: 'a.yaml', line: 2, column: 1 },
      },
      { code: 'RUNE-104', message: 'second problem', location: undefined },
    ];

    const error = ManifestError.fromIssues('RUNE-104', issues);

    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe('a.yaml:2:1: first problem\nsecond problem');
  });

  it('refuses to build an error out of nothing', () => {
    expect(() => ManifestError.fromIssues('RUNE-104', [])).toThrow(InternalError);
  });
});

describe('InputError batches', () => {
  it('orders located issues before exposing their message and top-level location', () => {
    const lineOne = {
      code: 'RUNE-202' as const,
      message: 'line one',
      location: { file: 'values.yaml', line: 1, column: 1 },
    };
    const lineTwo = {
      code: 'RUNE-202' as const,
      message: 'line two',
      location: { file: 'values.yaml', line: 2, column: 1 },
    };

    const error = InputError.fromIssues('RUNE-202', [lineTwo, lineOne]);

    expect(error.issues).toEqual([lineOne, lineTwo]);
    expect(error.message).toBe('values.yaml:1:1: line one\nvalues.yaml:2:1: line two');
    expect(error.location).toEqual(lineOne.location);
  });

  it('uses the first located issue for the top-level location', () => {
    const unlocated = {
      code: 'RUNE-203' as const,
      message: 'unknown override',
      location: undefined,
    };
    const located = {
      code: 'RUNE-202' as const,
      message: 'invalid value',
      location: { file: 'values.yaml', line: 1, column: 1 },
    };

    const error = InputError.fromIssues('RUNE-202', [located, unlocated]);

    expect(error.issues).toEqual([unlocated, located]);
    expect(error.message).toBe('unknown override\nvalues.yaml:1:1: invalid value');
    expect(error.location).toEqual(located.location);
  });
});

describe('formatIssues', () => {
  it('prefixes located issues and leaves the others alone', () => {
    expect(
      formatIssues([
        { code: 'RUNE-103', message: 'located', location: { file: 'f.yaml', line: 1, column: 2 } },
        { code: 'RUNE-103', message: 'unlocated', location: undefined },
      ]),
    ).toBe('f.yaml:1:2: located\nunlocated');
  });

  it('formats an ordinary RuneError from its issues', () => {
    const error = new ManifestError('RUNE-103', 'invalid', {
      location: { file: 'installer.yaml', line: 2, column: 3 },
    });

    expect(formatRuneError(error)).toBe('installer.yaml:2:3: invalid');
  });
});
