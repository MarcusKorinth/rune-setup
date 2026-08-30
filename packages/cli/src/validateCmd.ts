/**
 * `rune validate` (docs/architecture.md §4.1, §4.3): stages 1–2 of the pipeline, every
 * locale overlay checked, followed by the environment-variable audit report. The report is
 * requested machine-readable-ish output and goes to stdout (§10).
 */

import { resolve } from 'node:path';

import { formatLocation, validateManifest } from '@rune/engine';

import { parsePlatform } from './args.js';
import type { CliIo } from './io.js';

export async function validateCommand(
  manifestPath: string,
  flags: { platform?: string | undefined; locale?: string | undefined },
  io: CliIo,
): Promise<void> {
  // Validation is fully static, but a bogus value must fail the same way run fails it.
  parsePlatform(flags.platform);
  const absolute = resolve(manifestPath);
  const report = validateManifest(absolute, { locale: flags.locale });
  const { locales, manifest, strings } = report;

  io.stdout(
    strings.chrome('rune.validate.valid', {
      path: manifestPath,
      schemaVersion: manifest.schemaVersion,
      productName: manifest.product.name,
      productVersion: manifest.product.version,
    }),
  );
  io.stdout(
    locales.length === 0
      ? strings.chrome('rune.validate.locales.none')
      : strings.chrome('rune.validate.locales.list', { locales: locales.join(', ') }),
  );

  if (report.environment.length === 0) {
    io.stdout(strings.chrome('rune.validate.environment.none'));
    return;
  }
  io.stdout(strings.chrome('rune.validate.environment.heading'));
  for (const use of report.environment) {
    for (const location of use.locations) {
      io.stdout(
        strings.chrome('rune.validate.environment.entry', {
          name: use.name,
          location: formatLocation(location),
        }),
      );
    }
  }
}
