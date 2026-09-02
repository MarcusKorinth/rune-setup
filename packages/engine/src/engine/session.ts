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
import { environmentName } from '../manifest/v1/rules.js';
import { manifestDescriptorFor, parseManifestAsync, type Manifest } from '../manifest/index.js';
import { startOfFile } from '../manifest/source.js';
import { discoverSelectedOverlayAsync, selectLocale } from '../i18n/locale.js';
import { loadOverlayAsync, type LocaleOverlay } from '../i18n/overlay.js';
import { projectStringsForSink, resolveStrings, type StringTable } from '../i18n/strings.js';
import { createLogFileSink } from '../logs/logFile.js';
import type { Runner } from '../runners/base.js';
import type { RunMode, RunResult } from '../results/model.js';
import { CancelToken } from './cancel.js';
import {
  createRuntimeContext,
  hostPlatform,
  snapshotHostBuiltIns,
  type Platform,
  type RuntimeContext,
} from './context.js';
import {
  createCompletedRunFailureResult,
  describePlan,
  executeRun,
  registerFailureResultError,
  registerFailureResultSession,
  registerOpenFailureContext,
} from './executor.js';
import type { EngineObserver, RunEvent, RunFinished } from './events.js';
import {
  parseValuesFileAsync,
  projectInputFacadeSnapshot,
  resolveInputsWithRegistry,
  type InputFacadeSnapshot,
  type InputState,
  type Resolution,
  type ValuesDocument,
} from './inputs.js';
import { buildPlan, type ExecutionPlan } from './plan.js';
import { SecretRegistry } from './secrets.js';

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
}

const TEST_RUNNERS = new WeakMap<SessionOptions, Runner>();
const EMPTY_INPUTS: readonly InputState[] = Object.freeze([]);

/**
 * Engine-internal test seam for binding a runner to one options object. Package consumers cannot
 * reach this through the root export, and SessionOptions remains the complete frontend contract.
 */
export function createSessionOptionsForTesting(
  options: SessionOptions,
  runner: Runner,
): SessionOptions {
  const bound = Object.freeze({ ...options });
  TEST_RUNNERS.set(bound, runner);
  return bound;
}

interface ActiveExecution {
  readonly cancel: CancelToken;
}

export class Session {
  readonly manifest: Manifest;
  readonly mode: RunMode;
  readonly platform: Platform;
  readonly preview: boolean;
  readonly #manifestPath: string;
  readonly #context: RuntimeContext;
  readonly #environment: Environment;
  #secrets: SecretRegistry;
  readonly #strings: StringTable;
  readonly #sinkStrings: StringTable;
  readonly #values: readonly ValuesDocument[];
  readonly #overrides: ReadonlyMap<string, string>;
  readonly #answers = new Map<string, unknown>();
  readonly #logFile: string | undefined;
  readonly #runner: Runner | undefined;
  #resolution: Resolution;
  #inputSnapshot: InputFacadeSnapshot;
  #plan: ExecutionPlan | undefined;
  #activeExecution: ActiveExecution | undefined;

  private constructor(fields: {
    manifest: Manifest;
    manifestPath: string;
    mode: RunMode;
    context: RuntimeContext;
    environment: Environment;
    secrets: SecretRegistry;
    strings: StringTable;
    values: readonly ValuesDocument[];
    overrides: ReadonlyMap<string, string>;
    resolution: Resolution;
    inputSnapshot: InputFacadeSnapshot;
    logFile: string | undefined;
    runner: Runner | undefined;
  }) {
    this.manifest = fields.manifest;
    this.#manifestPath = fields.manifestPath;
    this.mode = fields.mode;
    this.platform = fields.context.platform;
    this.preview = fields.context.preview;
    this.#context = fields.context;
    this.#environment = fields.environment;
    this.#secrets = fields.secrets;
    this.#strings = fields.strings;
    this.#sinkStrings = projectStringsForSink(fields.strings, (text) => this.#secrets.mask(text));
    this.#values = fields.values;
    this.#overrides = fields.overrides;
    this.#resolution = fields.resolution;
    this.#inputSnapshot = fields.inputSnapshot;
    this.#logFile = fields.logFile;
    this.#runner = fields.runner;
    this.#plan = undefined;
    registerFailureResultSession(this, fields.secrets.snapshot());
    // Public readonly fields and facade methods must be readonly in JavaScript too. Private
    // slots remain mutable, so answers, resolution, execution, and cancellation still work.
    Object.freeze(this);
  }

  /** Opens a session: load, validate, resolve layers 1–4 — stages 1–3 of the pipeline (§7). */
  static async open(manifestPath: string, options: SessionOptions = {}): Promise<Session> {
    const runner = TEST_RUNNERS.get(options);
    const invocationCwd = process.cwd();
    const absolutePath = resolvePath(invocationCwd, manifestPath);
    const manifestDir = dirname(absolutePath);
    const mode = options.mode ?? 'non-interactive';
    const host = hostPlatform();
    const platform = options.platform ?? host;
    const preview = platform !== host;
    const hostBuiltIns = preview ? undefined : snapshotHostBuiltIns();
    // A session is a snapshot of its opening invocation. Keeping a caller-owned environment
    // object would let later mutations change input resolution or interpolation after open.
    const environment = snapshotEnvironment(options.environment);
    const localeFlag = options.locale;
    const openingSystemLocale = options.systemLocale ?? systemLocale();
    const valueFiles = (options.values ?? []).map((file) => ({
      path: resolvePath(invocationCwd, file),
      file,
    }));
    const overrides = new Map(Object.entries(options.overrides ?? {}));
    const logFileFlag = options.logFile;
    const flagLogFile =
      logFileFlag === undefined ? undefined : resolvePath(invocationCwd, logFileFlag);

    const manifest = await parseManifestAsync(absolutePath, { checkAssetFiles: mode === 'gui' });
    const descriptor = manifestDescriptorFor(manifest);
    const secrets = new SecretRegistry();
    let locale: string | undefined;
    let strings: StringTable | undefined;
    let resolution: Resolution | undefined;
    let inputSnapshot: InputFacadeSnapshot | undefined;
    try {
      locale = selectLocale({
        flag: localeFlag,
        environment,
        systemLocale: openingSystemLocale,
      });
      let overlay: LocaleOverlay | undefined;
      if (locale !== undefined) {
        const match = await discoverSelectedOverlayAsync(manifestDir, locale);
        overlay =
          match === undefined
            ? undefined
            : await loadOverlayAsync(match.path, match.locale, manifest);
      }
      strings = resolveStrings({ manifest, locale, overlay });

      const context = createRuntimeContext(
        {
          manifestDir,
          product: manifest.product,
          platform,
          environment,
        },
        hostBuiltIns,
      );
      const values: ValuesDocument[] = [];
      // Preserve invocation-order error precedence: one values file finishes before the next
      // starts, exactly as in the synchronous authoring path.
      for (const file of valueFiles) {
        values.push(await parseValuesFileAsync(file.path, file.file));
      }
      resolution = resolveInputsWithRegistry(
        {
          manifest,
          context,
          values,
          overrides,
          invalidValues: mode === 'non-interactive' ? 'throw' : 'collect',
        },
        secrets,
      );
      inputSnapshot = projectInputFacadeSnapshot(resolution);

      return new Session({
        manifest,
        manifestPath: descriptor.path,
        mode,
        context,
        environment,
        secrets,
        strings,
        values,
        overrides,
        // Automation is all-or-nothing. Interactive frontends retain rejected seed values so
        // they can render and replace them before planning (§5).
        resolution,
        inputSnapshot,
        logFile: effectiveLogFile(flagLogFile, manifest, manifestDir),
        runner,
      });
    } catch (error) {
      const projected =
        error instanceof RuneError ? projectRuneError(error, (text) => secrets.mask(text)) : error;
      const failureStrings = strings ?? Object.freeze({ locale });
      if (projected instanceof RuneError) {
        registerOpenFailureContext(
          projected,
          Object.freeze({
            manifest,
            mode,
            platform,
            preview,
            allInputs: () => inputSnapshot?.all ?? EMPTY_INPUTS,
            getStrings: () => failureStrings,
          }),
          secrets.snapshot(),
        );
      }
      throw projected;
    }
  }

  /** Enabled unresolved inputs a frontend can correct, in declaration order. */
  pendingInputs(): readonly InputState[] {
    return this.#inputSnapshot.pending;
  }

  /** Every input with its resolved state — what a GUI prefills (§9.1). */
  allInputs(): readonly InputState[] {
    return this.#inputSnapshot.all;
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
      throw this.#projectError(
        new InternalError('cannot set a session value while execution is active'),
      );
    }
    if (!Object.hasOwn(this.manifest.inputs, id)) {
      throw this.#projectError(
        new InputError('RUNE-203', `"${id}" names no input of this manifest`),
      );
    }
    const before = this.#resolution;
    const hadPrevious = this.#answers.has(id);
    const previous = this.#answers.get(id);
    // Keep caller-owned arrays outside the engine authority. SecretString and scalar values
    // pass through unchanged; cloning a SecretString would either break it or expose it.
    this.#answers.set(id, Array.isArray(raw) ? [...raw] : raw);
    const candidateSecrets = new SecretRegistry().combinedWith(this.#secrets);
    let after: Resolution;
    let afterInputSnapshot: InputFacadeSnapshot;
    let changes: readonly InputStateChanged[];
    try {
      after = this.#resolve(candidateSecrets, id);
      afterInputSnapshot = projectInputFacadeSnapshot(after);
      const projectedChanges: InputStateChanged[] = [];
      for (const state of after.inputs) {
        if (before.byId.get(state.id)?.enabled !== state.enabled) {
          projectedChanges.push({ inputId: state.id, enabled: state.enabled });
        }
      }
      changes = Object.freeze(projectedChanges.map((change) => Object.freeze(change)));
    } catch (error) {
      // Restore, never delete: a rejected edit must not discard an earlier accepted answer.
      if (hadPrevious) {
        this.#answers.set(id, previous);
      } else {
        this.#answers.delete(id);
      }
      throw this.#projectError(error, candidateSecrets);
    }
    this.#resolution = after;
    this.#secrets = candidateSecrets;
    this.#inputSnapshot = afterInputSnapshot;
    this.#plan = undefined;
    registerFailureResultSession(this, candidateSecrets.snapshot());
    return changes;
  }

  /** Stage 4: the frozen plan. Throws listing EVERY missing input with its accepted sources. */
  plan(): ExecutionPlan {
    return this.#executionPlan();
  }

  /** The dry-run result: the plan described, nothing executed (§10, status `planned`). */
  describe(): RunResult {
    return describePlan({
      plan: this.#executionPlan(),
      mode: this.mode,
    });
  }

  /** Stages 5 and 6: runs the plan; resolves with the result when the run is over. */
  async execute(observer?: EngineObserver, cancel?: CancelToken): Promise<RunResult> {
    if (this.#activeExecution !== undefined) {
      throw this.#projectError(
        new InternalError('a session cannot have more than one active execution'),
      );
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
      log =
        logFile === undefined
          ? undefined
          : await createLogFileSink(logFile, (text) => this.#secrets.mask(text));
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
        mode: this.mode,
        environment: this.#environment,
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
            : (this.#projectError(
                new InternalError('an unexpected error escaped run finalization', {
                  cause: projected,
                }),
              ) as RuneError);
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
    return this.#sinkStrings;
  }

  /** The `gui:` block, paths absolute; an empty object when the manifest has none. */
  getThemeConfig(): ThemeConfig {
    const gui = this.manifest.gui;
    if (gui === undefined) {
      return Object.freeze({});
    }
    const anchor = (path: string | undefined): string | undefined =>
      path === undefined || isAbsolute(path) ? path : resolvePath(this.#context.manifestDir, path);
    return Object.freeze({
      ...(gui.accentColor === undefined ? {} : { accentColor: gui.accentColor }),
      ...(gui.logo === undefined ? {} : { logo: anchor(gui.logo) }),
      ...(gui.banner === undefined ? {} : { banner: anchor(gui.banner) }),
      ...(gui.theme === undefined ? {} : { theme: anchor(gui.theme) }),
      ...(gui.windowTitle === undefined ? {} : { windowTitle: this.#sinkStrings.windowTitle() }),
    });
  }

  #executionPlan(): ExecutionPlan {
    try {
      const missing = this.#resolution.missing;
      const problems = this.#resolution.problems;
      if (missing.length > 0 || problems.length > 0) {
        throw InputError.fromIssues(problems.length > 0 ? 'RUNE-202' : 'RUNE-201', [
          ...problems,
          ...missing.map((id) => this.#missingIssue(id)),
        ]);
      }
      if (this.#plan !== undefined) {
        return this.#plan;
      }
      this.#plan = buildPlan({
        manifest: this.manifest,
        resolution: this.#resolution,
        context: this.#context,
        locale: this.#strings.locale,
        logFile: this.#logFile,
        strings: this.#strings,
      });
      registerFailureResultSession(this, this.#secrets.snapshot(), this.#plan);
      return this.#plan;
    } catch (error) {
      throw this.#projectError(error);
    }
  }

  #projectError(error: unknown, secrets: SecretRegistry = this.#secrets): unknown {
    if (!(error instanceof RuneError)) {
      return error;
    }
    const projected = projectRuneError(error, (text) => secrets.mask(text));
    registerFailureResultError(projected, this);
    return projected;
  }

  #resolve(secrets: SecretRegistry, editedAnswerId?: string): Resolution {
    return resolveInputsWithRegistry(
      {
        manifest: this.manifest,
        context: this.#context,
        values: this.#values,
        overrides: this.#overrides,
        answers: this.#answers,
        invalidValues: this.mode === 'non-interactive' ? 'throw' : 'collect',
      },
      secrets,
      this.mode === 'non-interactive' ? undefined : editedAnswerId,
    );
  }

  #missingIssue(id: string): RuneIssue {
    const sources = `--set ${id}=... | ${environmentName(id)} | values-file key '${id}'`;
    return {
      code: 'RUNE-201',
      message: `input "${id}" is required and has no value — supply it with ${sources}`,
      location: startOfFile(this.#manifestPath),
    };
  }
}

/** Observer failures are isolated per sink and can never change execution or finalization. */
function notifyObserver(observer: EngineObserver | undefined, event: RunEvent): void {
  try {
    const returned = (observer as ((event: RunEvent) => unknown) | undefined)?.(event);
    if (returned instanceof Promise) {
      void returned.then(undefined, () => undefined);
    }
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

/** The snapshotted `--log-file` beats `execution.logFile`; manifest paths anchor to its directory. */
function effectiveLogFile(
  absoluteFlag: string | undefined,
  manifest: Manifest,
  manifestDir: string,
): string | undefined {
  if (absoluteFlag !== undefined) {
    return absoluteFlag;
  }
  const configured = manifest.execution.logFile;
  if (configured === undefined) {
    return undefined;
  }
  return isAbsolute(configured) ? configured : resolvePath(manifestDir, configured);
}
