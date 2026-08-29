/**
 * `rune validate` (docs/architecture.md §4.1, §4.3): stages 1–2 of the pipeline, every
 * locale overlay checked, followed by the environment-variable audit report. The report is
 * requested machine-readable-ish output and goes to stdout (§10).
 */

import { dirname, resolve } from 'node:path';

import { discoverOverlays, formatLocation, loadOverlay, validateManifest } from '@rune/engine';

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
  const report = validateManifest(absolute);
  const { manifest } = report;

  // `validate` checks ALL overlays, not just the selected locale's: an author wants to know
  // about a broken translation before a user in that locale does (§6.3, §7 stage 1).
  const overlays = discoverOverlays(dirname(absolute));
  for (const overlay of overlays) {
    loadOverlay(overlay.path, overlay.locale, manifest);
  }

  io.stdout(
    `${manifestPath} is valid (schemaVersion ${manifest.schemaVersion}, ` +
      `product ${manifest.product.name} ${manifest.product.version})`,
  );
  io.stdout(
    overlays.length === 0
      ? 'locales: none'
      : `locales: ${overlays.map((overlay) => overlay.locale).join(', ')}`,
  );

  if (report.environment.length === 0) {
    io.stdout('environment variables read: none');
    return;
  }
  io.stdout('environment variables read:');
  for (const use of report.environment) {
    for (const location of use.locations) {
      io.stdout(`  ${use.name} — ${formatLocation(location)}`);
    }
  }
}
