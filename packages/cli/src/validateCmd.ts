/**
 * `rune validate` (docs/architecture.md §4.1, §4.3): stages 1–2 of the pipeline, every
 * locale overlay checked, followed by the environment-variable audit report. The report is
 * requested machine-readable-ish output and goes to stdout (§10).
 */

import { resolve } from 'node:path';

import { formatLocation, validateManifest } from '@rune/engine';

import { humanStdout, type CliIo } from './io.js';

export async function validateCommand(
  manifestPath: string,
  flags: { locale?: string | undefined },
  io: CliIo,
): Promise<void> {
  const absolute = resolve(manifestPath);
  const report = validateManifest(absolute, { locale: flags.locale });
  const { locales, manifest, strings } = report;

  humanStdout(
    io,
    strings.chrome('rune.validate.valid', {
      path: manifestPath,
      schemaVersion: manifest.schemaVersion,
      productName: manifest.product.name,
      productVersion: manifest.product.version,
    }),
  );
  humanStdout(
    io,
    locales.length === 0
      ? strings.chrome('rune.validate.locales.none')
      : strings.chrome('rune.validate.locales.list', { locales: locales.join(', ') }),
  );

  if (report.environment.length === 0) {
    humanStdout(io, strings.chrome('rune.validate.environment.none'));
    return;
  }
  humanStdout(io, strings.chrome('rune.validate.environment.heading'));
  for (const use of report.environment) {
    for (const location of use.locations) {
      humanStdout(
        io,
        strings.chrome('rune.validate.environment.entry', {
          name: use.name,
          location: formatLocation(location),
        }),
      );
    }
  }
}
