#!/usr/bin/env node
import { CancelToken, INTERNAL_EXIT_CODE } from '@rune/engine';

import { run } from './cli.js';
import { CLI_CANCELLATION_SIGNALS, createSignalController } from './signals.js';
import { guardStream } from './streams.js';

// A consumer that closes stdout or stderr early ends RUNE's output on that stream and nothing
// else: the run's exit code stands and no stack trace reaches the terminal (§10). Any other
// stdout error has lost requested machine output, and exit 0 would then be a false success
// signal on the automation contract: one fixed line — never the stream error itself — and the
// internal-error code. The hook sets the code itself because the error may arrive after run()
// has resolved; stderr diagnostics stay best-effort and never change the exit code.
const stderr = guardStream(process.stderr);
const stdout = guardStream(process.stdout, () => {
  stderr.writeLine('could not write the requested machine output to stdout');
  process.exitCode = INTERNAL_EXIT_CODE;
});
const cancel = new CancelToken();
const signals = createSignalController(cancel, (code) => process.exit(code));
for (const signal of CLI_CANCELLATION_SIGNALS) {
  process.on(signal, signals.handle);
}

try {
  const code = await run(
    process.argv.slice(2),
    { stdout: stdout.writeLine, stderr: stderr.writeLine },
    { cancel },
  );
  process.exitCode = stdout.failure() === undefined ? code : INTERNAL_EXIT_CODE;
} finally {
  for (const signal of CLI_CANCELLATION_SIGNALS) {
    process.off(signal, signals.handle);
  }
}
