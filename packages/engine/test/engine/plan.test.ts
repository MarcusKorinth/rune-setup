import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { resolveInputs, type Resolution } from '../../src/engine/inputs.js';
import {
  buildPlan as buildPlanWithLocale,
  PLAN_SCHEMA_VERSION,
  type ExecutionPlan,
  type PlanOptions,
} from '../../src/engine/plan.js';
import {
  isSecretString,
  MASK,
  MAX_SECRET_REGISTRY_CODE_UNITS,
  secretValuesEqual,
} from '../../src/engine/secrets.js';
import { ExecutionError, InputError, InternalError } from '../../src/errors.js';
import { parseManifest, parseManifestText } from '../../src/manifest/index.js';
import type { ManifestV1 } from '../../src/manifest/v1/schema.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];
const TEST_LOCALE = 'en';

function buildPlan(
  options: Omit<PlanOptions, 'locale'> & { readonly locale?: string },
): ExecutionPlan {
  return buildPlanWithLocale({ ...options, locale: options.locale ?? TEST_LOCALE });
}

function planFor(
  lines: readonly string[],
  options: {
    platform?: 'windows' | 'linux';
    overrides?: ReadonlyMap<string, string>;
    environment?: Record<string, string>;
  } = {},
): {
  plan: ExecutionPlan;
  manifest: ManifestV1;
  resolution: Resolution;
  context: ReturnType<typeof createRuntimeContext>;
} {
  const manifest = parseManifestText([...HEAD, ...lines, ''].join('\n'), 'installer.yaml', {
    manifestDir: '/project',
  });
  const context = createRuntimeContext({
    manifestDir: '/project',
    product: manifest.product,
    platform: options.platform ?? 'linux',
    environment: options.environment ?? {},
  });
  const resolution = resolveInputs({
    manifest,
    context,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });
  return {
    plan: buildPlan({ manifest, resolution, context, locale: TEST_LOCALE }),
    manifest,
    resolution,
    context,
  };
}

describe('platform selection', () => {
  const lines = [
    'steps:',
    '  - id: both',
    '    run:',
    '      command: node',
    '  - id: windows-only',
    '    run:',
    '      windows:',
    '        command: pwsh',
  ];

  it('runs a plain command everywhere and skips a step with no block for the platform', () => {
    const { plan } = planFor(lines, { platform: 'linux' });

    expect(plan.steps[0]?.state).toBe('PENDING');
    expect(plan.steps[1]).toMatchObject({
      state: 'SKIPPED',
      skipReason: 'no run block for platform',
    });
  });

  it('picks the block of the planned platform', () => {
    const { plan } = planFor(lines, { platform: 'windows' });

    expect(plan.steps[1]?.state).toBe('PENDING');
  });
});

describe('conditions', () => {
  it('skips a step whose condition is false, and says which condition', () => {
    const { plan } = planFor([
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: db',
      '    when: "${installDatabase}"',
      '    run:',
      '      command: node',
    ]);

    expect(plan.steps[0]).toMatchObject({
      state: 'SKIPPED',
      skipReason: 'condition false: ${installDatabase}',
    });
  });

  it('keeps a step whose condition holds', () => {
    const { plan } = planFor([
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    default: true',
      'steps:',
      '  - id: db',
      '    when: "${installDatabase}"',
      '    run:',
      '      command: node',
    ]);

    expect(plan.steps[0]?.state).toBe('PENDING');
  });
});

describe('input completeness', () => {
  it('reports every missing required input before interpolating any step', () => {
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  first:',
        '    type: text',
        '  second:',
        '    type: directory',
        'steps:',
        '  - id: unreachable',
        '    run:',
        '      command: node',
        '      args: ["${env.NEVER_SET}"]',
        '',
      ].join('\n'),
      'installer.yaml',
      { manifestDir: '/project' },
    );
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: 'linux',
      environment: {},
    });
    const resolution = resolveInputs({ manifest, context });

    const error = planningError(manifest, resolution, context);
    expect(error.code).toBe('RUNE-201');
    expect(error.issues).toEqual([
      {
        code: 'RUNE-201',
        message: 'required input "first" is missing',
        location: undefined,
      },
      {
        code: 'RUNE-201',
        message: 'required input "second" is missing',
        location: undefined,
      },
    ]);
  });

  it('rejects invalid values that a frontend collected for correction', () => {
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  port:',
        '    type: text',
        '    pattern: "[0-9]{2,5}"',
        'steps: []',
        '',
      ].join('\n'),
      'installer.yaml',
      { manifestDir: '/project' },
    );
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: 'linux',
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      overrides: new Map([['port', 'not-a-number']]),
      invalidValues: 'collect',
    });

    const error = planningError(manifest, resolution, context);
    expect(error.code).toBe('RUNE-202');
    expect(error.issues[0]).toBe(resolution.problems[0]);
    expect(error.issues.map((issue) => issue.code)).toEqual(['RUNE-202', 'RUNE-201']);
  });

  it('does not report an optional collected invalid value as additionally missing', () => {
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  port:',
        '    type: text',
        '    required: false',
        '    pattern: "[0-9]{2,5}"',
        'steps: []',
        '',
      ].join('\n'),
      'installer.yaml',
      { manifestDir: '/project' },
    );
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: 'linux',
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      overrides: new Map([['port', 'not-a-number']]),
      invalidValues: 'collect',
    });

    const error = planningError(manifest, resolution, context);
    expect(error.code).toBe('RUNE-202');
    expect(error.issues).toEqual([resolution.problems[0]]);
  });

  it('keeps collected problems and every missing input in stable order', () => {
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  port:',
        '    type: text',
        '    pattern: "[0-9]+"',
        '  target:',
        '    type: directory',
        'steps: []',
        '',
      ].join('\n'),
      'installer.yaml',
      { manifestDir: '/project' },
    );
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: 'linux',
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      overrides: new Map([['port', 'not-a-number']]),
      invalidValues: 'collect',
    });

    const error = planningError(manifest, resolution, context);
    expect(error.code).toBe('RUNE-202');
    expect(error.issues.map((issue) => issue.message)).toEqual([
      resolution.problems[0]?.message,
      'required input "port" is missing',
      'required input "target" is missing',
    ]);
  });
});

describe('interpolation into the command', () => {
  it('renders inputs, built-ins and the environment into argv, cwd and env', () => {
    const { plan } = planFor(
      [
        'inputs:',
        '  target:',
        '    type: directory',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["--dir", "${target}", "${env.EXTRA}"]',
        '      cwd: "${target}"',
        '      env:',
        '        DEST: "${target}/bin"',
      ],
      { overrides: new Map([['target', '/opt/app']]), environment: { EXTRA: '-v' } },
    );

    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command).toMatchObject({
      argv: ['node', '--dir', '/opt/app', '-v'],
      cwd: '/opt/app',
      env: { DEST: '/opt/app/bin' },
      timeoutSeconds: null,
      successExitCodes: [0],
    });
  });

  it('anchors a relative script path against the manifest directory, not the cwd', () => {
    const { plan } = planFor([
      'steps:',
      '  - id: install',
      '    run:',
      '      command: scripts/install.sh',
      '      cwd: work',
    ]);

    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[0]).toMatch(
      /^([A-Za-z]:)?[\\/]project[\\/]scripts[\\/]install\.sh$/,
    );
    expect(step?.state === 'PENDING' && step.command.cwd).toMatch(/[\\/]project[\\/]work$/);
  });

  it('translates Windows target separators before anchoring relative command and cwd paths', () => {
    const command = '.\\tools/install.exe';
    const cwd = 'work\\nested/cache';
    const { plan } = planFor(
      [
        'steps:',
        '  - id: install',
        '    run:',
        `      command: '${command}'`,
        `      cwd: '${cwd}'`,
      ],
      { platform: 'windows' },
    );

    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(
      resolvePath('/project', 'tools', 'install.exe'),
    );
    expect(step?.state === 'PENDING' && step.command.cwd).toBe(
      resolvePath('/project', 'work', 'nested', 'cache'),
    );
  });

  it('translates Linux target separators before anchoring relative command and cwd paths', () => {
    const command = './tools/install';
    const cwd = 'work/cache';
    const { plan } = planFor(
      [
        'steps:',
        '  - id: install',
        '    run:',
        `      command: '${command}'`,
        `      cwd: '${cwd}'`,
      ],
      { platform: 'linux' },
    );

    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(
      resolvePath('/project', 'tools', 'install'),
    );
    expect(step?.state === 'PENDING' && step.command.cwd).toBe(
      resolvePath('/project', 'work', 'cache'),
    );
  });

  it('leaves a bare command name to the PATH lookup', () => {
    const { plan } = planFor(['steps:', '  - id: a', '    run:', '      command: pwsh']);

    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[0]).toBe('pwsh');
    expect(step?.state === 'PENDING' && step.command.cwd).toBe('/project');
  });

  it('keeps Windows target absolute command and cwd paths byte-identical', () => {
    const command = 'C:\\tools\\install.exe';
    const cwd = '\\\\server\\share\\work';
    const { plan } = planFor(
      [
        'steps:',
        '  - id: install',
        '    run:',
        `      command: '${command}'`,
        `      cwd: '${cwd}'`,
      ],
      { platform: 'windows' },
    );

    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(command);
    expect(step?.state === 'PENDING' && step.command.cwd).toBe(cwd);
  });

  it
    .runIf(process.platform === 'win32')
    .each([
      '\\tools\\setup.exe',
      '/tools/setup.exe',
      '///tools/setup.exe',
      String.raw`\\\server\share\setup.exe`,
      String.raw`\\server`,
      String.raw`\\?\C:\tools\setup.exe`,
      String.raw`\\.\PhysicalDrive0`,
    ])('refuses the invalid native Windows rooted command %s before anchoring', (command) => {
    const error = executionError(() =>
      planFor(['steps:', '  - id: install', '    run:', `      command: '${command}'`], {
        platform: 'windows',
      }),
    );

    expect(error.code).toBe('RUNE-401');
    expect(error.message).toContain(command);
    expect(error.message).toContain('not a normal fully qualified drive or UNC path');
    expect(error.message).toContain('fully qualified path or a manifest-relative path');
  });

  it
    .runIf(process.platform === 'win32')
    .each([
      '\\private\\setup.exe',
      '/private/setup.exe',
      '///private/setup.exe',
      String.raw`\\private`,
    ])(
    'refuses the opaque invalid native Windows rooted command %s without exposing it',
    (command) => {
      const error = executionError(() =>
        planFor(
          [
            'inputs:',
            '  command:',
            '    type: secret',
            'steps:',
            '  - id: install',
            '    run:',
            '      command: "${command}"',
          ],
          { platform: 'windows', overrides: new Map([['command', command]]) },
        ),
      );
      const diagnostic = `${error.message}\n${JSON.stringify(error)}`;

      expect(error.code).toBe('RUNE-401');
      expect(error.message).toContain(MASK);
      expect(diagnostic).not.toContain(command);
    },
  );

  it
    .runIf(process.platform === 'win32')
    .each([
      '\\private\\work',
      '/private/work',
      '///private/work',
      String.raw`\\\server\share\work`,
      String.raw`\\server`,
      String.raw`\\?\C:\private\work`,
      String.raw`\\.\private`,
    ])('refuses the invalid native Windows rooted cwd %s before anchoring', (cwd) => {
    const error = executionError(() =>
      planFor(
        ['steps:', '  - id: install', '    run:', '      command: node', `      cwd: '${cwd}'`],
        { platform: 'windows' },
      ),
    );

    expect(error.code).toBe('RUNE-404');
    expect(error.message).toContain(cwd);
    expect(error.message).toContain('not a normal fully qualified drive or UNC path');
    expect(error.message).toContain('fully qualified path or a manifest-relative path');
  });

  it
    .runIf(process.platform === 'win32')
    .each(['\\private\\work', '/private/work', '///private/work', String.raw`\\private`])(
    'refuses the opaque invalid native Windows rooted cwd %s without exposing it',
    (cwd) => {
      const error = executionError(() =>
        planFor(
          [
            'inputs:',
            '  cwd:',
            '    type: secret',
            'steps:',
            '  - id: install',
            '    run:',
            '      command: node',
            '      cwd: "${cwd}"',
          ],
          { platform: 'windows', overrides: new Map([['cwd', cwd]]) },
        ),
      );
      const diagnostic = `${error.message}\n${JSON.stringify(error)}`;

      expect(error.code).toBe('RUNE-404');
      expect(error.message).toContain(MASK);
      expect(diagnostic).not.toContain(cwd);
    },
  );

  it.runIf(process.platform === 'win32').each([
    ['C:\\tools\\setup.exe', 'C:\\work'],
    ['C:/tools/setup.exe', 'C:/work'],
    ['\\\\server\\share\\setup.exe', '\\\\server\\share\\work'],
    ['//server/share/setup.exe', '//server/share/work'],
  ] as const)(
    'keeps native Windows fully qualified command %s and cwd byte-identical',
    (command, cwd) => {
      const { plan } = planFor(
        [
          'steps:',
          '  - id: install',
          '    run:',
          `      command: '${command}'`,
          `      cwd: '${cwd}'`,
        ],
        { platform: 'windows' },
      );
      const step = plan.steps[0];

      expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(command);
      expect(step?.state === 'PENDING' && step.command.cwd).toBe(cwd);
    },
  );

  it.runIf(process.platform === 'win32')(
    'continues to anchor a Windows drive-relative cwd instead of rejecting it',
    () => {
      const { plan } = planFor(
        ['steps:', '  - id: install', '    run:', '      command: node', "      cwd: 'C:work'"],
        { platform: 'windows' },
      );

      expect(plan.steps[0]?.state).toBe('PENDING');
    },
  );

  it
    .runIf(process.platform === 'linux')
    .each([
      '\\tools\\setup.exe',
      '/tools/setup.exe',
      '///tools/setup.exe',
      String.raw`\\\server\share\setup.exe`,
      String.raw`\\server`,
      String.raw`\\?\C:\tools\setup.exe`,
    ])('preserves invalid Windows rooted values in a foreign preview for %s', (value) => {
    const { plan } = planFor(
      [
        'steps:',
        '  - id: install',
        '    run:',
        `      command: '${value}'`,
        `      cwd: '${value}'`,
      ],
      { platform: 'windows' },
    );
    const step = plan.steps[0];

    expect(plan.preview).toBe(true);
    expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(value);
    expect(step?.state === 'PENDING' && step.command.cwd).toBe(value);
  });

  it.each(['C:tool.exe', 'D:tools\\install.exe'])(
    'refuses the Windows drive-relative command %s at plan time',
    (command) => {
      const error = executionError(() =>
        planFor(['steps:', '  - id: install', '    run:', `      command: '${command}'`], {
          platform: 'windows',
        }),
      );

      expect(error.code).toBe('RUNE-401');
      expect(error.message).toContain(command);
      expect(error.message).toContain('use an absolute path or a manifest-relative path');
    },
  );

  it('refuses an opaque drive-relative command without exposing its value', () => {
    const secret = 'C:private-tool.exe';
    const error = executionError(() =>
      planFor(
        [
          'inputs:',
          '  command:',
          '    type: secret',
          'steps:',
          '  - id: install',
          '    run:',
          '      command: "${command}"',
        ],
        { platform: 'windows', overrides: new Map([['command', secret]]) },
      ),
    );
    const diagnostic = `${error.message}\n${JSON.stringify(error)}`;

    expect(error.code).toBe('RUNE-401');
    expect(error.message).toContain(MASK);
    expect(diagnostic).not.toContain(secret);
  });

  it('preserves accepted Windows command forms', () => {
    const commands = [
      'node',
      'C:\\tools\\install.exe',
      'C:/tools/install.exe',
      '\\\\server\\share\\install.exe',
    ];

    for (const command of commands) {
      const { plan } = planFor(
        ['steps:', '  - id: install', '    run:', `      command: '${command}'`],
        { platform: 'windows' },
      );
      const step = plan.steps[0];

      expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(command);
    }

    const { plan } = planFor(
      ['steps:', '  - id: install', '    run:', "      command: '.\\tools\\install.exe'"],
      { platform: 'windows' },
    );
    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[0]).toMatch(
      /^([A-Za-z]:)?[\\/]project[\\/]tools[\\/]install\.exe$/,
    );
  });

  it('keeps Linux target absolute command and cwd paths byte-identical', () => {
    const command = '/opt/tools/install';
    const cwd = '/var/lib/example';
    const { plan } = planFor(
      [
        'steps:',
        '  - id: install',
        '    run:',
        `      command: '${command}'`,
        `      cwd: '${cwd}'`,
      ],
      { platform: 'linux' },
    );

    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(command);
    expect(step?.state === 'PENDING' && step.command.cwd).toBe(cwd);
  });

  it('keeps a Windows-looking command bare but anchors cwd for a Linux target', () => {
    const command = 'C:\\tools\\install.exe';
    const cwd = '\\\\server\\share\\work';
    const { plan } = planFor(
      [
        'steps:',
        '  - id: install',
        '    run:',
        `      command: '${command}'`,
        `      cwd: '${cwd}'`,
      ],
      { platform: 'linux' },
    );

    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(command);
    expect(step?.state === 'PENDING' && step.command.cwd).toBe(
      resolvePath('/project', `.${sep}${cwd}`),
    );
  });

  it.each([
    ['linux', 'tool\\name', 'tool\\name'],
    ['linux', 'tool/name', resolvePath('/project', 'tool', 'name')],
    ['windows', 'tool\\name', resolvePath('/project', 'tool', 'name')],
    ['windows', 'tool/name', resolvePath('/project', 'tool', 'name')],
  ] as const)(
    'uses %s target separators to classify the opaque command %s',
    (platform, command, expected) => {
      const { plan } = planFor(
        [
          'inputs:',
          '  command:',
          '    type: secret',
          'steps:',
          '  - id: install',
          '    run:',
          '      command: "${command}"',
        ],
        { platform, overrides: new Map([['command', command]]) },
      );

      const step = plan.steps[0];
      expect(step?.state === 'PENDING' && isSecretString(step.command.argv[0])).toBe(true);
      expect(step?.state === 'PENDING' && secretValuesEqual(step.command.argv[0], expected)).toBe(
        true,
      );
    },
  );
});

describe('the Windows honesty rule', () => {
  const lines = ['steps:', '  - id: legacy', '    run:', '      command: setup.bat'];

  it('refuses a batch file at plan time, with the fix in the message', () => {
    const error = executionError(() => planFor(lines, { platform: 'windows' }));

    expect(error.code).toBe('RUNE-405');
    expect(error.message).toMatch(/needs a shell/);
    expect(error.message).toMatch(/command: cmd/);
  });

  it('does not mind the same file name on linux', () => {
    expect(planFor(lines, { platform: 'linux' }).plan.steps[0]?.state).toBe('PENDING');
  });

  it('refuses an opaque batch command without revealing it in planning or the error', () => {
    let message = '';

    try {
      planFor(
        [
          'inputs:',
          '  command:',
          '    type: secret',
          'steps:',
          '  - id: legacy',
          '    run:',
          '      command: "${command}"',
        ],
        { platform: 'windows', overrides: new Map([['command', 'private-setup.cmd']]) },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('needs a shell');
    expect(message).toContain('***');
    expect(message).not.toContain('private-setup.cmd');
  });

  it('masks registered secret bytes that collide with a literal command path', () => {
    const secret = 'hidden-segment';
    const error = executionError(() =>
      planFor(
        [
          'inputs:',
          '  token:',
          '    type: secret',
          'steps:',
          '  - id: legacy',
          '    run:',
          `      command: tools/${secret}/setup.cmd`,
        ],
        { platform: 'windows', overrides: new Map([['token', secret]]) },
      ),
    );
    const diagnostic = `${error.message}\n${JSON.stringify(error)}`;

    expect(error.code).toBe('RUNE-405');
    expect(diagnostic).not.toContain(secret);
    expect(error.message).toContain(MASK);
    expect(error.message).toContain('command: cmd');
    expect(error.message).toContain('args: ["/c"');
  });

  it('masks a colliding public batch path after normalization', () => {
    const collision = '.\\private/../secret-setup.cmd';
    const derived = resolvePath('/project', 'secret-setup.cmd');
    const error = executionError(() =>
      planFor(
        [
          'inputs:',
          '  token:',
          '    type: secret',
          '  mirror:',
          '    type: text',
          'steps:',
          '  - id: legacy',
          '    run:',
          '      command: "${mirror}"',
        ],
        {
          platform: 'windows',
          overrides: new Map([
            ['token', collision],
            ['mirror', collision],
          ]),
        },
      ),
    );
    const diagnostic = `${error.message}\n${JSON.stringify(error)}`;

    expect(error.code).toBe('RUNE-405');
    expect(diagnostic).not.toContain(collision);
    expect(diagnostic).not.toContain(derived);
    expect(error.message).toContain(MASK);
    expect(error.message).toContain('command: cmd');
  });

  it('masks registered secret bytes that collide with a step id', () => {
    const secret = 'private-step';
    const error = executionError(() =>
      planFor(
        [
          'inputs:',
          '  token:',
          '    type: secret',
          'steps:',
          `  - id: ${secret}`,
          '    run:',
          '      command: setup.cmd',
        ],
        { platform: 'windows', overrides: new Map([['token', secret]]) },
      ),
    );
    const diagnostic = `${error.message}\n${JSON.stringify(error)}`;

    expect(error.code).toBe('RUNE-405');
    expect(diagnostic).not.toContain(secret);
    expect(error.message).toContain(MASK);
    expect(error.message).toContain('command: cmd');
    expect(error.message).toContain('args: ["/c"');
  });
});

describe('derived secret masking in Windows planning diagnostics', () => {
  const relativeSecret = '.\\private/derived-secret';
  const derivedSecret = resolvePath('/project', 'private', 'derived-secret');

  function errorForPublicCollision(field: 'command' | 'cwd', publicValue: string): ExecutionError {
    return executionError(() =>
      planFor(
        [
          'inputs:',
          '  secretPath:',
          '    type: secret',
          '  publicValue:',
          '    type: text',
          'steps:',
          '  - id: register-derived',
          '    run:',
          '      command: node',
          '      cwd: "${secretPath}"',
          '  - id: reject-public',
          '    run:',
          ...(field === 'command'
            ? ['      command: "${publicValue}"']
            : ['      command: node', '      cwd: "${publicValue}"']),
        ],
        {
          platform: 'windows',
          overrides: new Map([
            ['secretPath', relativeSecret],
            ['publicValue', publicValue],
          ]),
        },
      ),
    );
  }

  function expectDerivedSecretMasked(error: ExecutionError, code: ExecutionError['code']): void {
    const surfaces = [
      error.message,
      error.stack ?? '',
      String(error),
      JSON.stringify(error) ?? '',
      inspect(error),
    ].join('\n');

    expect(error.code).toBe(code);
    expect(surfaces).not.toContain(relativeSecret);
    expect(surfaces).not.toContain(derivedSecret);
    expect(surfaces).toContain(MASK);
  }

  it.runIf(process.platform === 'win32')(
    'masks a derived secret in an invalid rooted command diagnostic',
    () => {
      const error = errorForPublicCollision('command', `\\${derivedSecret}`);

      expectDerivedSecretMasked(error, 'RUNE-401');
    },
  );

  it('masks a derived secret in a drive-relative command diagnostic', () => {
    const error = errorForPublicCollision('command', `Z:x${derivedSecret}`);

    expectDerivedSecretMasked(error, 'RUNE-401');
  });

  it.runIf(process.platform === 'win32')(
    'masks a derived secret in an invalid rooted cwd diagnostic',
    () => {
      const error = errorForPublicCollision('cwd', `\\${derivedSecret}`);

      expectDerivedSecretMasked(error, 'RUNE-404');
    },
  );

  it('masks a derived secret in a batch command diagnostic', () => {
    const error = errorForPublicCollision('command', `${derivedSecret}\\setup.cmd`);

    expectDerivedSecretMasked(error, 'RUNE-405');
  });
});

describe('secrets in the plan', () => {
  it('keeps the warning policy for an originally short declared secret', () => {
    const { plan, resolution } = planFor(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        '  mirror:',
        '    type: text',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: deploy',
        '      args: ["${token}", "${mirror}"]',
      ],
      {
        overrides: new Map([
          ['token', 'abc'],
          ['mirror', 'abc'],
        ]),
      },
    );

    expect(resolution.warnings).toEqual([
      'token cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
    expect(plan.resolvedInputs[1]).toMatchObject({ value: 'abc', secret: false });
    const step = plan.steps[0];
    expect(step?.state).toBe('PENDING');
    expect(step?.state === 'PENDING' && step.command.argv[2]).toBe('abc');
    expect(step?.state === 'PENDING' && isSecretString(step.command.argv[2])).toBe(false);
  });

  it('keeps the warning policy for an unchanged absolute secret cwd', () => {
    const root = hostPlatform() === 'windows' ? 'C:\\' : '/';
    const { plan, resolution } = planFor(
      [
        'inputs:',
        '  workingDirectory:',
        '    type: secret',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: deploy',
        '      cwd: "${workingDirectory}"',
      ],
      { platform: hostPlatform(), overrides: new Map([['workingDirectory', root]]) },
    );

    expect(resolution.warnings).toEqual([
      'workingDirectory cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
    const step = plan.steps[0];
    expect(step?.state).toBe('PENDING');
    expect(step?.state === 'PENDING' && secretValuesEqual(step.command.cwd, root)).toBe(true);
  });

  it('keeps the warning policy when a short relative secret cwd becomes maskable', () => {
    const relative = 'abc';
    const expected = resolvePath('/project', `.${sep}${relative}`);
    const { plan, resolution } = planFor(
      [
        'inputs:',
        '  workingDirectory:',
        '    type: secret',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: deploy',
        '      cwd: "${workingDirectory}"',
      ],
      { platform: hostPlatform(), overrides: new Map([['workingDirectory', relative]]) },
    );

    expect(resolution.warnings).toEqual([
      'workingDirectory cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
    const step = plan.steps[0];
    expect(step?.state).toBe('PENDING');
    expect(step?.state === 'PENDING' && secretValuesEqual(step.command.cwd, expected)).toBe(true);
  });

  it('keeps Windows target relative command and cwd normalization opaque and registered', () => {
    const secretPath = '.\\private/work';
    const expected = resolvePath('/project', 'private', 'work');
    const { plan } = planFor(
      [
        'inputs:',
        '  secretPath:',
        '    type: secret',
        '  mirror:',
        '    type: text',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: "${secretPath}"',
        '      cwd: "${secretPath}"',
      ],
      {
        platform: 'windows',
        overrides: new Map([
          ['secretPath', secretPath],
          ['mirror', expected],
        ]),
      },
    );

    const step = plan.steps[0];
    expect(step?.state).toBe('PENDING');
    expect(step?.state === 'PENDING' && isSecretString(step.command.argv[0])).toBe(true);
    expect(step?.state === 'PENDING' && secretValuesEqual(step.command.argv[0], expected)).toBe(
      true,
    );
    expect(step?.state === 'PENDING' && isSecretString(step.command.cwd)).toBe(true);
    expect(step?.state === 'PENDING' && secretValuesEqual(step.command.cwd, expected)).toBe(true);
    expect(plan.resolvedInputs[1]).toMatchObject({ value: MASK, secret: false });
  });

  it('keeps resolved and rendered secrets wrapped, so the plan serializes as ***', () => {
    const { plan } = planFor(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: deploy',
        '      args: ["--token=${token}"]',
        '      env:',
        '        API_TOKEN: "${token}"',
      ],
      { overrides: new Map([['token', 'super-secret-value']]) },
    );

    const step = plan.steps[0];
    if (step?.state !== 'PENDING') {
      throw new Error('expected a pending step');
    }
    expect(isSecretString(plan.resolvedInputs[0]?.value)).toBe(true);
    expect(isSecretString(step.command.argv[1])).toBe(true);
    expect(isSecretString(step.command.env['API_TOKEN'])).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('super-secret-value');
    expect(JSON.parse(JSON.stringify(plan)).resolvedInputs[0].value).toBe('***');
    expect(String(step.command.argv[1])).toBe('***');

    for (const value of [
      plan.resolvedInputs[0]?.value,
      step.command.argv[1],
      step.command.env['API_TOKEN'],
    ]) {
      expect(value).not.toHaveProperty('reveal');
      expect(value).not.toHaveProperty('matches');
      expect(value).not.toHaveProperty('equals');
      expect(value).not.toHaveProperty('isIncludedIn');
      expect(value).not.toHaveProperty('registerForMasking');
      expect(value).not.toHaveProperty('resolvePathFrom');
      expect(value).not.toHaveProperty('compose');
      expect(value).not.toHaveProperty('length');
    }
  });

  it('masks public input collisions and makes every colliding execution value opaque', () => {
    const secret = 'credential-value';
    const substring = `prefix-${secret}-suffix`;
    const { plan } = planFor(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        '  mirror:',
        '    type: text',
        '  mirrors:',
        '    type: multiselect',
        `    options: [${secret}, ${substring}]`,
        'steps:',
        '  - id: use',
        `    title: "Deploy ${substring}"`,
        '    run:',
        '      command: "${mirror}"',
        '      args: ["${mirror}"]',
        '      cwd: "${mirror}"',
        '      env:',
        '        PUBLIC_NAME: "${mirror}"',
      ],
      {
        overrides: new Map([
          ['token', secret],
          ['mirror', substring],
          ['mirrors', JSON.stringify([secret, substring])],
        ]),
      },
    );

    expect(plan.resolvedInputs).toMatchObject([
      { id: 'token', secret: true },
      { id: 'mirror', value: 'prefix-***-suffix', secret: false },
      { id: 'mirrors', value: ['***', 'prefix-***-suffix'], secret: false },
    ]);
    const step = plan.steps[0];
    if (step?.state !== 'PENDING') {
      throw new Error('expected a pending step');
    }
    expect(step.title).toBe('Deploy prefix-***-suffix');
    expect(
      [
        step.command.argv[0],
        step.command.argv[1],
        step.command.cwd,
        step.command.env['PUBLIC_NAME'],
      ].every(isSecretString),
    ).toBe(true);
    for (const value of [
      step.command.argv[0],
      step.command.argv[1],
      step.command.env['PUBLIC_NAME'],
    ]) {
      expect(secretValuesEqual(value, substring)).toBe(true);
    }
    expect(secretValuesEqual(step.command.cwd, resolvePath('/project', substring))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(secret);
  });

  it('masks colliding skipped-step display fields without changing ids', () => {
    const secret = 'credential-value';
    const { plan } = planFor(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: keep-this-id',
        `    title: "Skip ${secret}"`,
        `    when: "'${secret}' == 'different-value'"`,
        '    run:',
        '      command: deploy',
      ],
      { overrides: new Map([['token', secret]]) },
    );

    expect(plan.steps[0]).toEqual({
      id: 'keep-this-id',
      title: 'Skip ***',
      state: 'SKIPPED',
      skipReason: "condition false: '***' == 'different-value'",
    });
  });

  it('does not spend registry capacity on complete colliding execution values', () => {
    const secret = 's'.repeat(MAX_SECRET_REGISTRY_CODE_UNITS);
    const collision = `x${secret}x`;
    const { plan } = planFor(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        '  mirror:',
        '    type: text',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: "${mirror}"',
      ],
      {
        overrides: new Map([
          ['token', secret],
          ['mirror', collision],
        ]),
      },
    );

    const step = plan.steps[0];
    expect(step?.state).toBe('PENDING');
    expect(step?.state === 'PENDING' && isSecretString(step.command.argv[0])).toBe(true);
    expect(step?.state === 'PENDING' && secretValuesEqual(step.command.argv[0], collision)).toBe(
      true,
    );
  });

  it('uses derived secrets from every command in the one final plan snapshot', () => {
    const relativeSecret = 'private-directory';
    const derived = resolvePath('/project', relativeSecret);
    const { plan } = planFor(
      [
        'inputs:',
        '  secretPath:',
        '    type: secret',
        '  mirror:',
        '    type: text',
        'steps:',
        '  - id: earlier',
        '    run:',
        '      command: "${mirror}"',
        '  - id: derive-later',
        '    run:',
        '      command: deploy',
        '      cwd: "${secretPath}"',
      ],
      {
        platform: hostPlatform(),
        overrides: new Map([
          ['secretPath', relativeSecret],
          ['mirror', derived],
        ]),
      },
    );

    expect(plan.resolvedInputs[1]).toMatchObject({ value: MASK, secret: false });
    const earlier = plan.steps[0];
    expect(earlier?.state).toBe('PENDING');
    expect(earlier?.state === 'PENDING' && isSecretString(earlier.command.argv[0])).toBe(true);
    expect(
      earlier?.state === 'PENDING' && secretValuesEqual(earlier.command.argv[0], derived),
    ).toBe(true);
  });

  it('does not mask identity, key or log-path fields that collide with registered secrets', () => {
    const { plan } = planFor(
      [
        'inputs:',
        '  manifestIdentity:',
        '    type: secret',
        '  platformIdentity:',
        '    type: secret',
        '  localeIdentity:',
        '    type: secret',
        '  stepIdentity:',
        '    type: secret',
        '  envKeyIdentity:',
        '    type: secret',
        '  logIdentity:',
        '    type: secret',
        'execution:',
        '  logFile: identity-log',
        'steps:',
        '  - id: identity-step',
        '    run:',
        '      command: deploy',
        '      env:',
        '        identity-env: public-value',
      ],
      {
        overrides: new Map([
          ['manifestIdentity', 'installer.yaml'],
          ['platformIdentity', 'linux'],
          ['localeIdentity', TEST_LOCALE],
          ['stepIdentity', 'identity-step'],
          ['envKeyIdentity', 'identity-env'],
          ['logIdentity', 'identity-log'],
        ]),
      },
    );

    expect(plan.manifestPath).toBe('installer.yaml');
    expect(plan.platform).toBe('linux');
    expect(plan.locale).toBe(TEST_LOCALE);
    expect(plan.executionOptions.logFile).toBe('identity-log');
    expect(plan.steps[0]?.id).toBe('identity-step');
    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && Object.keys(step.command.env)).toEqual(['identity-env']);
  });

  it('freezes a resolved secret state before planning without exposing its value', () => {
    const plaintext = 'must-not-reach-the-plan';
    const { manifest, resolution, context } = planFor(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: deploy',
        '      args: ["${token}"]',
      ],
      { overrides: new Map([['token', 'original-secret']]) },
    );
    expect(() => Object.assign(resolution.inputs[0] as object, { value: plaintext })).toThrow(
      TypeError,
    );

    const plan = buildPlan({ manifest, resolution, context });
    expect(JSON.stringify(plan)).not.toContain(plaintext);
    expect(isSecretString(plan.resolvedInputs[0]?.value)).toBe(true);
  });
});

describe('the plan itself', () => {
  it('has the complete versioned shape without legacy flat execution options', () => {
    const { plan } = planFor(['steps:', '  - id: a', '    run:', '      command: node'], {
      platform: hostPlatform(),
    });

    expect(Object.keys(plan)).toEqual([
      'planSchemaVersion',
      'manifestPath',
      'manifestSha256',
      'platform',
      'locale',
      'preview',
      'resolvedInputs',
      'executionOptions',
      'steps',
    ]);
    expect(plan).not.toHaveProperty('failFast');
    expect(plan).not.toHaveProperty('logFile');
    expect(plan).toMatchObject({
      planSchemaVersion: PLAN_SCHEMA_VERSION,
      manifestPath: 'installer.yaml',
      manifestSha256: '35c8f84df4785677ec842f1adcead819c45a313b74121e196522375db90d6697',
      platform: hostPlatform(),
      locale: TEST_LOCALE,
      preview: false,
      resolvedInputs: [],
      executionOptions: { failFast: true, logFile: undefined },
    });
  });

  it('deeply freezes copied inputs, options and steps', () => {
    const { plan, resolution } = planFor(
      [
        'inputs:',
        '  tools:',
        '    type: multiselect',
        '    options: [git, docker]',
        'steps:',
        '  - id: a',
        '    run:',
        '      command: node',
      ],
      { overrides: new Map([['tools', 'git,docker']]) },
    );

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.resolvedInputs)).toBe(true);
    expect(Object.isFrozen(plan.resolvedInputs[0])).toBe(true);
    expect(Object.isFrozen(plan.resolvedInputs[0]?.value)).toBe(true);
    expect(Object.isFrozen(plan.executionOptions)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(Object.isFrozen(plan.steps[0])).toBe(true);
    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && Object.isFrozen(step.command)).toBe(true);
    expect(step?.state === 'PENDING' && Object.isFrozen(step.command.argv)).toBe(true);
    expect(plan.resolvedInputs[0]).toMatchObject({
      id: 'tools',
      value: ['git', 'docker'],
      source: 'set',
      secret: false,
      enabled: true,
      ignored: undefined,
    });

    expect(() => (resolution.inputs[0]?.value as string[]).push('changed')).toThrow(TypeError);
    expect(() =>
      Object.assign(resolution.inputs[0] as object, { id: 'changed', source: 'answer' }),
    ).toThrow(TypeError);
    expect(plan.resolvedInputs[0]).toMatchObject({
      id: 'tools',
      value: ['git', 'docker'],
      source: 'set',
    });
  });

  it('captures a disabled input with its empty value and ignored provenance', () => {
    const { plan } = planFor(
      [
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        '  destination:',
        '    type: text',
        '    when: "${enabled}"',
        'steps: []',
      ],
      { overrides: new Map([['destination', 'discarded']]) },
    );

    expect(plan.resolvedInputs[1]).toEqual({
      id: 'destination',
      value: '',
      source: undefined,
      secret: false,
      enabled: false,
      ignored: 'set',
    });
  });

  it('uses the path bound during parsing even when a caller supplies a foreign property', () => {
    const { manifest, resolution, context } = planFor(['steps: []']);
    const options = {
      manifest,
      resolution,
      context,
      manifestPath: 'foreign.yaml',
    };

    expect(buildPlan(options).manifestPath).toBe('installer.yaml');
  });

  it('rejects a structurally equal manifest that is not the parsed instance', () => {
    const { manifest, resolution, context } = planFor(['steps: []']);
    const copy = structuredClone(manifest);

    expect(() => buildPlan({ manifest: copy, resolution, context })).toThrow(
      /manifest was not created by parseManifest/,
    );
  });
});

describe('planning provenance', () => {
  it('keeps a relative manifest override anchored when cwd changes before planning', () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-plan-manifest-anchor-'));
    const callerA = join(root, 'caller-a');
    const callerB = join(root, 'caller-b');
    const expectedManifestDir = join(callerA, 'manifest-root');
    const previousCwd = process.cwd();
    mkdirSync(callerA);
    mkdirSync(callerB);

    try {
      process.chdir(callerA);
      const manifest = parseManifestText(
        [
          ...HEAD,
          'steps:',
          '  - id: anchored',
          '    run:',
          '      command: scripts/tool',
          '      args: ["${manifestDir}"]',
          '',
        ].join('\n'),
        'installer.yaml',
        { manifestDir: 'manifest-root' },
      );

      process.chdir(callerB);
      const context = createRuntimeContext({
        manifestDir: expectedManifestDir,
        product: manifest.product,
        platform: hostPlatform(),
        environment: {},
      });
      const resolution = resolveInputs({ manifest, context });
      const plan = buildPlan({ manifest, resolution, context });
      const step = plan.steps[0];

      expect(step?.state).toBe('PENDING');
      expect(step?.state === 'PENDING' && step.command).toMatchObject({
        argv: [join(expectedManifestDir, 'scripts', 'tool'), expectedManifestDir],
        cwd: expectedManifestDir,
      });
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an authentic context whose manifest directory is not bound to the manifest', () => {
    const manifest = parseManifestText(
      [
        ...HEAD,
        'steps:',
        '  - id: unreachable',
        '    run:',
        '      command: "${env.NEVER_SET}"',
        '',
      ].join('\n'),
      'installer.yaml',
      { manifestDir: '/real' },
    );
    const context = createRuntimeContext({
      manifestDir: '/wrong',
      product: manifest.product,
      platform: 'linux',
      environment: {},
    });
    const resolution = resolveInputs({ manifest, context });

    expect(() => buildPlan({ manifest, resolution, context })).toThrow(InternalError);
    expect(() => buildPlan({ manifest, resolution, context })).toThrow(
      /runtime context manifest directory does not belong to the manifest/,
    );
  });

  it.each([
    { name: 'Spoofed', version: '1.0.0' },
    { name: 'Example', version: '9.9.9' },
  ])('rejects an authentic context whose product is not bound to the manifest', (product) => {
    const manifest = parseManifestText([...HEAD, 'steps: []', ''].join('\n'), 'installer.yaml', {
      manifestDir: '/project',
    });
    const context = createRuntimeContext({
      manifestDir: '/project',
      product,
      platform: 'linux',
      environment: {},
    });
    const resolution = resolveInputs({ manifest, context });

    expect(() => buildPlan({ manifest, resolution, context })).toThrow(InternalError);
    expect(() => buildPlan({ manifest, resolution, context })).toThrow(
      /runtime context product does not belong to the manifest/,
    );
  });

  it('accepts the effective manifest directory supplied to both parser entry points', () => {
    const text = [...HEAD, 'steps: []', ''].join('\n');
    const directory = mkdtempSync(join(tmpdir(), 'rune-plan-provenance-'));
    try {
      const manifestPath = join(directory, 'installer.yaml');
      writeFileSync(manifestPath, text, 'utf8');
      const manifests = [
        parseManifestText(text, 'memory.yaml', { manifestDir: '/project' }),
        parseManifest(manifestPath, { manifestDir: '/project' }),
      ];

      for (const manifest of manifests) {
        const context = createRuntimeContext({
          manifestDir: '/project',
          product: manifest.product,
          platform: 'linux',
          environment: {},
        });
        const resolution = resolveInputs({ manifest, context });

        expect(buildPlan({ manifest, resolution, context }).steps).toEqual([]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a structural copy of a resolution', () => {
    const { manifest, resolution, context } = planFor(['steps: []']);
    const forged = { ...resolution };

    expect(() => buildPlan({ manifest, resolution: forged, context })).toThrow(InternalError);
    expect(() => buildPlan({ manifest, resolution: forged, context })).toThrow(
      /input resolution was not created by resolveInputs/,
    );
  });

  it('rejects a resolution belonging to another manifest instance', () => {
    const { resolution, context } = planFor(['steps: []']);
    const otherManifest = parseManifestText([...HEAD, 'steps: []', ''].join('\n'), 'other.yaml');

    expect(() => buildPlan({ manifest: otherManifest, resolution, context })).toThrow(
      /input resolution belongs to a different manifest/,
    );
  });

  it('rejects a resolution paired with another authentic context', () => {
    const { manifest, resolution } = planFor(['steps: []']);
    const otherContext = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: 'linux',
      environment: {},
    });

    expect(() => buildPlan({ manifest, resolution, context: otherContext })).toThrow(
      /input resolution belongs to a different runtime context/,
    );
  });

  it('rejects a structural runtime context without factory provenance', () => {
    const { manifest, resolution, context } = planFor(['steps: []']);
    const fakeContext = { ...context };

    expect(() => buildPlan({ manifest, resolution, context: fakeContext })).toThrow(InternalError);
    expect(() => buildPlan({ manifest, resolution, context: fakeContext })).toThrow(
      /runtime context was not created by createRuntimeContext/,
    );
  });

  it('plans from the private snapshot consistent with the public resolution facade', () => {
    const { manifest, resolution, context } = planFor(
      [
        'inputs:',
        '  target:',
        '    type: text',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: deploy',
        '      args: ["${target}"]',
      ],
      { overrides: new Map([['target', 'resolved']]) },
    );
    expect(resolution.byId.get('target')).toBe(resolution.inputs[0]);
    const plan = buildPlan({ manifest, resolution, context });
    const step = plan.steps[0];
    expect(step?.state === 'PENDING' && step.command.argv[1]).toBe('resolved');
  });
});

function planningError(
  manifest: ManifestV1,
  resolution: Resolution,
  context: ReturnType<typeof createRuntimeContext>,
): InputError {
  try {
    buildPlan({ manifest, resolution, context });
  } catch (error) {
    if (error instanceof InputError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected planning to reject the incomplete resolution');
}

function executionError(action: () => unknown): ExecutionError {
  try {
    action();
  } catch (error) {
    if (error instanceof ExecutionError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected planning to reject the shell-required command');
}
