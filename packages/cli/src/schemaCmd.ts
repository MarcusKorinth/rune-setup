/**
 * `rune schema [--output FILE] [--result]` (docs/architecture.md §4.1): the JSON Schema of
 * manifest v1 — or of the result file — generated from the zod schemas at call time, so it
 * can never drift from what `validate` enforces.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { manifestJsonSchema, resultJsonSchema, UsageError } from '@rune/engine';

import { humanStderr, type CliIo } from './io.js';

export function schemaCommand(
  flags: { output?: string | undefined; result?: boolean | undefined },
  io: CliIo,
): void {
  const schema = flags.result === true ? resultJsonSchema() : manifestJsonSchema();
  const text = JSON.stringify(schema, null, 2);
  if (flags.output !== undefined) {
    try {
      mkdirSync(dirname(flags.output), { recursive: true });
      writeFileSync(flags.output, `${text}\n`, 'utf8');
    } catch (cause) {
      // A destination the caller cannot write to is CLI misuse, not a RUNE bug (§10). The
      // errno code is a fixed token; the raw OS message stays internal as the cause.
      const code = errnoCode(cause);
      throw new UsageError(
        `cannot write --output "${flags.output}"${code === undefined ? '' : ` (${code})`}`,
        { cause },
      );
    }
    humanStderr(io, `schema written to ${flags.output}`);
    return;
  }
  io.stdout(text);
}

/**
 * @internal Exported so the shape guard can be pinned directly; not part of the CLI's API.
 *
 * Mirrors the engine's own errno guard rather than importing it: the engine keeps that helper
 * package-internal, and `--output` is a CLI-owned usage error, not an operational sink failure.
 */
export function errnoCode(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || !('code' in cause) || typeof cause.code !== 'string') {
    return undefined;
  }
  return /^E[A-Z0-9]+$/u.test(cause.code) ? cause.code : undefined;
}
