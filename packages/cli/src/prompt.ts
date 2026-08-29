/**
 * The interactive prompter (docs/architecture.md §9.3): Node readline over `pendingInputs()`
 * and `setValue()`, a muted echo for secrets, and the summary edit loop. Prompts are
 * diagnostics and go to stderr (§10); stdout stays reserved for requested output.
 */

import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';

import { CancelledError, InputError } from '@rune/engine';
import type { InputState, Session, StringTable } from '@rune/engine';

import type { CliIo } from './io.js';
import { renderPlan } from './render.js';

/** Where the prompter reads and writes — injected, so tests can script a whole session. */
export interface Interaction {
  readonly input: NodeJS.ReadableStream;
  readonly isTTY: boolean;
  /** Raw prompt text, no implied newline — stderr in the real process. */
  write(text: string): void;
  /** The documented second-Ctrl+C force quit (§9.3); `process.exit` in the real process. */
  forceExit(code: number): void;
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
      io.stderr(`  ${index + 1}) ${strings.inputTitle(state.id)} = ${displayValue(state)}`);
    });

    const choice = (
      await prompter.ask(
        `${strings.chrome('rune.summary.proceed')} (p) / ` +
          `${strings.chrome('rune.summary.change')} <n> / ` +
          `${strings.chrome('rune.summary.cancel')} (c): `,
      )
    )
      .trim()
      .toLowerCase();

    if (choice === 'p' || choice === 'proceed' || choice === '') {
      return 'proceed';
    }
    if (choice === 'c' || choice === 'cancel') {
      return 'cancel';
    }
    const index = Number.parseInt(choice, 10);
    const chosen = editable[index - 1];
    if (Number.isNaN(index) || chosen === undefined) {
      io.stderr(`"${choice}" is not p, c, or the number of a value`);
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
      spec.type === 'select'
        ? 'enter the value of one option'
        : 'enter option values, separated by commas',
    );
  }
  if (spec.type === 'boolean') {
    lines.push('enter true or false');
  }
  for (const line of lines) {
    prompter.say(line);
  }
  return `${strings.chrome('rune.prompt.value', { title })}: `;
}

function displayValue(state: InputState): string {
  const value = state.value;
  if (value === undefined) {
    return '(not set)';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  // A SecretString renders itself as *** — exactly what a summary should show.
  return String(value);
}
