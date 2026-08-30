#!/usr/bin/env node
import { CancelToken } from '@rune/engine';

import { run } from './cli.js';
import { CLI_CANCELLATION_SIGNALS, createSignalController } from './signals.js';

const cancel = new CancelToken();
const signals = createSignalController(cancel, (code) => process.exit(code));
for (const signal of CLI_CANCELLATION_SIGNALS) {
  process.on(signal, signals.handle);
}

try {
  process.exitCode = await run(process.argv.slice(2), undefined, { cancel });
} finally {
  for (const signal of CLI_CANCELLATION_SIGNALS) {
    process.off(signal, signals.handle);
  }
}
