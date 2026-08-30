/**
 * The Session facade (docs/architecture.md §9.1) — the ONLY frontend entry point.
 *
 * GUI, interactive CLI, and non-interactive automation all drive one session the same way:
 * open, ask what is pending, set values, plan, execute. Nothing engine-side is reachable
 * any other way, which is what makes mode parity a construction rather than a promise.
 */

import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import { snapshotEnvironment, type Environment } from '../environment.js';
import {
  InputError,
  InternalError,
  projectRuneError,
  RuneError,
  type RuneIssue,
} from '../errors.js';
import type { InputValue } from '../inputs/base.js';
import { environmentName } from '../manifest/v1/rules.js';
import { parseManifestWithMetadata, type Manifest } from '../manifest/index.js';
import { startOfFile } from '../manifest/source.js';
import { discoverOverlays, matchOverlay, selectLocale } from '../i18n/locale.js';
import { loadOverlay, type LocaleOverlay } from '../i18n/overlay.js';
import { resolveStrings, type StringTable } from '../i18n/strings.js';
import { createLogFileSink } from '../logs/logFile.js';
import type { Runner } from '../runners/base.js';
import type { RunMode, RunResult } from '../results/model.js';
import { CancelToken } from './cancel.js';
import {
  createRuntimeContext,
  hostPlatform,
  type Platform,
  type RuntimeContext,
} from './context.js';
import { createCompletedRunFailureResult, describePlan, executeRun } from './executor.js';
import type { EngineObserver, RunEvent, RunFinished } from './events.js';
import {
  parseValuesFile,
  resolveInputs,
  type InputState,
  type Resolution,
  type ValuesDocument,
} from './inputs.js';
import { buildPlan, projectPlanForSink, type ExecutionPlan } from './plan.js';
import { MASK_FOR_SINK, SecretRegistry } from './secrets.js';

/** Produced by {@link Session.setValue} whenever a controlling value flips an input's `when:`. */
export interface InputStateChanged {
  readonly inputId: string;
  readonly enabled: boolean;
}

/** The `gui:` block with paths made absolute; empty when the manifest has none (§9.1). */
export interface ThemeConfig {
  readonly accentColor?: string | undefined;
  readonly logo?: string | undefined;
  readonly banner?: string | undefined;
  readonly theme?: string | undefined;
  readonly windowTitle?: string | undefined;
}

export interface SessionOptions {
  /** The frontend driving this shared engine session. */
  readonly mode?: RunMode | undefined;
  /** `--values` file paths, in order (layer 2). */
  readonly values?: readonly string[] | undefined;
  /** `--set` key=value pairs, already split (layer 4); `RUNE_INPUT_*` comes from the environment. */
  readonly overrides?: Readonly<Record<string, string>> | undefined;
  /** `--locale`; beats `RUNE_LOCALE` and the system locale (§6.3). */
  readonly locale?: string | undefined;
  /** A foreign platform to preview — `validate` and `--dry-run` only; such a plan never executes. */
  readonly platform?: Platform | undefined;
  /** `--log-file`; overrides the manifest's `execution.logFile` (§10). */
  readonly logFile?: string | undefined;
  /** Defaults to this process's environment. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  /** What the operating system reports; defaults to `Intl`. Injected so hosts and tests own it. */
  readonly systemLocale?: string | undefined;
  /** The runner steps spawn through; the default is the real one. The §13 seam and test seam. */
  readonly runner?: Runner | undefined;
}

interface ActiveExecution {
  readonly cancel: CancelToken;
}

export class Session {
  readonly manifest: Manifest;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly mode: RunMode;
  readonly platform: Platform;
  readonly preview: boolean;
  readonly #context: RuntimeContext;
  readonly #secrets: SecretRegistry;
  readonly #strings: StringTable;
  readonly #values: readonly ValuesDocument[];
  readonly #overrides: ReadonlyMap<string, string>;
  readonly #environment: Environment;
  readonly #answers = new Map<string, unknown>();
  readonly #logFile: string | undefined;
  readonly #runner: Runner | undefined;
  #resolution: Resolution;
  #plan: ExecutionPlan | undefined;
  #activeExecution: ActiveExecution | undefined;

  private constructor(fields: {
    manifest: Manifest;
    manifestPath: string;
    manifestSha256: string;
    mode: RunMode;
    context: RuntimeContext;
    secrets: SecretRegistry;
    strings: StringTable;
    values: readonly ValuesDocument[];
    overrides: ReadonlyMap<string, string>;
    environment: Environment;
    resolution: Resolution;
    logFile: string | undefined;
    runner: Runner | undefined;
  }) {
    this.manifest = fields.manifest;
    this.manifestPath = fields.manifestPath;
    this.manifestSha256 = fields.manifestSha256;
    this.mode = fields.mode;
    this.platform = fields.context.platform;
    this.preview = fields.context.preview;
    this.#context = fields.context;
    this.#secrets = fields.secrets;
    this.#strings = fields.strings;
    this.#values = fields.values;
    this.#overrides = fields.overrides;
    this.#environment = fields.environment;
    this.#resolution = freezeResolution(fields.resolution);
    this.#logFile = fields.logFile;
    this.#runner = fields.runner;
    this.#plan = undefined;
    // Public readonly fields and facade methods must be readonly in JavaScript too. Private
    // slots remain mutable, so answers, resolution, execution, and cancellation still work.
    Object.freeze(this);
  }

  /** Opens a session: load, validate, resolve layers 1–4 — stages 1–3 of the pipeline (§7). */
  static async open(manifestPath: string, options: SessionOptions = {}): Promise<Session> {
    const absolutePath = resolvePath(manifestPath);
    const manifestDir = dirname(absolutePath);
    const parsed = parseManifestWithMetadata(absolutePath);
    const manifest = parsed.manifest;
    // A session is a snapshot of its opening invocation. Keeping a caller-owned environment
    // object would let later mutations change input resolution or interpolation after open.
    const environment = snapshotEnvironment(options.environment);

    const locale = selectLocale({
      flag: options.locale,
      environment,
      systemLocale: options.systemLocale ?? systemLocale(),
    });
    let overlay: LocaleOverlay | undefined;
    if (locale !== undefined) {
      const match = matchOverlay(locale, discoverOverlays(manifestDir));
      overlay = match === undefined ? undefined : loadOverlay(match.path, match.locale, manifest);
    }
    const strings = resolveStrings({ manifest, locale, overlay });

    const context = createRuntimeContext({
      manifestDir,
      product: manifest.product,
      platform: options.platform ?? hostPlatform(),
      environment,
    });

    const values = (options.values ?? []).map((path) => parseValuesFile(resolvePath(path), path));
    const overrides = new Map(Object.entries(options.overrides ?? {}));
    const secrets = new SecretRegistry();
    let resolution: Resolution;
    try {
      resolution = resolveInputs({
        manifest,
        context,
        values,
        environment,
        overrides,
        secrets,
      });
    } catch (error) {
      throw error instanceof RuneError
        ? projectRuneError(error, (text) => secrets.mask(text))
        : error;
    }

    return new Session({
      manifest,
      manifestPath,
      manifestSha256: parsed.sha256,
      mode: options.mode ?? 'non-interactive',
      context,
      secrets,
      strings,
      values,
      overrides,
      environment,
      // All-or-nothing: a value no type accepts, or a key naming no input, threw above and
      // no session exists (§10).
      resolution,
      logFile: effectiveLogFile(options.logFile, manifest, manifestDir),
      runner: options.runner,
    });
  }

  /** Enabled required inputs still without an answer, in declaration order — what to ask for. */
  pendingInputs(): readonly InputState[] {
    const missing = new Set(this.#resolution.missing);
    return Object.freeze(this.#resolution.inputs.filter((state) => missing.has(state.id)));
  }

  /** Every input with its resolved state — what a GUI prefills (§9.1). */
  allInputs(): readonly InputState[] {
    return this.#resolution.inputs;
  }

  /** Warnings a frontend should say out loud but not fail over (§5, §10). */
  warnings(): readonly string[] {
    return this.#resolution.warnings;
  }

  /**
   * Answers one input (layer 5). The value goes through the type registry like every other
   * layer — a rejected value throws {@link InputError} and changes nothing. Returns which
   * inputs' `when:` flipped, for live enable/disable in the GUI (§9.1).
   */
  setValue(id: string, raw: unknown): readonly InputStateChanged[] {
    if (this.#activeExecution !== undefined) {
      throw new InternalError('cannot set a session value while execution is active');
    }
    if (!(id in this.manifest.inputs)) {
      throw new InputError('RUNE-203', `"${id}" names no input of this manifest`);
    }
    const before = this.#resolution;
    const hadPrevious = this.#answers.has(id);
    const previous = this.#answers.get(id);
    // Keep caller-owned arrays outside the engine authority. SecretString and scalar values
    // pass through unchanged; cloning a SecretString would either break it or expose it.
    this.#answers.set(id, Array.isArray(raw) ? [...raw] : raw);
    let after: Resolution;
    try {
      after = this.#resolve();
    } catch (error) {
      // Restore, never delete: a rejected edit must not discard an earlier accepted answer.
      if (hadPrevious) {
        this.#answers.set(id, previous);
      } else {
        this.#answers.delete(id);
      }
      throw this.#projectError(error);
    }
    this.#resolution = after;
    this.#plan = undefined;

    const changes: InputStateChanged[] = [];
    for (const state of after.inputs) {
      if (before.byId.get(state.id)?.enabled !== state.enabled) {
        changes.push({ inputId: state.id, enabled: state.enabled });
      }
    }
    return Object.freeze(changes.map((change) => Object.freeze(change)));
  }

  /** Stage 4: the frozen plan. Throws listing EVERY missing input with its accepted sources. */
  plan(): ExecutionPlan {
    return projectPlanForSink(this.#executionPlan(), this.#secrets);
  }

  /** The dry-run result: the plan described, nothing executed (§10, status `planned`). */
  describe(): RunResult {
    return describePlan({
      plan: this.#executionPlan(),
      product: this.manifest.product,
      secrets: this.#secrets,
      mode: this.mode,
    });
  }

  /** Stages 5 and 6: runs the plan; resolves with the result when the run is over. */
  async execute(observer?: EngineObserver, cancel?: CancelToken): Promise<RunResult> {
    if (this.#activeExecution !== undefined) {
      throw new InternalError('a session cannot have more than one active execution');
    }

    const plan = this.#executionPlan();
    const activeExecution = { cancel: cancel ?? new CancelToken() };
    this.#activeExecution = activeExecution;
    let log: Awaited<ReturnType<typeof createLogFileSink>> | undefined;
    let closeAttempted = false;
    let completed: RunResult | undefined;
    let terminal: RunFinished | undefined;
    try {
      const logFile = plan.executionOptions.logFile;
      log = logFile === null ? undefined : await createLogFileSink(logFile);
      const observers: EngineObserver = (event) => {
        notifyObserver(log?.observer, event);
        if (event.kind === 'runFinished') {
          terminal = event;
        } else {
          notifyObserver(observer, event);
        }
      };
      completed = await executeRun({
        plan,
        product: this.manifest.product,
        secrets: this.#secrets,
        mode: this.mode,
        observer: observers,
        cancel: activeExecution.cancel,
        ...(this.#runner === undefined ? {} : { runner: this.#runner }),
      });
      if (terminal === undefined || terminal.result !== completed) {
        throw new InternalError('the executor completed without its matching RunFinished event');
      }

      // The log sees the executor's terminal candidate so its write participates in close().
      // The frontend sees no terminal event until that engine-owned sink has finalized.
      closeAttempted = true;
      await log?.close();
      notifyObserver(observer, terminal);
      return completed;
    } catch (error) {
      let failure = error;
      if (log !== undefined && !closeAttempted) {
        closeAttempted = true;
        try {
          await log.close();
        } catch (closeError) {
          failure = closeError;
        }
      }

      const projected = this.#projectError(failure);
      const terminalResult = completed ?? terminal?.result;
      if (terminalResult !== undefined) {
        const runError =
          projected instanceof RuneError
            ? projected
            : new InternalError('an unexpected error escaped run finalization', {
                cause: projected,
              });
        const result = createCompletedRunFailureResult(runError, terminalResult);
        notifyObserver(observer, Object.freeze({ kind: 'runFinished', result }));
        throw runError;
      }
      throw projected;
    } finally {
      if (this.#activeExecution === activeExecution) {
        this.#activeExecution = undefined;
      }
    }
  }

  /** Fires the CancelToken of the running {@link execute} — the one flow for all frontends. */
  cancel(): void {
    this.#activeExecution?.cancel.cancel();
  }

  /** The fully resolved string table for the session's locale (§6.3). */
  getStrings(): StringTable {
    return this.#strings;
  }

  /** The `gui:` block, paths absolute; an empty object when the manifest has none. */
  getThemeConfig(): ThemeConfig {
    const gui = this.manifest.gui;
    if (gui === undefined) {
      return {};
    }
    const anchor = (path: string | undefined): string | undefined =>
      path === undefined || isAbsolute(path) ? path : resolvePath(this.#context.manifestDir, path);
    return {
      ...(gui.accentColor === undefined ? {} : { accentColor: gui.accentColor }),
      ...(gui.logo === undefined ? {} : { logo: anchor(gui.logo) }),
      ...(gui.banner === undefined ? {} : { banner: anchor(gui.banner) }),
      ...(gui.theme === undefined ? {} : { theme: anchor(gui.theme) }),
      ...(gui.windowTitle === undefined
        ? {}
        : { windowTitle: this.#strings.windowTitle() ?? gui.windowTitle }),
    };
  }

  /** Engine-internal sink capability used by createFailureResult; never exported publicly. */
  [MASK_FOR_SINK](text: string): string {
    return this.#secrets.mask(text);
  }

  #executionPlan(): ExecutionPlan {
    try {
      const missing = this.#resolution.missing;
      if (missing.length > 0) {
        throw InputError.fromIssues(
          'RUNE-201',
          missing.map((id) => this.#missingIssue(id)),
        );
      }
      if (this.#plan !== undefined) {
        return this.#plan;
      }
      this.#plan = buildPlan({
        manifest: this.manifest,
        manifestPath: this.manifestPath,
        manifestSha256: this.manifestSha256,
        resolution: this.#resolution,
        context: this.#context,
        logFile: this.#logFile,
        strings: this.#strings,
      });
      return this.#plan;
    } catch (error) {
      throw this.#projectError(error);
    }
  }

  #projectError(error: unknown): unknown {
    return error instanceof RuneError
      ? projectRuneError(error, (text) => this.#secrets.mask(text))
      : error;
  }

  #resolve(): Resolution {
    return freezeResolution(
      resolveInputs({
        manifest: this.manifest,
        context: this.#context,
        values: this.#values,
        environment: this.#environment,
        overrides: this.#overrides,
        answers: this.#answers,
        secrets: this.#secrets,
      }),
    );
  }

  #missingIssue(id: string): RuneIssue {
    const sources = `--set ${id}=... | ${environmentName(id)} | values-file key '${id}'`;
    return {
      code: 'RUNE-201',
      message: `input "${id}" is required and has no value — supply it with ${sources}`,
      location: startOfFile(this.manifestPath),
    };
  }
}

/**
 * Protects the engine-owned resolution while preserving its value semantics. Plain arrays
 * are copied and frozen; SecretString instances are deliberately retained, never cloned.
 */
function freezeResolution(resolution: Resolution): Resolution {
  const inputs = Object.freeze(
    resolution.inputs.map((state) =>
      Object.freeze({
        ...state,
        value: freezeInputValue(state.value),
      }),
    ),
  );
  const byId = new Map(inputs.map((state) => [state.id, state]));

  return Object.freeze({
    inputs,
    byId,
    missing: Object.freeze([...resolution.missing]),
    warnings: Object.freeze([...resolution.warnings]),
    problems: Object.freeze([...resolution.problems]),
  });
}

function freezeInputValue(value: InputValue | undefined): InputValue | undefined {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

/** Observer failures are isolated per sink and can never change execution or finalization. */
function notifyObserver(observer: EngineObserver | undefined, event: RunEvent): void {
  try {
    observer?.(event);
  } catch {
    // A broken renderer or sink must never corrupt a run (§9.1).
  }
}

/** What the operating system reports as its display locale. */
function systemLocale(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/** `--log-file` beats `execution.logFile`; a relative manifest path anchors to its directory. */
function effectiveLogFile(
  flag: string | undefined,
  manifest: Manifest,
  manifestDir: string,
): string | undefined {
  if (flag !== undefined) {
    return resolvePath(flag);
  }
  const configured = manifest.execution.logFile;
  if (configured === undefined) {
    return undefined;
  }
  return isAbsolute(configured) ? configured : resolvePath(manifestDir, configured);
}
