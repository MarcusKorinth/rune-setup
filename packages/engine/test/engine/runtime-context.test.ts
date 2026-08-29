import { homedir, tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createRuntimeContext, hostPlatform, platformForNode } from '../../src/engine/context.js';
import { exitCodeFor, PlatformError, ResolutionError } from '../../src/errors.js';

const product = { name: 'Example', version: '1.0.0' };
const host = hostPlatform();
const other = host === 'windows' ? 'linux' : 'windows';

function contextFor(platform?: 'windows' | 'linux', environment: Record<string, string> = {}) {
  return createRuntimeContext({
    manifestDir: '/project',
    product,
    ...(platform === undefined ? {} : { platform }),
    environment,
  });
}

function unsafeEnvironment(value: object): Record<string, string> {
  return value as Record<string, string>;
}

function unsafePlatform(value: unknown): 'windows' | 'linux' {
  return value as 'windows' | 'linux';
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

  it.each(['toString', 'constructor', '__proto__'])(
    'does not read the inherited prototype name %s as an environment variable',
    (name) => {
      const empty = contextFor('linux');

      expect(empty.environmentValue(name)).toBeUndefined();
      expect(() => empty.valueOf({ kind: 'environment', name })).toThrow(
        `the environment variable ${name} is not set`,
      );
    },
  );

  it('ignores a custom inherited string property', () => {
    const environment = Object.create({ INHERITED: 'not-an-environment-value' }) as object;
    const inherited = contextFor('linux', unsafeEnvironment(environment));

    expect(inherited.environmentValue('INHERITED')).toBeUndefined();
    expect(() => inherited.valueOf({ kind: 'environment', name: 'INHERITED' })).toThrow(
      'the environment variable INHERITED is not set',
    );
  });

  it('reads an own string property', () => {
    const own = contextFor('linux', { OWN_VALUE: 'available' });

    expect(own.environmentValue('OWN_VALUE')).toBe('available');
    expect(own.valueOf({ kind: 'environment', name: 'OWN_VALUE' })).toBe('available');
  });

  it('snapshots own environment values when the context is created', () => {
    const environment: Record<string, string> = {
      CHANGED: 'before',
      DELETED: 'kept',
    };
    const runtime = contextFor('linux', environment);

    environment.CHANGED = 'after';
    delete environment.DELETED;
    environment.ADDED = 'too-late';

    expect(runtime.environmentValue('CHANGED')).toBe('before');
    expect(runtime.environmentValue('DELETED')).toBe('kept');
    expect(runtime.environmentValue('ADDED')).toBeUndefined();
  });

  it('does not execute or expose environment accessors', () => {
    let reads = 0;
    const environment = Object.defineProperty({}, 'LAZY', {
      enumerable: true,
      get() {
        reads += 1;
        return 'not-an-environment-value';
      },
    });

    const runtime = contextFor('linux', unsafeEnvironment(environment));

    expect(reads).toBe(0);
    expect(runtime.environmentValue('LAZY')).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('ignores an own property whose value is not a string', () => {
    const nonString = contextFor('linux', unsafeEnvironment({ NOT_TEXT: { nested: true } }));

    expect(nonString.environmentValue('NOT_TEXT')).toBeUndefined();
    expect(() => nonString.valueOf({ kind: 'environment', name: 'NOT_TEXT' })).toThrow(
      'the environment variable NOT_TEXT is not set',
    );
  });

  it.each([
    ['the host platform', host],
    ['a preview of the other platform', other],
  ] as const)('uses host environment-name semantics for %s', (_description, platform) => {
    const runtime = contextFor(platform, { Path: 'mixed', EXACT: 'exact' });

    expect(runtime.environmentValue('EXACT')).toBe('exact');
    expect(runtime.valueOf({ kind: 'environment', name: 'EXACT' })).toBe('exact');
    expect(runtime.environmentValue('PATH')).toBe(host === 'windows' ? 'mixed' : undefined);
    expect(runtime.environmentValue('path')).toBe(host === 'windows' ? 'mixed' : undefined);
    if (host === 'windows') {
      expect(runtime.valueOf({ kind: 'environment', name: 'PATH' })).toBe('mixed');
    } else {
      expect(() => runtime.valueOf({ kind: 'environment', name: 'PATH' })).toThrow(
        'the environment variable PATH is not set',
      );
    }
  });

  it('keeps the first own environment name under host casing semantics', () => {
    const runtime = contextFor(host, { Path: 'first', PATH: 'second' });

    expect(runtime.environmentValue('Path')).toBe('first');
    expect(runtime.environmentValue('PATH')).toBe(host === 'windows' ? 'first' : 'second');
    expect(runtime.environmentValue('path')).toBe(host === 'windows' ? 'first' : undefined);
  });

  it('snapshots manifest, product, and selected platform values', () => {
    const options: {
      manifestDir: string;
      product: { name: string; version: string };
      platform: 'windows' | 'linux';
      environment: Record<string, string>;
    } = {
      manifestDir: '/before',
      product: { name: 'Before', version: '1.0.0' },
      platform: host,
      environment: {},
    };
    const runtime = createRuntimeContext(options);

    options.manifestDir = '/after';
    options.product.name = 'After';
    options.product.version = '2.0.0';
    options.platform = other;

    expect(runtime.manifestDir).toBe('/before');
    expect(runtime.platform).toBe(host);
    expect(runtime.valueOf({ kind: 'builtin', name: 'manifestDir' })).toBe('/before');
    expect(runtime.valueOf({ kind: 'builtin', name: 'platform' })).toBe(host);
    expect(runtime.valueOf({ kind: 'product', field: 'name' })).toBe('Before');
    expect(runtime.valueOf({ kind: 'product', field: 'version' })).toBe('1.0.0');
  });

  it('freezes its public snapshot', () => {
    const runtime = contextFor(host, { SNAPSHOT_VALUE: 'kept' });

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.set(runtime, 'platform', other)).toBe(false);
    expect(Reflect.set(runtime, 'manifestDir', '/other-project')).toBe(false);
    expect(Reflect.set(runtime, 'preview', !runtime.preview)).toBe(false);
    expect(Reflect.set(runtime, 'environmentValue', () => 'replaced')).toBe(false);
    expect(Reflect.set(runtime, 'valueOf', () => 'replaced')).toBe(false);

    expect(runtime.platform).toBe(host);
    expect(runtime.manifestDir).toBe('/project');
    expect(runtime.preview).toBe(false);
    expect(runtime.environmentValue('SNAPSHOT_VALUE')).toBe('kept');
    expect(runtime.valueOf({ kind: 'builtin', name: 'platform' })).toBe(host);
    expect(runtime.valueOf({ kind: 'builtin', name: 'manifestDir' })).toBe('/project');
    expect(runtime.valueOf({ kind: 'environment', name: 'SNAPSHOT_VALUE' })).toBe('kept');
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

  it.each([
    ['darwin', 'darwin'],
    ['', ''],
    [null, 'null'],
    [42, '42'],
  ] as const)('rejects the unsupported preview platform %s', (platform, renderedPlatform) => {
    let thrown: unknown;
    try {
      createRuntimeContext({
        manifestDir: '/project',
        product,
        platform: unsafePlatform(platform),
        environment: {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PlatformError);
    expect((thrown as PlatformError).code).toBe('RUNE-002');
    expect((thrown as PlatformError).message).toBe(
      `preview platform "${renderedPlatform}" is not supported; supported preview platforms are windows and linux`,
    );
    expect(exitCodeFor(thrown)).toBe(2);
  });
});

describe('hostPlatform', () => {
  it.each([
    ['win32', 'windows'],
    ['linux', 'linux'],
  ] as const)('maps the Node platform %s to %s', (nodePlatform, platform) => {
    expect(platformForNode(nodePlatform)).toBe(platform);
  });

  it.each(['darwin', 'freebsd'] as const)(
    'rejects the unsupported Node platform %s',
    (platform) => {
      let thrown: unknown;
      try {
        platformForNode(platform);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PlatformError);
      expect((thrown as PlatformError).code).toBe('RUNE-002');
      expect((thrown as PlatformError).message).toBe(
        `host platform "${platform}" is not supported; supported Node platforms are win32 and linux`,
      );
      expect(exitCodeFor(thrown)).toBe(2);
    },
  );

  it('maps the actual CI host correctly', () => {
    const expected = process.platform === 'win32' ? 'windows' : 'linux';

    expect(['win32', 'linux']).toContain(process.platform);
    expect(hostPlatform()).toBe(expected);
  });

  it('is what a context without an explicit platform uses', () => {
    expect(contextFor().platform).toBe(hostPlatform());
    expect(contextFor().preview).toBe(false);
  });
});
