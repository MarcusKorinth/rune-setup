import { homedir, tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeContext, hostPlatform, runtimeContextFor } from '../../src/engine/context.js';
import { InternalError, ResolutionError, UsageError } from '../../src/errors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const product = { name: 'Example', version: '1.0.0' };

function contextFor(platform?: 'windows' | 'linux', environment: Record<string, string> = {}) {
  return createRuntimeContext({
    manifestDir: '/project',
    product,
    ...(platform === undefined ? {} : { platform }),
    environment,
  });
}

describe('the values behind the built-in names', () => {
  const context = contextFor(hostPlatform(), { JAVA_HOME: '/opt/java' });

  it('answers for the host when the host is what is being run', () => {
    expect(context.preview).toBe(false);
    expect(context.valueOf({ kind: 'builtin', name: 'home' })).toBe(homedir());
    expect(context.valueOf({ kind: 'builtin', name: 'temp' })).toBe(tmpdir());
    expect(context.valueOf({ kind: 'builtin', name: 'platform' })).toBe(hostPlatform());
    expect(context.valueOf({ kind: 'builtin', name: 'manifestDir' })).toBe('/project');
  });

  it('answers for the product', () => {
    expect(context.valueOf({ kind: 'product', field: 'name' })).toBe('Example');
    expect(context.valueOf({ kind: 'product', field: 'version' })).toBe('1.0.0');
  });

  it('reads any environment variable, because there is no allowlist', () => {
    expect(context.valueOf({ kind: 'environment', name: 'JAVA_HOME' })).toBe('/opt/java');
  });

  it('uses host casing semantics when previewing the other platform', () => {
    const other = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const preview = contextFor(other, { RuNe_MiXeD_CaSe: 'visible' });
    const mismatchedReference = { kind: 'environment', name: 'rune_mixed_case' } as const;

    expect(preview.valueOf({ kind: 'environment', name: 'RuNe_MiXeD_CaSe' })).toBe('visible');
    if (process.platform === 'win32') {
      expect(preview.valueOf(mismatchedReference)).toBe('visible');
    } else {
      expect(() => preview.valueOf(mismatchedReference)).toThrow(ResolutionError);
    }
  });

  it('keeps Unicode environment names distinct from ASCII names', () => {
    const environment = {
      RUNE_REVIEW_SS: 'ascii',
      RUNE_REVIEW_ß: 'unicode',
    };
    const context = contextFor(hostPlatform(), environment);

    expect(context.valueOf({ kind: 'environment', name: 'RUNE_REVIEW_SS' })).toBe('ascii');
  });

  it('does not inherit phantom values from Object.prototype', () => {
    expect(() => context.valueOf({ kind: 'environment', name: 'toString' })).toThrow(
      ResolutionError,
    );
  });

  it('refuses an environment variable the machine does not have', () => {
    let thrown: unknown;
    try {
      context.valueOf({ kind: 'environment', name: 'NOT_SET_ANYWHERE' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    expect((thrown as ResolutionError).code).toBe('RUNE-301');
    expect((thrown as ResolutionError).message).toBe(
      'the environment variable NOT_SET_ANYWHERE is not set',
    );
  });

  it('refuses to answer for an input, which only the resolver knows', () => {
    expect(() => context.valueOf({ kind: 'input', id: 'installDirectory' })).toThrow(
      ResolutionError,
    );
  });
});

describe('previewing the other platform', () => {
  const other = hostPlatform() === 'windows' ? 'linux' : 'windows';
  const context = contextFor(other);

  it('knows it is a preview', () => {
    expect(context.preview).toBe(true);
    expect(context.platform).toBe(other);
  });

  it('marks the values this machine cannot answer for instead of inventing them', () => {
    // A plausible-looking path would be a lie about the target; a visible token is not.
    expect(context.valueOf({ kind: 'builtin', name: 'home' })).toBe(`<home@${other}>`);
    expect(context.valueOf({ kind: 'builtin', name: 'temp' })).toBe(`<temp@${other}>`);
  });

  it('still answers for what the preview does know', () => {
    expect(context.valueOf({ kind: 'builtin', name: 'platform' })).toBe(other);
    expect(context.valueOf({ kind: 'builtin', name: 'manifestDir' })).toBe('/project');
    expect(context.valueOf({ kind: 'product', field: 'name' })).toBe('Example');
  });
});

describe('hostPlatform', () => {
  it('names one of the two platforms RUNE runs on', () => {
    expect(['windows', 'linux']).toContain(hostPlatform());
    expect(hostPlatform()).toBe(process.platform === 'win32' ? 'windows' : 'linux');
  });

  it('refuses an unsupported host instead of treating it as Linux', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    let thrown: unknown;
    try {
      hostPlatform();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as UsageError).code).toBe('RUNE-001');
    expect((thrown as UsageError).message).toBe(
      'the host platform "darwin" is not supported; RUNE supports only Windows and Linux',
    );
  });

  it('is what a context without an explicit platform uses', () => {
    expect(contextFor().platform).toBe(hostPlatform());
    expect(contextFor().preview).toBe(false);
  });
});

describe('runtime context provenance', () => {
  it('snapshots caller-owned values and freezes the exact facade', () => {
    const mutableProduct = { name: 'Before', version: '1.0.0' };
    const mutableEnvironment: Record<string, string> = { TOKEN: 'before' };
    const options = {
      manifestDir: '/before',
      product: mutableProduct,
      platform: hostPlatform(),
      environment: mutableEnvironment,
    } as const;
    const context = createRuntimeContext(options);

    mutableProduct.name = 'After';
    mutableProduct.version = '2.0.0';
    mutableEnvironment['TOKEN'] = 'after';
    Object.assign(options, { manifestDir: '/after' });

    expect(Object.isFrozen(context)).toBe(true);
    expect(context.manifestDir).toBe('/before');
    expect(context.valueOf({ kind: 'builtin', name: 'manifestDir' })).toBe('/before');
    expect(context.valueOf({ kind: 'product', field: 'name' })).toBe('Before');
    expect(context.valueOf({ kind: 'product', field: 'version' })).toBe('1.0.0');
    expect(context.valueOf({ kind: 'environment', name: 'TOKEN' })).toBe('before');
  });

  it('rejects a structural copy without provenance', () => {
    const context = contextFor();
    const copy = { ...context };

    expect(() => runtimeContextFor(copy)).toThrow(InternalError);
    expect(() => runtimeContextFor(copy)).toThrow(
      /runtime context was not created by createRuntimeContext/,
    );
  });
});
