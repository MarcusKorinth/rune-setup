import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnCommand } = vi.hoisted(() => ({ spawnCommand: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: spawnCommand }));

const script = new URL('../scripts/gui-release.mjs', import.meta.url).href;
const repository = 'MarcusKorinth/rune-setup';
const endpoint = `repos/${repository}/releases`;
const identity = { version: '1.2.3', tag: 'v1.2.3', commit: '1'.repeat(40) };
const notes = 'Verified GUI downloads.\n';
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
let directory: string;
let destination: string;
let originalArgv: string[];

interface Asset {
  name: string;
  digest: string;
}

interface Release {
  id: number;
  tag_name: string;
  body: string;
  draft: boolean;
  assets: Asset[];
}

beforeEach(() => {
  vi.resetModules();
  spawnCommand.mockReset();
  directory = mkdtempSync(join(tmpdir(), 'rune-publish-test-'));
  destination = join(directory, 'output/gui-release');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'release-manifest.json'), JSON.stringify(identity) + '\n');
  writeFileSync(join(destination, 'release-notes.md'), notes);
  writeFileSync(join(destination, 'rune-gui-shell-windows.zip'), 'verified Windows archive');
  writeFileSync(join(destination, 'rune-gui-shell-linux.tar.gz'), 'verified Linux archive');
  writeFileSync(
    join(destination, 'SHA256SUMS'),
    readdirSync(destination)
      .sort()
      .map((name) => `${hash(readFileSync(join(destination, name)))}  ${name}\n`)
      .join(''),
  );
  originalArgv = process.argv;
  process.argv = [process.execPath, script, 'publish'];
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.stubEnv('GITHUB_EVENT_NAME', 'push');
  vi.stubEnv('GITHUB_REF', `refs/tags/${identity.tag}`);
  vi.stubEnv('GITHUB_REPOSITORY', repository);
  vi.stubEnv('RELEASE_VERSION', identity.version);
  vi.stubEnv('RELEASE_TAG', identity.tag);
  vi.stubEnv('RELEASE_COMMIT', identity.commit);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});

function candidateAssets(): Asset[] {
  return readdirSync(destination).map((name) => ({
    name,
    digest: `sha256:${hash(readFileSync(join(destination, name)))}`,
  }));
}

/** Model GitHub's observable draft/public state; draft lookup by tag deliberately fails. */
function github(initial?: Release) {
  let release = initial;
  const mutations: string[] = [];
  spawnCommand.mockImplementation((program: string, args: readonly string[]) => {
    expect(program).toBe('gh');
    let response: unknown;
    if (args[0] === 'api') {
      const path = args[1];
      if (path === `repos/${repository}/commits/${identity.tag}`) {
        response = { sha: identity.commit };
      } else if (path === endpoint) {
        response = [release === undefined ? [] : [release]];
      } else if (path === `${endpoint}/42`) {
        expect(release).toBeDefined();
        if (args.includes('PATCH')) {
          expect(release?.draft).toBe(true);
          expect(release?.assets).toEqual(expect.arrayContaining(candidateAssets()));
          expect(release?.assets).toHaveLength(candidateAssets().length);
          expect(args).toContain('draft=false');
          mutations.push('publish');
          release!.draft = false;
        }
        response = release;
      } else {
        // GET /releases/tags/{tag} does not retrieve drafts, even with a write token.
        return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
      }
    } else if (args[0] === 'release' && args[1] === 'create') {
      expect(release).toBeUndefined();
      expect(args).toContain('--draft');
      expect(args).toContain('--verify-tag');
      mutations.push('create draft');
      release = { id: 42, tag_name: identity.tag, body: notes, draft: true, assets: [] };
      response = 'draft created';
    } else if (args[0] === 'release' && args[1] === 'upload') {
      expect(release?.draft).toBe(true);
      expect(args).not.toContain('--clobber');
      const file = args[3] as string;
      const name = basename(file);
      expect(release?.assets.some((asset) => asset.name === name)).toBe(false);
      mutations.push(`upload ${name}`);
      release!.assets.push({ name, digest: `sha256:${hash(readFileSync(file))}` });
      response = 'asset uploaded';
    } else {
      throw new Error('Unexpected GitHub operation');
    }
    return { status: 0, stdout: JSON.stringify(response), stderr: '' };
  });
  return { mutations, release: () => release };
}

describe('GUI release publication', () => {
  it('finds a new draft through the release listing and publishes only after all asset digests match', async () => {
    const remote = github();
    await import(script);
    expect(remote.release()?.draft).toBe(false);
    expect(remote.mutations[0]).toBe('create draft');
    expect(remote.mutations.at(-1)).toBe('publish');
    expect(remote.mutations.filter((entry) => entry.startsWith('upload '))).toHaveLength(
      candidateAssets().length,
    );
  });

  it('resumes an existing partial draft without uploading the already verified asset again', async () => {
    const [existing] = candidateAssets();
    const remote = github({
      id: 42,
      tag_name: identity.tag,
      body: notes,
      draft: true,
      assets: [existing!],
    });
    await import(script);
    expect(remote.release()?.draft).toBe(false);
    expect(remote.mutations).not.toContain('create draft');
    expect(remote.mutations).not.toContain(`upload ${existing!.name}`);
    expect(remote.mutations.filter((entry) => entry.startsWith('upload '))).toHaveLength(
      candidateAssets().length - 1,
    );
  });

  it('leaves an identical published release untouched', async () => {
    const remote = github({
      id: 42,
      tag_name: identity.tag,
      body: notes,
      draft: false,
      assets: candidateAssets(),
    });
    await import(script);
    expect(remote.mutations).toEqual([]);
  });

  it('refuses a different published asset without changing the release', async () => {
    const assets = candidateAssets();
    assets[0]!.digest = `sha256:${'0'.repeat(64)}`;
    const remote = github({ id: 42, tag_name: identity.tag, body: notes, draft: false, assets });
    await expect(import(script)).rejects.toThrow('it is never overwritten');
    expect(remote.mutations).toEqual([]);
  });
});
