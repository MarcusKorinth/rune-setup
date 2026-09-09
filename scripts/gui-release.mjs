import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = process.cwd();
const destination = join(root, 'output/gui-release');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

function command(program, args) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${program} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function releaseIdentity() {
  const version = process.env.RELEASE_VERSION;
  const tag = process.env.RELEASE_TAG;
  const commit = process.env.RELEASE_COMMIT;
  assert(typeof version === 'string' && versionPattern.test(version), 'Invalid release version');
  assert.equal(tag, `v${version}`, 'Release tag must match its version');
  assert(/^[0-9a-f]{40}$/u.test(commit ?? ''), 'Invalid release commit');
  return { version, tag, commit };
}

function changelogNotes(version, allowUnreleased) {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const sections = [...changelog.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gmu)];
  const section = sections.find(
    (match) => match[1] === version || match[1].startsWith(`${version} - `),
  );
  const selected =
    section ?? (allowUnreleased ? sections.find((match) => match[1] === 'Unreleased') : undefined);
  assert(selected?.[2].trim(), `CHANGELOG.md needs a nonempty "## ${version}" release section`);
  return selected[2].trim();
}

function validate() {
  const event = process.env.GITHUB_EVENT_NAME;
  assert(
    ['push', 'workflow_dispatch'].includes(event),
    'Only tag pushes or manual verification are supported',
  );
  const packages = ['engine', 'cli', 'gui-shell'].map((name) => ({
    path: `packages/${name}`,
    manifest: readJson(join(root, `packages/${name}/package.json`)),
  }));
  const [engine] = packages;
  const version = engine.manifest.version;
  assert(
    typeof version === 'string' && versionPattern.test(version),
    'Use SemVer without build metadata',
  );
  const tag = `v${version}`;
  const commit = command('git', ['rev-parse', 'HEAD']);
  assert.equal(
    command('git', ['rev-parse', `${process.env.GITHUB_SHA}^{commit}`]),
    commit,
    'Checkout differs from the triggering commit',
  );
  const lock = readJson(join(root, 'package-lock.json'));
  for (const entry of packages) {
    assert.equal(entry.manifest.version, version, `${entry.path} version differs`);
    assert.equal(lock.packages[entry.path]?.version, version, `${entry.path} lock version differs`);
    if (entry !== engine) {
      assert.equal(
        entry.manifest.dependencies[engine.manifest.name],
        version,
        `${entry.path} engine dependency differs`,
      );
      assert.equal(
        lock.packages[entry.path]?.dependencies?.[engine.manifest.name],
        version,
        `${entry.path} locked engine dependency differs`,
      );
    }
  }
  if (event === 'push') {
    assert.equal(
      process.env.GITHUB_REF,
      `refs/tags/${tag}`,
      'Pushed tag differs from the package version',
    );
    assert.equal(
      command('git', ['rev-parse', `${tag}^{commit}`]),
      commit,
      'Tag does not identify this checkout',
    );
    command('git', ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
  }
  changelogNotes(version, event === 'workflow_dispatch');
  const candidate = { version, tag, commit };
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(candidate)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  process.stdout.write(`${JSON.stringify(candidate)}\n`);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    assert(!entry.isSymbolicLink(), 'Release inputs must not contain symlinks');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(path);
    assert(entry.isFile(), 'Release inputs must contain regular files');
    return [path];
  });
}

async function prepare() {
  const identity = releaseIdentity();
  assert.equal(
    command('git', ['rev-parse', 'HEAD']),
    identity.commit,
    'Release metadata checkout differs',
  );
  const inputs = filesBelow(join(root, 'output/candidate-artifacts'));
  const metadataFiles = inputs.filter((path) => basename(path) === 'build-metadata.json');
  assert.equal(metadataFiles.length, 2, 'Both target build metadata files are required');
  assert.equal(
    inputs.length,
    4,
    'Only the two verified archives and their metadata may enter a release',
  );
  const lockfileSha256 = await sha256(join(root, 'package-lock.json'));
  const selected = new Set();
  const archives = [];
  // Exclusive directory creation prevents stale files from an earlier candidate entering the release.
  mkdirSync(join(root, 'output'), { recursive: true });
  mkdirSync(destination);
  for (const metadataFile of metadataFiles) {
    const metadata = readJson(metadataFile);
    assert(['windows', 'linux'].includes(metadata.platform), 'Unsupported GUI target');
    assert(!selected.has(metadata.platform), 'Duplicate GUI target');
    selected.add(metadata.platform);
    assert.equal(metadata.architecture, 'x64', 'Only x64 archives are published');
    assert.equal(metadata.shellVersion, identity.version, 'Archive version differs');
    assert.equal(metadata.lockfileSha256, lockfileSha256, 'Archive lockfile differs');
    const name = `rune-gui-shell-${metadata.platform}.${metadata.platform === 'windows' ? 'zip' : 'tar.gz'}`;
    assert.equal(metadata.archive, name, 'Unexpected archive name');
    const archive = inputs.find((path) => basename(path) === name);
    assert(archive, `Missing archive ${name}`);
    const digest = await sha256(archive);
    assert.equal(digest, metadata.archiveSha256, 'Archive differs from its tested build metadata');
    copyFileSync(archive, join(destination, name));
    copyFileSync(metadataFile, join(destination, `build-metadata-${metadata.platform}-x64.json`));
    archives.push({
      name,
      platform: metadata.platform,
      architecture: 'x64',
      sha256: digest,
      bytes: statSync(archive).size,
    });
  }
  archives.sort((left, right) => left.name.localeCompare(right.name));
  writeJson(join(destination, 'release-manifest.json'), {
    schemaVersion: 1,
    ...identity,
    signed: false,
    archives,
  });
  const notes = changelogNotes(
    identity.version,
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
  );
  writeFileSync(
    join(destination, 'release-notes.md'),
    `${notes}\n\n## GUI downloads\n\nThese x64 archives contain the RUNE GUI runtime; workflow manifests and their resources are supplied separately. Extract the archive before launching it.\n\nThe archives are unsigned. SHA256SUMS detects changed downloads; it is not a publisher signature. Runtime prerequisites and usage are documented in [release acceptance](https://github.com/MarcusKorinth/rune-setup/blob/${identity.tag}/docs/releasing.md).\n\nSource commit: ${identity.commit}\n`,
  );
  const checksums = [];
  for (const name of readdirSync(destination).sort())
    checksums.push(`${await sha256(join(destination, name))}  ${name}\n`);
  writeFileSync(join(destination, 'SHA256SUMS'), checksums.join(''));
  process.stdout.write(`Prepared GUI release ${identity.tag} from tested archives\n`);
}

async function publish() {
  const identity = releaseIdentity();
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Manual verification cannot publish');
  assert.equal(
    process.env.GITHUB_REF,
    `refs/tags/${identity.tag}`,
    'Publication requires the version tag',
  );
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(
    repository,
    'MarcusKorinth/rune-setup',
    'Publication is restricted to the project repository',
  );
  const manifest = readJson(join(destination, 'release-manifest.json'));
  for (const [key, value] of Object.entries(identity))
    assert.equal(manifest[key], value, 'Candidate identity differs');
  const files = filesBelow(destination);
  assert(
    files.every((path) => resolve(path) === join(destination, basename(path))),
    'Release files must be flat',
  );
  const checksumLines = readFileSync(join(destination, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const checksummed = new Set();
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9.-]+)$/u.exec(line);
    assert(match && !checksummed.has(match[2]), 'Invalid or duplicate checksum entry');
    assert.equal(await sha256(join(destination, match[2])), match[1], 'Prepared release changed');
    checksummed.add(match[2]);
  }
  assert.equal(checksummed.size + 1, files.length, 'Every release file must have a checksum');
  const endpoint = `repos/${repository}/releases`;
  const api = (path, args = []) => JSON.parse(command('gh', ['api', path, ...args]));
  const tagged = api(`repos/${repository}/commits/${identity.tag}`);
  assert.equal(tagged.sha, identity.commit, 'Remote tag moved since candidate verification');
  const existing = api(endpoint, ['--paginate', '--slurp'])
    .flat()
    .find((release) => release.tag_name === identity.tag);
  let release = existing;
  const notes = readFileSync(join(destination, 'release-notes.md'), 'utf8');
  if (!release) {
    command('gh', [
      'release',
      'create',
      identity.tag,
      '--repo',
      repository,
      '--verify-tag',
      '--draft',
      '--title',
      `RUNE ${identity.version}`,
      '--notes-file',
      join(destination, 'release-notes.md'),
    ]);
    release = api(`${endpoint}/tags/${identity.tag}`);
  }
  assert.equal(
    release.body.replace(/\r\n/gu, '\n').trim(),
    notes.trim(),
    'An existing release has different notes; it is left untouched',
  );
  assert(
    release.assets.every((asset) => files.some((path) => basename(path) === asset.name)),
    'An existing release has unexpected assets; it is left untouched',
  );
  for (const path of files) {
    const name = basename(path);
    const digest = `sha256:${await sha256(path)}`;
    const asset = release.assets.find((entry) => entry.name === name);
    if (asset) {
      assert.equal(asset.digest, digest, `Existing asset ${name} differs; it is never overwritten`);
    } else {
      assert(release.draft, 'A published release is missing an asset; it is left untouched');
      command('gh', ['release', 'upload', identity.tag, path, '--repo', repository]);
    }
  }
  release = api(`${endpoint}/${release.id}`);
  assert.equal(release.assets.length, files.length, 'Release asset count differs');
  for (const path of files)
    assert.equal(
      release.assets.find((asset) => asset.name === basename(path))?.digest,
      `sha256:${await sha256(path)}`,
      'Uploaded artifact digest differs',
    );
  if (release.draft) {
    api(`${endpoint}/${release.id}`, [
      '--method',
      'PATCH',
      '-F',
      'draft=false',
      '-F',
      `prerelease=${identity.version.includes('-')}`,
      '-f',
      `make_latest=${identity.version.includes('-') ? 'false' : 'legacy'}`,
    ]);
  }
  process.stdout.write(`Published verified GUI release ${identity.tag}\n`);
}

assert.equal(
  process.argv.length,
  3,
  'Usage: node scripts/gui-release.mjs validate|prepare|publish',
);
switch (process.argv[2]) {
  case 'validate':
    validate();
    break;
  case 'prepare':
    await prepare();
    break;
  case 'publish':
    await publish();
    break;
  default:
    throw new Error('Unknown GUI release operation');
}
