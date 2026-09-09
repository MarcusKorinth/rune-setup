import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const shellRequire = createRequire(join(root, 'packages/gui-shell/package.json'));
// Use the resource readers shipped with the pinned packaging toolchain.
const builderRequire = createRequire(shellRequire.resolve('app-builder-lib/package.json'));
const { extractFile } = builderRequire('@electron/asar');

/** Inspect the extracted deliverable, including the actual Windows PE resources. */
export function verifyShellBranding(unpacked, version) {
  const artwork = join(root, 'packages/gui-shell/resources');
  assert.deepEqual(
    extractFile(join(unpacked, 'resources/app.asar'), 'resources/icon.png'),
    readFileSync(join(artwork, 'icon.png')),
    'The distributed window icon must match the RUNE artwork',
  );
  if (process.platform !== 'win32') return;

  const { NtExecutable, NtExecutableResource, Resource, Data } = builderRequire('resedit');
  for (const name of ['rune-gui-shell', 'rune-gui-shell-bin']) {
    const binary = NtExecutable.from(readFileSync(join(unpacked, `${name}.exe`)));
    const { entries } = NtExecutableResource.from(binary);
    const versions = Resource.VersionInfo.fromEntries(entries);
    assert.equal(versions.length, 1, 'The executable must have product version information');
    const translations = versions[0].getAllLanguagesForStringValues();
    assert(translations.length > 0);
    for (const language of translations) {
      const values = versions[0].getStringValues(language);
      assert.equal(values.ProductName, 'RUNE');
      assert.equal(values.FileDescription, 'RUNE');
      assert.equal(values.CompanyName, 'Marcus Korinth');
      assert.equal(values.InternalName, name);
      assert.equal(values.FileVersion, version.match(/^\d+\.\d+\.\d+/u)?.[0]);
    }

    const expected = Data.IconFile.from(readFileSync(join(artwork, 'icon.ico')));
    const groups = Resource.IconGroupEntry.fromEntries(entries);
    assert.equal(groups.length, 1, 'The executable must contain the RUNE icon group');
    const actual = groups[0].getIconItemsFromEntries(entries);
    assert.equal(actual.length, expected.icons.length);
    for (const [index, icon] of actual.entries()) {
      const reference = expected.icons[index].data;
      assert(icon.isRaw() && reference.isRaw(), 'The icon sizes must contain PNG image data');
      assert.deepEqual(Buffer.from(icon.bin), Buffer.from(reference.bin));
    }
  }
}
