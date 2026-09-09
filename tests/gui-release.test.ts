import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/gui-release.mjs', import.meta.url));
const directories: string[] = [];
const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

afterEach(() => {
  for (const directory of directories.splice(0)) {
    expect(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(version = '1.2.3') {
  const directory = mkdtempSync(join(tmpdir(), 'rune-release-'));
  directories.push(directory);
  const write = (path: string, value: unknown): void => {
    writeFileSync(join(directory, path), `${JSON.stringify(value, null, 2)}\n`);
  };
  const packages: Record<string, unknown> = {};
  for (const name of ['engine', 'cli', 'gui-shell']) {
    mkdirSync(join(directory, 'packages', name), { recursive: true });
    const manifest = {
      name: `@rune/${name}`,
      version,
      dependencies: name === 'engine' ? {} : { '@rune/engine': version },
    };
    write(`packages/${name}/package.json`, manifest);
    packages[`packages/${name}`] = manifest;
  }
  write('package-lock.json', { packages });
  writeFileSync(
    join(directory, 'CHANGELOG.md'),
    `# Changelog\n\n## Unreleased\n\nNext changes.\n\n## ${version}\n\nVerified GUI downloads.\n`,
  );
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: directory, shell: false, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '--initial-branch=main');
  git('add', '.');
  git(
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=release@example.invalid',
    'commit',
    '-m',
    'test: prepare release fixture',
  );
  const commit = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', commit);
  git('tag', `v${version}`);
  const environment = {
    ...process.env,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: `refs/tags/v${version}`,
    GITHUB_SHA: commit,
    GITHUB_OUTPUT: '',
    RELEASE_VERSION: version,
    RELEASE_TAG: `v${version}`,
    RELEASE_COMMIT: commit,
  };
  const run = (operation: string, overrides: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, operation], {
      cwd: directory,
      env: { ...environment, ...overrides },
      shell: false,
      encoding: 'utf8',
    });
  const archive = (platform: 'windows' | 'linux'): string => {
    const path = join(
      directory,
      'output/candidate-artifacts',
      `gui-shell-${platform}`,
      `${platform}-x64`,
    );
    mkdirSync(path, { recursive: true });
    const name = `rune-gui-shell-${platform}.${platform === 'windows' ? 'zip' : 'tar.gz'}`;
    const content = `Already tested ${platform} archive bytes`;
    writeFileSync(join(path, name), content);
    writeFileSync(
      join(path, 'build-metadata.json'),
      JSON.stringify({
        platform,
        architecture: 'x64',
        shellVersion: version,
        lockfileSha256: digest(readFileSync(join(directory, 'package-lock.json'))),
        archive: name,
        archiveSha256: digest(content),
      }),
    );
    return join(path, name);
  };
  return { directory, version, commit, write, git, run, archive };
}

describe('GUI release candidate verification', () => {
  it('accepts a versioned tag on main and preserves its exact commit in outputs', () => {
    const candidate = fixture('1.2.3-rc.1');
    const result = candidate.run('validate');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: candidate.version,
      tag: `v${candidate.version}`,
      commit: candidate.commit,
    });
  });

  it('refuses an inconsistent package version, lockfile, tag, or checkout', () => {
    const candidate = fixture();
    expect(candidate.run('validate', { GITHUB_REF: 'refs/tags/v1.2.4' }).status).not.toBe(0);
    expect(
      candidate.run('validate', { GITHUB_SHA: '0000000000000000000000000000000000000000' }).status,
    ).not.toBe(0);
    candidate.write('packages/cli/package.json', {
      name: '@rune/cli',
      version: '1.2.4',
      dependencies: { '@rune/engine': '1.2.3' },
    });
    expect(candidate.run('validate').stderr).toContain('packages/cli version differs');
    candidate.write('packages/cli/package.json', {
      name: '@rune/cli',
      version: '1.2.3',
      dependencies: { '@rune/engine': '1.2.3' },
    });
    candidate.write('package-lock.json', { packages: {} });
    expect(candidate.run('validate').stderr).toContain('lock version differs');
  });

  it('refuses tags on an unmerged commit', () => {
    const candidate = fixture();
    candidate.git('switch', '-c', 'feature');
    writeFileSync(join(candidate.directory, 'unmerged.txt'), 'change');
    candidate.git('add', '.');
    candidate.git(
      '-c',
      'user.name=Release Test',
      '-c',
      'user.email=release@example.invalid',
      'commit',
      '-m',
      'test: unmerged change',
    );
    const commit = candidate.git('rev-parse', 'HEAD');
    candidate.git('tag', '-d', 'v1.2.3');
    candidate.git('tag', 'v1.2.3');
    expect(candidate.run('validate', { GITHUB_SHA: commit }).status).not.toBe(0);
  });

  it('requires release notes for a tag while allowing a manual Unreleased candidate', () => {
    const candidate = fixture();
    writeFileSync(
      join(candidate.directory, 'CHANGELOG.md'),
      '# Changelog\n\n## Unreleased\n\nCandidate changes.\n',
    );
    expect(candidate.run('validate').stderr).toContain('nonempty "## 1.2.3"');
    expect(
      candidate.run('validate', {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
      }).status,
    ).toBe(0);
    expect(candidate.run('publish', { GITHUB_EVENT_NAME: 'workflow_dispatch' }).stderr).toContain(
      'Manual verification cannot publish',
    );
  });
});

describe('GUI release artifact preparation', () => {
  it('copies both tested archives unchanged and writes verifiable provenance and checksums', () => {
    const candidate = fixture();
    const windows = candidate.archive('windows');
    const linux = candidate.archive('linux');
    const result = candidate.run('prepare');
    expect(result.status, result.stderr).toBe(0);
    const destination = join(candidate.directory, 'output/gui-release');
    expect(readFileSync(join(destination, 'rune-gui-shell-windows.zip'))).toEqual(
      readFileSync(windows),
    );
    expect(readFileSync(join(destination, 'rune-gui-shell-linux.tar.gz'))).toEqual(
      readFileSync(linux),
    );
    const manifest = JSON.parse(
      readFileSync(join(destination, 'release-manifest.json'), 'utf8'),
    ) as { commit: string; signed: boolean; archives: unknown[] };
    expect(manifest.commit).toBe(candidate.commit);
    expect(manifest.signed).toBe(false);
    expect(manifest.archives).toHaveLength(2);
    const sums = readFileSync(join(destination, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(readdirSync(destination).length - 1);
    for (const sum of sums) {
      const [expected, name] = sum.split('  ') as [string, string];
      expect(digest(readFileSync(join(destination, name)))).toBe(expected);
    }
    expect(candidate.run('prepare').status).not.toBe(0);
  });

  it('refuses missing platform artifacts and archives changed after their build', () => {
    const candidate = fixture();
    const windows = candidate.archive('windows');
    expect(candidate.run('prepare').stderr).toContain(
      'Both target build metadata files are required',
    );
    candidate.archive('linux');
    writeFileSync(windows, 'different archive');
    expect(candidate.run('prepare').stderr).toContain(
      'Archive differs from its tested build metadata',
    );
  });

  it('refuses archives produced from a different dependency lockfile', () => {
    const candidate = fixture();
    candidate.archive('windows');
    candidate.archive('linux');
    candidate.write('package-lock.json', { changed: true });
    expect(candidate.run('prepare').stderr).toContain('Archive lockfile differs');
  });
});
