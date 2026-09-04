#!/usr/bin/env node
import { CancelToken } from '@rune/engine';

import { run, type CliIo } from './cli.js';
import { CLI_CANCELLATION_SIGNALS, createSignalController } from './signals.js';
import { guardStream } from './streams.js';

// A consumer that closes stdout or stderr early ends RUNE's output on that stream and nothing
// else: the run's exit code stands and no stack trace reaches the terminal (§10).
const io: CliIo = {
  stdout: guardStream(process.stdout).writeLine,
  stderr: guardStream(process.stderr).writeLine,
};
const cancel = new CancelToken();
const signals = createSignalController(cancel, (code) => process.exit(code));
for (const signal of CLI_CANCELLATION_SIGNALS) {
  process.on(signal, signals.handle);
}

try {
  process.exitCode = await run(process.argv.slice(2), io, { cancel });
} finally {
  for (const signal of CLI_CANCELLATION_SIGNALS) {
    process.off(signal, signals.handle);
  }
}
