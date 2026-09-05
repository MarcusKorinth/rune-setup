/**
 * The Session facade (docs/architecture.md §9.1) — the ONLY frontend entry point.
 *
 * GUI, interactive CLI, and non-interactive automation all drive one session the same way:
 * open, ask what is pending, set values, plan, execute. Nothing engine-side is reachable
 * any other way, which is what makes mode parity a construction rather than a promise.
 */

import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import { snapshotEnvironment, type Environment } from '../environment.js';
import { formatDiagnostic } from '../diagnostics.js';
import {
  InputError,
  InternalError,
  projectRuneError,
  RuneError,
  UsageError,
  type RuneIssue,
} from '../errors.js';
import { environmentName, secretArgumentWarnings } from '../manifest/v1/rules.js';
import { parseManifestAsync, type Manifest } from '../manifest/index.js';
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
  registerPreManifestFailureContext,
} from './executor.js';
import type { EngineObserver, RunEvent, RunFinished } from './events.js';
import {
  parseValuesFileAsync,
  projectInputFacadeSnapshot,
  resolveInputsWithRegistry,
  stageOpeningSecretCandidates,
  type InputFacadeSnapshot,
  type InputState,
  type Resolution,
  type ValuesDocument,
} from './inputs.js';
import {
  buildPlan,
  executionContextFor,
  planningFailureContextFor,
  type ExecutionPlan,
} from './plan.js';
import { resolveManifestRelativePathFrom, sameSinkPath } from './paths.js';
import { registryFromSecretMasker, SecretRegistry, type SecretMasker } from './secrets.js';

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
  /** A foreign platform to preview with `--dry-run`; such a plan never executes. */
  readonly platform?: Platform | undefined;
  /** `--log-file`; overrides the manifest's `execution.logFile` (§10). */
  readonly logFile?: string | undefined;
  /**
   * Where this run's result file will be written (§4.1). `open` refuses an exact collision with
   * the effective log file the moment it anchors one, so no failure of the rest of opening or of
   * planning can deliver a result onto the operator's log. A host passes it for a real run only:
   * a dry run never opens the log, and `--result -` names no file.
   */
  readonly resultDestination?: string | undefined;
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
  /**
   * What this session will log to: `--log-file`, else the manifest's `execution.logFile`,
   * anchored at open — `undefined` when neither is configured. Published so hosts can announce
   * the log path in previews without re-deriving precedence or anchoring. Hosts pass their
   * `resultDestination` to `open()`, which refuses an exact result/log collision.
   */
  readonly effectiveLogFile: EffectiveLogFile | undefined;
  /**
   * The manifest as the caller spelled it. RUNE anchors that spelling to reach the file, but
   * a located diagnostic names this one: the anchored form is a spelling no secret registry
   * ever held, and the plan and the result carry it as machine identity instead (§10).
   */
  readonly #manifestAnnouncement: string;
  readonly #context: RuntimeContext;
  readonly #environment: Environment;
  #secrets: SecretRegistry;
  readonly #strings: StringTable;
  readonly #sinkStrings: StringTable;
  readonly #values: readonly ValuesDocument[];
  readonly #overrides: ReadonlyMap<string, string>;
  readonly #answers = new Map<string, unknown>();
  readonly #runner: Runner | undefined;
  readonly #manifestWarnings: readonly string[];
  #resolution: Resolution;
  #warnings: readonly string[];
  #inputSnapshot: InputFacadeSnapshot;
  #plan: ExecutionPlan | undefined;
  #activeExecution: ActiveExecution | undefined;

  private constructor(fields: {
    manifest: Manifest;
    manifestAnnouncement: string;
    mode: RunMode;
    context: RuntimeContext;
    environment: Environment;
    secrets: SecretRegistry;
    strings: StringTable;
    values: readonly ValuesDocument[];
    overrides: ReadonlyMap<string, string>;
    resolution: Resolution;
    inputSnapshot: InputFacadeSnapshot;
    logFile: EffectiveLogFile | undefined;
    runner: Runner | undefined;
  }) {
    this.manifest = fields.manifest;
    this.#manifestAnnouncement = fields.manifestAnnouncement;
    this.mode = fields.mode;
    this.platform = fields.context.platform;
    this.preview = fields.context.preview;
    this.#context = fields.context;
    this.#environment = fields.environment;
    this.#secrets = fields.secrets;
    this.#strings = fields.strings;
    const liveSecrets: SecretMasker = {
      mask: (text) => this.#sinkSecrets().mask(text),
      maskFragments: (fragments) => this.#sinkSecrets().maskFragments(fragments),
      safeFallbackMarker: () => this.#sinkSecrets().safeFallbackMarker(),
    };
    this.#sinkStrings = projectStringsForSink(fields.strings, liveSecrets);
    this.#values = fields.values;
    this.#overrides = fields.overrides;
    this.#manifestWarnings = secretArgumentWarnings(fields.manifest);
    this.#resolution = fields.resolution;
    this.#warnings = combineWarnings(
      projectManifestWarnings(this.#manifestWarnings, fields.secrets),
      fields.resolution.warnings,
    );
    this.#inputSnapshot = fields.inputSnapshot;
    this.effectiveLogFile = fields.logFile;
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
    const resultDestination = options.resultDestination;
    // Anchoring is for the filesystem only: the sink and the preview name `logFileFlag`,
    // the spelling the operator wrote and the only one a secret registry can hold (§10).
    const flagLogFile =
      logFileFlag === undefined
        ? undefined
        : Object.freeze({
            path: resolvePath(invocationCwd, logFileFlag),
            announcement: logFileFlag,
          });

    let locale: string | undefined;
    let localeSelectionError: unknown;
    let localeSelectionFailed = false;
    try {
      locale = selectLocale({
        flag: localeFlag,
        environment,
        systemLocale: openingSystemLocale,
      });
    } catch (error) {
      // Manifest errors retain precedence over locale usage errors. Keep the snapshotted
      // selection failure until parsing has established that the manifest itself is valid.
      localeSelectionFailed = true;
      localeSelectionError = error;
    }

    let manifest: Manifest;
    try {
      manifest = await parseManifestAsync(absolutePath, { checkAssetFiles: mode === 'gui' });
    } catch (error) {
      const projected = projectOpeningError(error, new SecretRegistry());
      registerPreManifestFailureContext(projected, {
        manifestPath: absolutePath,
        mode,
        platform,
        preview,
        locale: locale ?? null,
      });
      throw projected;
    }
    // The manifest's own execution.logFile is anchored here, the first moment §4.1's manifest
    // half is knowable. Refusing the collision now — before overlays, values files, input
    // resolution, or planning can fail — is what keeps a failing run from delivering its result
    // onto the file the operator named as the log, whatever it is that fails.
    const logFile = effectiveLogFile(flagLogFile, manifest, manifestDir);
    if (
      resultDestination !== undefined &&
      logFile !== undefined &&
      sameSinkPath(resolvePath(invocationCwd, resultDestination), logFile.path)
    ) {
      throw new UsageError(RESULT_LOG_COLLISION_MESSAGE);
    }
    const secrets = new SecretRegistry();
    let strings: StringTable | undefined;
    let resolution: Resolution | undefined;
    let inputSnapshot: InputFacadeSnapshot | undefined;
    try {
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
      let deferredValuesReadError: unknown;
      let valuesReadFailed = false;
      // Values paths were snapshotted before the first await. Read them now so declared secret
      // candidates can redact deferred locale and selected-overlay diagnostics. Expected loader
      // and shape problems stay on their ValuesDocument until authoritative resolution, preserving
      // overlay-vs-values precedence and document order. Defer only an unexpected thrown failure.
      for (const file of valueFiles) {
        try {
          values.push(await parseValuesFileAsync(file.path, file.file));
        } catch (error) {
          valuesReadFailed = true;
          deferredValuesReadError = error;
          break;
        }
      }
      stageOpeningSecretCandidates({ manifest, context, values, overrides }, secrets);

      if (localeSelectionFailed) {
        throw localeSelectionError;
      }
      let overlay: LocaleOverlay | undefined;
      if (locale !== undefined) {
        const match = await discoverSelectedOverlayAsync(manifestDir, locale);
        overlay =
          match === undefined
            ? undefined
            : await loadOverlayAsync(match.path, match.locale, manifest);
      }
      strings = resolveStrings({ manifest, locale, overlay });

      if (valuesReadFailed) {
        throw deferredValuesReadError;
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
        undefined,
        mode === 'non-interactive' ? (id) => missingInputIssue(manifestPath, id) : undefined,
      );
      inputSnapshot = projectInputFacadeSnapshot(resolution);

      return new Session({
        manifest,
        manifestAnnouncement: manifestPath,
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
        logFile,
        runner,
      });
    } catch (error) {
      const projected = projectOpeningError(error, secrets);
      const failureStrings = strings ?? Object.freeze({ locale });
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

  /** Warnings a frontend should say out loud but not fail over (§4.3, §5, §10). */
  warnings(): readonly string[] {
    return this.#warnings;
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
    const answer = Array.isArray(raw) ? [...raw] : raw;
    this.#answers.set(id, answer);
    const candidateSecrets = new SecretRegistry().combinedWith(this.#secrets);
    let after: Resolution;
    let afterInputSnapshot: InputFacadeSnapshot;
    let afterWarnings: readonly string[];
    let changes: readonly InputStateChanged[];
    try {
      // Resolution stages this answer in its own registry, but a rejected edit never publishes
      // that registry. Retain the candidate in this private transaction so the facade's final
      // error projection cannot restore raw issue text with a weaker masker.
      if (this.manifest.inputs[id]!.type === 'secret') {
        candidateSecrets.registerCandidate(answer);
      }
      after = this.#resolve(candidateSecrets, id);
      afterInputSnapshot = projectInputFacadeSnapshot(after);
      afterWarnings = combineWarnings(
        projectManifestWarnings(this.#manifestWarnings, candidateSecrets),
        after.warnings,
      );
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
    this.#warnings = afterWarnings;
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
    const planSecrets = executionContextFor(plan).secrets;
    if (plan.preview) {
      throw this.#projectError(
        new InternalError(
          'a cross-platform preview plan can only be described, never executed (§6.1)',
        ),
      );
    }
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
          : await createLogFileSink(logFile, (text) => planSecrets.mask(text), {
              announcement: this.effectiveLogFile?.announcement ?? logFile,
            });
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
      if (log !== undefined && !closeAttempted) {
        closeAttempted = true;
        try {
          await log.close();
        } catch {
          // A cleanup failure must not replace the failure that interrupted execution.
        }
      }

      const projected = this.#projectError(error);
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
      path === undefined || isAbsolute(path)
        ? path
        : resolveManifestRelativePathFrom(path, this.#context.manifestDir);
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
          ...missing.map((id) => missingInputIssue(this.#manifestAnnouncement, id)),
        ]);
      }
      if (this.#plan !== undefined) {
        return this.#plan;
      }
      const plan = buildPlan({
        manifest: this.manifest,
        resolution: this.#resolution,
        context: this.#context,
        locale: this.#strings.locale,
        logFile: this.effectiveLogFile?.path,
        strings: this.#strings,
      });
      const planSecrets = executionContextFor(plan).secrets;
      const inputSnapshot = projectInputFacadeSnapshot(this.#resolution, planSecrets);
      this.#plan = plan;
      this.#inputSnapshot = inputSnapshot;
      registerFailureResultSession(this, planSecrets, plan);
      return plan;
    } catch (error) {
      const planningError = planningFailureContextFor(error) === undefined ? undefined : error;
      throw this.#projectError(error, undefined, planningError);
    }
  }

  #sinkSecrets(): SecretMasker {
    return this.#plan === undefined ? this.#secrets : executionContextFor(this.#plan).secrets;
  }

  #projectError(
    error: unknown,
    candidateSecrets?: SecretRegistry,
    planningError?: unknown,
  ): unknown {
    if (!(error instanceof RuneError)) {
      return error;
    }
    const planningFailure = planningFailureContextFor(planningError);
    const activeSecrets = this.#sinkSecrets();
    let errorToProject = error;
    let secrets: SecretMasker = planningFailure?.secrets ?? candidateSecrets ?? activeSecrets;
    if (candidateSecrets !== undefined && this.#plan !== undefined) {
      try {
        secrets = registryFromSecretMasker(activeSecrets).combinedWith(candidateSecrets);
      } catch (maskerError) {
        if (!(maskerError instanceof RuneError)) {
          throw maskerError;
        }
        // The union can exceed the bounded registry even though the retained plan and staged
        // resolution each fit alone. Its capacity error is value-free, so project and bind that
        // error with the complete active-plan masker instead of retrying the original rejection.
        errorToProject = maskerError;
        secrets = activeSecrets;
      }
    }
    const projected = projectRuneError(errorToProject, secrets);
    registerFailureResultError(projected, this, planningFailure === undefined ? undefined : error);
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
}

/** Projects raw manifest warnings through the complete diagnostic sink contract. */
function projectManifestWarnings(
  manifestWarnings: readonly string[],
  secrets: SecretRegistry,
): readonly string[] {
  return Object.freeze(manifestWarnings.map((warning) => formatDiagnostic([warning], secrets)));
}

/** One immutable facade snapshot for the static manifest and current dynamic resolution state. */
function combineWarnings(
  manifestWarnings: readonly string[],
  resolutionWarnings: readonly string[],
): readonly string[] {
  if (manifestWarnings.length === 0) {
    return resolutionWarnings;
  }
  if (resolutionWarnings.length === 0) {
    return manifestWarnings;
  }
  return Object.freeze([...manifestWarnings, ...resolutionWarnings]);
}

/** The location names the manifest as its caller spelled it: the maskable spelling (§10). */
function missingInputIssue(manifestAnnouncement: string, id: string): RuneIssue {
  const sources = `--set ${id}=... | ${environmentName(id)} | values-file key '${id}'`;
  return {
    code: 'RUNE-201',
    message: `input "${id}" is required and has no value — supply it with ${sources}`,
    location: startOfFile(manifestAnnouncement),
  };
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

/** Projects every opening failure to a stable RuneError without exposing an unexpected cause. */
function projectOpeningError(error: unknown, secrets: SecretRegistry): RuneError {
  const runeError =
    error instanceof RuneError
      ? error
      : new InternalError('an unexpected error escaped the run pipeline', { cause: error });
  return projectRuneError(runeError, secrets);
}

/**
 * What §4.1's collision reads, wherever it is refused. One sentence for both halves: the engine
 * refuses the manifest half inside `open`, and a host refuses the argument-level `--log-file`
 * half before opening at all, so the operator must not meet two spellings of one rule.
 */
export const RESULT_LOG_COLLISION_MESSAGE =
  '--result and the effective log file must use different paths for a real run';

/** The anchored log path plus the spelling its supplier wrote, which sinks name (§10). */
export interface EffectiveLogFile {
  readonly path: string;
  readonly announcement: string;
}

/** The snapshotted `--log-file` beats `execution.logFile`; manifest paths anchor to its directory. */
function effectiveLogFile(
  flag: EffectiveLogFile | undefined,
  manifest: Manifest,
  manifestDir: string,
): EffectiveLogFile | undefined {
  if (flag !== undefined) {
    return flag;
  }
  const configured = manifest.execution.logFile;
  if (configured === undefined) {
    return undefined;
  }
  return Object.freeze({
    path: isAbsolute(configured)
      ? resolvePath(manifestDir, configured)
      : resolveManifestRelativePathFrom(configured, manifestDir),
    announcement: configured,
  });
}
