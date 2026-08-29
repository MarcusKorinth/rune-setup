import { homedir, tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createRuntimeContext, hostPlatform, platformForNode } from '../../src/engine/context.js';
import { exitCodeFor, PlatformError, ResolutionError } from '../../src/errors.js';

const product = { name: 'Example', version: '1.0.0' };

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

  it('ignores an own property whose value is not a string', () => {
    const nonString = contextFor('linux', unsafeEnvironment({ NOT_TEXT: { nested: true } }));

    expect(nonString.environmentValue('NOT_TEXT')).toBeUndefined();
    expect(() => nonString.valueOf({ kind: 'environment', name: 'NOT_TEXT' })).toThrow(
      'the environment variable NOT_TEXT is not set',
    );
  });

  it('matches environment names case-insensitively for a Windows context', () => {
    const windows = contextFor('windows', { Path: 'C:\\Tools' });

    expect(windows.environmentValue('PATH')).toBe('C:\\Tools');
    expect(windows.valueOf({ kind: 'environment', name: 'path' })).toBe('C:\\Tools');
  });

  it('matches environment names case-sensitively for a Linux context', () => {
    const linux = contextFor('linux', { Path: '/tools' });

    expect(linux.environmentValue('PATH')).toBeUndefined();
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
