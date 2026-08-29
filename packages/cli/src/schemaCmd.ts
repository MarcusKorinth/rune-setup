/**
 * `rune schema [--output FILE] [--result]` (docs/architecture.md §4.1): the JSON Schema of
 * manifest v1 — or of the result file — generated from the zod schemas at call time, so it
 * can never drift from what `validate` enforces.
 */

import { writeFileSync } from 'node:fs';

import { manifestJsonSchema, resultJsonSchema } from '@rune/engine';

import type { CliIo } from './io.js';

export function schemaCommand(
  flags: { output?: string | undefined; result?: boolean | undefined },
  io: CliIo,
): void {
  const schema = flags.result === true ? resultJsonSchema() : manifestJsonSchema();
  const text = JSON.stringify(schema, null, 2);
  if (flags.output !== undefined) {
    writeFileSync(flags.output, `${text}\n`, 'utf8');
    io.stderr(`schema written to ${flags.output}`);
    return;
  }
  io.stdout(text);
}
