/**
 * The interactive prompter (docs/architecture.md §9.3): Node readline over `pendingInputs()`
 * and `setValue()`, a muted echo for secrets, and the summary edit loop. Prompts are
 * diagnostics and go to stderr (§10); stdout stays reserved for requested output.
 */

import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';

import {
  CancelledError,
  formatRuneError,
  formatSessionTerminalLine,
  InputError,
  InternalError,
} from '@rune/engine';
import type { CancelToken, InputState, InputType, Session, StringTable } from '@rune/engine';

import { sessionHumanStderr, type CliIo } from './io.js';
import { renderPlan } from './render.js';

const MASK = '***';
const SUMMARY_ACTIONS = Object.freeze({
  proceed: Object.freeze({ alias: 'proceed', tokenKey: 'rune.summary.proceedToken' as const }),
  cancel: Object.freeze({ alias: 'cancel', tokenKey: 'rune.summary.cancelToken' as const }),
});

/** Where the prompter reads and writes — injected, so tests can script a whole session. */
export interface Interaction {
  readonly input: NodeJS.ReadableStream;
  readonly isTTY: boolean;
  /** Raw prompt text, no implied newline — stderr in the real process. */
  write(text: string): void;
}

/** Everything the readline layer needs to render and ask one input question. */
export interface CliPromptPresentation {
  readonly lines: readonly string[];
  readonly question: string;
  readonly muted: boolean;
}

/** Presentation-only counterpart of one engine input type (docs/architecture.md §13). */
export interface CliPromptPresenter {
  readonly name: InputType;
  present(state: InputState, strings: StringTable): CliPromptPresentation;
}

/** The CLI's explicit name-to-presenter registry; it never validates input values. */
export class CliPromptRegistry {
  readonly #presenters = new Map<string, CliPromptPresenter>();

  constructor(presenters: Iterable<CliPromptPresenter> = []) {
    for (const presenter of presenters) {
      this.register(presenter);
    }
  }

  register(presenter: CliPromptPresenter): void {
    if (this.#presenters.has(presenter.name)) {
      throw new InternalError(
        `the CLI prompt presenter for input type "${presenter.name}" is registered twice`,
      );
    }
    this.#presenters.set(presenter.name, presenter);
  }

  get(name: string): CliPromptPresenter {
    const presenter = this.#presenters.get(name);
    if (presenter === undefined) {
      throw new InternalError(`no CLI prompt presenter is registered for input type "${name}"`);
    }
    return presenter;
  }

  names(): readonly string[] {
    return [...this.#presenters.keys()];
  }

  /** The fail-fast session-open check required by docs/architecture.md §9.3. */
  assertPresentable(states: Iterable<InputState>): void {
    for (const state of states) {
      this.get(state.spec.type);
    }
  }
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
  readonly #inputEndedMessage: string;
  readonly #cancel: CancelToken | undefined;
  readonly #output: MutedOutput;
  #rl: Interface | undefined;
  #reject: ((error: Error) => void) | undefined;
  #disposeCancel: (() => void) | undefined;
  #inputEnded = false;

  constructor(interaction: Interaction, inputEndedMessage: string, cancel?: CancelToken) {
    this.#interaction = interaction;
    this.#inputEndedMessage = inputEndedMessage;
    this.#cancel = cancel;
    this.#output = new MutedOutput(interaction.write);
  }

  /** Asks one question; `muted` suppresses the echo while a secret is typed. */
  ask(question: string, muted = false): Promise<string> {
    if (this.#cancel?.isCancelled === true) {
      return Promise.reject(new CancelledError());
    }
    if (this.#inputEnded) {
      return Promise.reject(new CancelledError(this.#inputEndedMessage));
    }
    const rl = this.#interface();
    const promise = new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        this.#output.muted = false;
        this.#reject = undefined;
        this.#disposeCancel?.();
        this.#disposeCancel = undefined;
        return true;
      };
      this.#reject = (error) => {
        if (settle()) {
          reject(error);
        }
      };
      rl.question(question, (answer) => {
        if (settle()) {
          if (muted) {
            this.#interaction.write('\n');
          }
          resolve(answer);
        }
      });
      this.#disposeCancel = this.#cancel?.onCancel(() => {
        this.#reject?.(new CancelledError());
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
    this.#disposeCancel?.();
    this.#disposeCancel = undefined;
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
        this.#inputEnded = true;
        this.#output.muted = false;
        this.#reject?.(new CancelledError(this.#inputEndedMessage));
      });
    }
    return this.#rl;
  }
}

function basePresentation(
  state: InputState,
  strings: StringTable,
  typeLines: readonly string[] = [],
  muted = false,
): CliPromptPresentation {
  const description = strings.inputDescription(state.id);
  return {
    lines: description === undefined ? typeLines : [description, ...typeLines],
    question: `${strings.chrome('rune.prompt.value', { title: strings.inputTitle(state.id) })}: `,
    muted,
  };
}

function optionPresentation(state: InputState, strings: StringTable): CliPromptPresentation {
  const spec = state.spec;
  if (spec.type !== 'select' && spec.type !== 'multiselect') {
    throw new InternalError(
      `the CLI option presenter received the input type "${spec.type}" for "${state.id}"`,
    );
  }
  const lines = spec.options.map((option) => {
    const value = option;
    return `  - ${strings.optionLabel(state.id, value)} (${value})`;
  });
  lines.push(
    strings.chrome(spec.type === 'select' ? 'rune.prompt.selectOne' : 'rune.prompt.selectMany'),
  );
  return basePresentation(state, strings, lines);
}

/** Exactly the seven public MVP input types, each registered deliberately. */
export const cliPromptPresenters = new CliPromptRegistry([
  { name: 'text', present: (state, strings) => basePresentation(state, strings) },
  { name: 'secret', present: (state, strings) => basePresentation(state, strings, [], true) },
  {
    name: 'boolean',
    present: (state, strings) =>
      basePresentation(state, strings, [strings.chrome('rune.prompt.boolean')]),
  },
  { name: 'select', present: optionPresentation },
  { name: 'multiselect', present: optionPresentation },
  { name: 'file', present: (state, strings) => basePresentation(state, strings) },
  { name: 'directory', present: (state, strings) => basePresentation(state, strings) },
]);

/**
 * Prompts for every pending input, in declaration order, until nothing is missing. A
 * rejected value re-prompts with the engine-owned diagnostic (§9.3).
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
  spelled: { readonly manifestPath: string; readonly logFile: string | undefined },
): Promise<'proceed' | 'cancel'> {
  const strings = session.getStrings();
  // The summary is a prompt, not requested machine output — everything goes to stderr.
  const stderrOnly: CliIo = { stdout: io.stderr, stderr: io.stderr };

  for (;;) {
    sessionHumanStderr(io, strings, '');
    sessionHumanStderr(io, strings, strings.chrome('rune.summary.heading'));
    const plan = session.plan();
    renderPlan(plan, session.manifest.product, spelled, stderrOnly, strings);
    const editable = session.allInputs().filter((state) => state.enabled);
    editable.forEach((state, index) => {
      sessionHumanStderr(
        io,
        strings,
        `  ${index + 1}) ${strings.inputTitle(state.id)} = ${displayValue(state, strings)}`,
      );
    });

    const proceedToken = normalizeSummaryChoice(strings.chrome(SUMMARY_ACTIONS.proceed.tokenKey));
    const cancelToken = normalizeSummaryChoice(strings.chrome(SUMMARY_ACTIONS.cancel.tokenKey));
    for (;;) {
      const choice = normalizeSummaryChoice(
        await prompter.ask(
          formatSessionTerminalLine(
            strings,
            `${strings.chrome('rune.summary.proceed')} (${proceedToken}) / ` +
              `${strings.chrome('rune.summary.change')} <n> / ` +
              `${strings.chrome('rune.summary.cancel')} (${cancelToken}): `,
          ),
        ),
      );
      if (choice === proceedToken || choice === SUMMARY_ACTIONS.proceed.alias) {
        return 'proceed';
      }
      if (choice === cancelToken || choice === SUMMARY_ACTIONS.cancel.alias) {
        return 'cancel';
      }
      const index = /^\d+$/.test(choice) ? Number(choice) : Number.NaN;
      const chosen = Number.isSafeInteger(index) && index > 0 ? editable[index - 1] : undefined;
      if (chosen === undefined) {
        sessionHumanStderr(
          io,
          strings,
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
      break;
    }
  }
}

async function askUntilAccepted(
  session: Session,
  state: InputState,
  strings: StringTable,
  prompter: Prompter,
): Promise<void> {
  const presentation = cliPromptPresenters.get(state.spec.type).present(state, strings);
  for (const line of presentation.lines) {
    prompter.say(formatSessionTerminalLine(strings, line));
  }
  if (state.rejection !== undefined) {
    prompter.say(formatSessionTerminalLine(strings, state.rejection.issue.message));
  }
  for (;;) {
    const raw = await prompter.ask(
      formatSessionTerminalLine(strings, presentation.question),
      presentation.muted,
    );
    try {
      session.setValue(state.id, raw);
      return;
    } catch (error) {
      if (!(error instanceof InputError)) {
        throw error;
      }
      prompter.say(formatSessionTerminalLine(strings, formatRuneError(error)));
    }
  }
}

function normalizeSummaryChoice(choice: string): string {
  return choice.trim().toLowerCase();
}

function displayValue(state: InputState, strings: StringTable): string {
  if (state.secret) {
    return MASK;
  }
  const value = state.value;
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (value === undefined) {
    return strings.chrome('rune.summary.notSet');
  }
  return String(value);
}
