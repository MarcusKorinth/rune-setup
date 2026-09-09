/** Shared headless and windowed progress rendering through the Session's masked sink. */

import {
  formatSessionTerminalLine,
  type ChromeKey,
  type RunEvent,
  type Session,
} from '@rune/engine';

import type { ShellStreams } from './streams.js';

export async function writeSessionChromeDiagnostic(
  session: Session,
  output: ShellStreams,
  key: ChromeKey,
  values?: Readonly<Record<string, string | number>>,
): Promise<void> {
  const strings = session.getStrings();
  await output.stderr.writeAndWait(
    `${formatSessionTerminalLine(strings, strings.chrome(key, values))}\n`,
  );
}

/** Renders the shell's copy of the shared run-event stream to diagnostic stderr. */
export function shellProgressObserver(
  session: Session,
  output: ShellStreams,
): (event: RunEvent) => Promise<void> {
  return async (event) => {
    switch (event.kind) {
      case 'runStarted':
        await writeSessionChromeDiagnostic(session, output, 'rune.progress.runStarted', {
          total: event.plan.steps.length,
          platform: event.plan.platform,
        });
        break;
      case 'stepStarted':
        await writeSessionChromeDiagnostic(session, output, 'rune.progress.step', {
          index: event.index + 1,
          total: event.total,
          title: event.title,
        });
        break;
      case 'stepOutput':
        await writeSessionChromeDiagnostic(session, output, 'rune.progress.output', {
          line: event.line,
        });
        break;
      case 'stepFinished': {
        const values = {
          state: event.state,
          durationMs: event.durationMs,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        };
        await writeSessionChromeDiagnostic(
          session,
          output,
          event.exitCode === undefined
            ? 'rune.progress.stepFinishedWithoutExitCode'
            : 'rune.progress.stepFinished',
          values,
        );
        break;
      }
      case 'runFinished':
        break;
    }
  };
}
