#!/usr/bin/env node
import { CancelToken } from '@rune/engine';

import { bootstrap } from './bootstrap.js';
import { CLI_CANCELLATION_SIGNALS, createSignalController } from './signals.js';

const cancel = new CancelToken();
const signals = createSignalController(cancel, (code) => process.exit(code));
for (const signal of CLI_CANCELLATION_SIGNALS) {
  process.on(signal, signals.handle);
}

try {
  process.exitCode = await bootstrap(
    process.argv.slice(2),
    { stdout: process.stdout, stderr: process.stderr },
    {
      control: { cancel },
      setExitCode: (code) => {
        process.exitCode = code;
      },
    },
  );
} finally {
  for (const signal of CLI_CANCELLATION_SIGNALS) {
    process.off(signal, signals.handle);
  }
}
