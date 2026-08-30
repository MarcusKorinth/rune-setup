import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { resolveInputs, type Resolution } from '../../src/engine/inputs.js';
import {
  buildPlan as buildPlanWithLocale,
  PLAN_SCHEMA_VERSION,
  type ExecutionPlan,
  type PlanOptions,
} from '../../src/engine/plan.js';
import { isSecretString, MASK } from '../../src/engine/secrets.js';
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
    environment: options.environment ?? {},
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
    const resolution = resolveInputs({ manifest, context, environment: {} });

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
      environment: {},
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
      environment: {},
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
      environment: {},
      overrides: new Map([['porrt', '8080']]),
      invalidValues: 'collect',
    });

    const error = planningError(manifest, resolution, context);
    expect(error.code).toBe('RUNE-203');
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

  it('anchors Windows-looking values for a Linux target from the manifest directory', () => {
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
    expect(step?.state === 'PENDING' && step.command.argv[0]).toBe(
      resolvePath('/project', `.${sep}${command}`),
    );
    expect(step?.state === 'PENDING' && step.command.cwd).toBe(
      resolvePath('/project', `.${sep}${cwd}`),
    );
  });
});

describe('the Windows honesty rule', () => {
  const lines = ['steps:', '  - id: legacy', '    run:', '      command: setup.bat'];

  it('refuses a batch file at plan time, with the fix in the message', () => {
    expect(() => planFor(lines, { platform: 'windows' })).toThrow(/needs a shell/);
    expect(() => planFor(lines, { platform: 'windows' })).toThrow(/command: cmd/);
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

describe('secrets in the plan', () => {
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
    const resolution = resolveInputs({ manifest, context, environment: {} });

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
    const resolution = resolveInputs({ manifest, context, environment: {} });

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
        const resolution = resolveInputs({ manifest, context, environment: {} });

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
