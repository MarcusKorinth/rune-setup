/**
 * The interactive prompter (docs/architecture.md §9.3): Node readline over `pendingInputs()`
 * and `setValue()`, a muted echo for secrets, and the summary edit loop. Prompts are
 * diagnostics and go to stderr (§10); stdout stays reserved for requested output.
 */

import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';

import { CancelledError, InputError, normalizeSummaryChoice, SUMMARY_ACTIONS } from '@rune/engine';
import type { InputState, Session, StringTable } from '@rune/engine';

import type { CliIo } from './io.js';
import { renderPlan } from './render.js';

export type CancelSignal = 'SIGINT' | 'SIGTERM';

/** Process-signal subset used while a session executes; injectable to keep tests isolated. */
export interface SignalSource {
  on(signal: CancelSignal, listener: () => void): void;
  removeListener(signal: CancelSignal, listener: () => void): void;
}

/** Where the prompter reads and writes — injected, so tests can script a whole session. */
export interface Interaction {
  readonly input: NodeJS.ReadableStream;
  readonly isTTY: boolean;
  /** Raw prompt text, no implied newline — stderr in the real process. */
  write(text: string): void;
  /** The documented second-Ctrl+C force quit (§9.3); `process.exit` in the real process. */
  forceExit(code: number): void;
  /** Defaults to the host process; tests inject a private signal source. */
  readonly signalSource?: SignalSource | undefined;
}

/** A writable readline can echo through, with a switch for the muted secret echo. */
class MutedOutput extends Writable {
  muted = false;
  readonly #sink: (text: string) => void;

  constructor(sink: (text: string) => void) {
    super();
    this.#sink = sink;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      this.#sink(chunk.toString());
    }
    callback();
  }
}

export class Prompter {
  readonly #interaction: Interaction;
  readonly #output: MutedOutput;
  #rl: Interface | undefined;
  #reject: ((error: Error) => void) | undefined;

  constructor(interaction: Interaction) {
    this.#interaction = interaction;
    this.#output = new MutedOutput(interaction.write);
  }

  /** Asks one question; `muted` suppresses the echo while a secret is typed. */
  ask(question: string, muted = false): Promise<string> {
    const rl = this.#interface();
    const promise = new Promise<string>((resolve, reject) => {
      this.#reject = reject;
      rl.question(question, (answer) => {
        this.#output.muted = false;
        this.#reject = undefined;
        if (muted) {
          this.#interaction.write('\n');
        }
        resolve(answer);
      });
    });
    // The question text is already written; only the typed characters stay dark.
    this.#output.muted = muted;
    return promise;
  }

  /** One diagnostic line on the prompt stream — so scripted tests capture one stream. */
  say(line: string): void {
    this.#interaction.write(line + String.fromCharCode(10));
  }

  close(): void {
    this.#rl?.close();
    this.#rl = undefined;
  }

  #interface(): Interface {
    if (this.#rl === undefined) {
      this.#rl = createInterface({
        input: this.#interaction.input,
        output: this.#output,
        terminal: this.#interaction.isTTY,
        historySize: 0,
      });
      // Ctrl+C during a prompt, and a script that ran out of answers, both mean: stop.
      this.#rl.on('SIGINT', () => {
        this.#output.muted = false;
        this.#reject?.(new CancelledError());
      });
      this.#rl.on('close', () => {
        this.#output.muted = false;
        this.#reject?.(new CancelledError('input ended before every question was answered'));
      });
    }
    return this.#rl;
  }
}

/**
 * Prompts for every pending input, in declaration order, until nothing is missing. A
 * rejected value re-prompts with the message and the input's `patternHint` (§9.3).
 */
export async function promptForInputs(session: Session, prompter: Prompter): Promise<void> {
  const strings = session.getStrings();
  for (;;) {
    const pending = session.pendingInputs();
    const next = pending[0];
    if (next === undefined) {
      return;
    }
    await askUntilAccepted(session, next, strings, prompter);
  }
}

/**
 * The summary edit loop (§9.3): the plan rendered by the same renderer dry-run uses, then
 * `Proceed / Change value <n> / Cancel`. A change is an ordinary layer-5 setValue; newly
 * enabled missing inputs are prompted before the summary renders again.
 */
export async function summaryLoop(
  session: Session,
  prompter: Prompter,
  io: CliIo,
): Promise<'proceed' | 'cancel'> {
  const strings = session.getStrings();
  // The summary is a prompt, not requested machine output — everything goes to stderr.
  const stderrOnly: CliIo = { stdout: io.stderr, stderr: io.stderr };

  for (;;) {
    io.stderr('');
    io.stderr(strings.chrome('rune.summary.heading'));
    renderPlan(session.describe(), stderrOnly);
    const editable = session.allInputs().filter((state) => state.enabled);
    editable.forEach((state, index) => {
      io.stderr(
        `  ${index + 1}) ${strings.inputTitle(state.id)} = ${displayValue(state, strings)}`,
      );
    });

    const proceedToken = normalizeSummaryChoice(strings.chrome(SUMMARY_ACTIONS.proceed.tokenKey));
    const cancelToken = normalizeSummaryChoice(strings.chrome(SUMMARY_ACTIONS.cancel.tokenKey));
    const choice = normalizeSummaryChoice(
      await prompter.ask(
        `${strings.chrome('rune.summary.proceed')} (${proceedToken}) / ` +
          `${strings.chrome('rune.summary.change')} <n> / ` +
          `${strings.chrome('rune.summary.cancel')} (${cancelToken}): `,
      ),
    );

    if (choice === proceedToken || choice === SUMMARY_ACTIONS.proceed.alias || choice === '') {
      return 'proceed';
    }
    if (choice === cancelToken || choice === SUMMARY_ACTIONS.cancel.alias) {
      return 'cancel';
    }
    const index = Number.parseInt(choice, 10);
    const chosen = editable[index - 1];
    if (Number.isNaN(index) || chosen === undefined) {
      io.stderr(
        strings.chrome('rune.summary.invalidChoice', {
          choice,
          proceed: proceedToken,
          cancel: cancelToken,
        }),
      );
      continue;
    }
    await askUntilAccepted(session, chosen, strings, prompter);
    await promptForInputs(session, prompter);
  }
}

async function askUntilAccepted(
  session: Session,
  state: InputState,
  strings: StringTable,
  prompter: Prompter,
): Promise<void> {
  const question = questionFor(state, strings, prompter);
  for (;;) {
    const raw = await prompter.ask(question, state.spec.type === 'secret');
    try {
      session.setValue(state.id, raw);
      return;
    } catch (error) {
      if (!(error instanceof InputError)) {
        throw error;
      }
      prompter.say(error.message);
      const hint = strings.patternHint(state.id);
      if (hint !== undefined) {
        prompter.say(hint);
      }
    }
  }
}

function questionFor(state: InputState, strings: StringTable, prompter: Prompter): string {
  const title = strings.inputTitle(state.id);
  const lines: string[] = [];
  const description = strings.inputDescription(state.id);
  if (description !== undefined) {
    lines.push(description);
  }
  const spec = state.spec;
  if (spec.type === 'select' || spec.type === 'multiselect') {
    for (const option of spec.options) {
      const value = typeof option === 'string' ? option : option.value;
      lines.push(`  - ${strings.optionLabel(state.id, value)} (${value})`);
    }
    lines.push(
      strings.chrome(spec.type === 'select' ? 'rune.prompt.selectOne' : 'rune.prompt.selectMany'),
    );
  }
  if (spec.type === 'boolean') {
    lines.push(strings.chrome('rune.prompt.boolean'));
  }
  for (const line of lines) {
    prompter.say(line);
  }
  return `${strings.chrome('rune.prompt.value', { title })}: `;
}

function displayValue(state: InputState, strings: StringTable): string {
  const value = state.value;
  if (value === undefined) {
    return strings.chrome('rune.summary.notSet');
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  // A SecretString renders itself as *** — exactly what a summary should show.
  return String(value);
}
