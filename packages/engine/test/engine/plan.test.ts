import { describe, expect, it, vi } from 'vitest';

import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { resolveInputs, type Resolution } from '../../src/engine/inputs.js';
import { buildPlan, type ExecutionPlan } from '../../src/engine/plan.js';
import { SecretString } from '../../src/engine/secrets.js';
import { InputError } from '../../src/errors.js';
import { parseManifestText } from '../../src/manifest/index.js';
import type { ManifestV1 } from '../../src/manifest/v1/schema.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];

function planFor(
  lines: readonly string[],
  options: {
    platform?: 'windows' | 'linux';
    overrides?: ReadonlyMap<string, string>;
    environment?: Record<string, string>;
  } = {},
): { plan: ExecutionPlan; manifest: ManifestV1; resolution: Resolution } {
  const manifest = parseManifestText([...HEAD, ...lines, ''].join('\n'), 'installer.yaml');
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
    plan: buildPlan({ manifest, manifestPath: 'installer.yaml', resolution, context }),
    manifest,
    resolution,
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
    const reveal = vi.spyOn(SecretString.prototype, 'reveal');
    let message = '';

    try {
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
      expect(reveal).not.toHaveBeenCalled();
    } finally {
      reveal.mockRestore();
    }
  });
});

describe('secrets in the plan', () => {
  it('keeps a rendering a secret flowed into wrapped, so the plan serializes as ***', () => {
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
    expect(step.command.argv[1]).toBeInstanceOf(SecretString);
    expect(step.command.env['API_TOKEN']).toBeInstanceOf(SecretString);
    expect(JSON.stringify(plan)).not.toContain('super-secret-value');
    expect(String(step.command.argv[1])).toBe('***');
  });
});

describe('the plan itself', () => {
  it('is frozen and carries what execution and rendering need', () => {
    const { plan } = planFor(['steps:', '  - id: a', '    run:', '      command: node'], {
      platform: hostPlatform(),
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps[0])).toBe(true);
    expect(plan).toMatchObject({
      manifestPath: 'installer.yaml',
      platform: hostPlatform(),
      preview: false,
      failFast: true,
    });
  });
});

function planningError(
  manifest: ManifestV1,
  resolution: Resolution,
  context: ReturnType<typeof createRuntimeContext>,
): InputError {
  try {
    buildPlan({ manifest, manifestPath: 'installer.yaml', resolution, context });
  } catch (error) {
    if (error instanceof InputError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected planning to reject the incomplete resolution');
}
