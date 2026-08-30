/**
 * The Session facade (docs/architecture.md §9.1) — the ONLY frontend entry point.
 *
 * GUI, interactive CLI, and non-interactive automation all drive one session the same way:
 * open, ask what is pending, set values, plan, execute. Nothing engine-side is reachable
 * any other way, which is what makes mode parity a construction rather than a promise.
 */

import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import { InputError, type RuneIssue } from '../errors.js';
import { environmentName } from '../manifest/v1/rules.js';
import { parseManifest, type Manifest } from '../manifest/index.js';
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
import { describeCancelled, describePlan, executeRun } from './executor.js';
import type { EngineObserver } from './events.js';
import {
  parseValuesFile,
  resolveInputs,
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
  /** Which frontend drives this session — recorded in the result (§10). */
  readonly mode?: RunMode | undefined;
  /** The runner steps spawn through; the default is the real one. The §13 seam and test seam. */
  readonly runner?: Runner | undefined;
}

export class Session {
  readonly manifest: Manifest;
  readonly manifestPath: string;
  readonly #context: RuntimeContext;
  readonly #secrets: SecretRegistry;
  readonly #strings: StringTable;
  readonly #values: readonly ValuesDocument[];
  readonly #overrides: ReadonlyMap<string, string>;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #answers = new Map<string, unknown>();
  readonly #logFile: string | undefined;
  readonly #runner: Runner | undefined;
  readonly #mode: RunMode;
  #resolution: Resolution;
  #cancel: CancelToken | undefined;

  private constructor(fields: {
    manifest: Manifest;
    manifestPath: string;
    context: RuntimeContext;
    secrets: SecretRegistry;
    strings: StringTable;
    values: readonly ValuesDocument[];
    overrides: ReadonlyMap<string, string>;
    environment: Readonly<Record<string, string | undefined>>;
    resolution: Resolution;
    logFile: string | undefined;
    runner: Runner | undefined;
    mode: RunMode;
  }) {
    this.manifest = fields.manifest;
    this.manifestPath = fields.manifestPath;
    this.#context = fields.context;
    this.#secrets = fields.secrets;
    this.#strings = fields.strings;
    this.#values = fields.values;
    this.#overrides = fields.overrides;
    this.#environment = fields.environment;
    this.#resolution = fields.resolution;
    this.#logFile = fields.logFile;
    this.#runner = fields.runner;
    this.#mode = fields.mode;
  }

  /** Opens a session: load, validate, resolve layers 1–4 — stages 1–3 of the pipeline (§7). */
  static async open(manifestPath: string, options: SessionOptions = {}): Promise<Session> {
    const absolutePath = resolvePath(manifestPath);
    const manifestDir = dirname(absolutePath);
    const manifest = parseManifest(absolutePath);
    const environment = options.environment ?? process.env;

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

    return new Session({
      manifest,
      manifestPath,
      context,
      secrets,
      strings,
      values,
      overrides,
      environment,
      // All-or-nothing: a value no type accepts, or a key naming no input, throws here and
      // no session exists (paragraph 10).
      resolution: resolveInputs({
        manifest,
        context,
        values,
        environment,
        overrides,
        secrets,
      }),
      logFile: effectiveLogFile(options.logFile, manifest, manifestDir),
      runner: options.runner,
      mode: options.mode ?? 'non-interactive',
    });
  }

  /** Enabled required inputs still without an answer, in declaration order — what to ask for. */
  pendingInputs(): readonly InputState[] {
    const missing = new Set(this.#resolution.missing);
    return this.#resolution.inputs.filter((state) => missing.has(state.id));
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
    if (!(id in this.manifest.inputs)) {
      throw new InputError('RUNE-203', `"${id}" names no input of this manifest`);
    }
    const before = this.#resolution;
    const hadPrevious = this.#answers.has(id);
    const previous = this.#answers.get(id);
    this.#answers.set(id, raw);
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
      throw error;
    }
    this.#resolution = after;

    const changes: InputStateChanged[] = [];
    for (const state of after.inputs) {
      if (before.byId.get(state.id)?.enabled !== state.enabled) {
        changes.push({ inputId: state.id, enabled: state.enabled });
      }
    }
    return changes;
  }

  /** Stage 4: the frozen plan. Throws listing EVERY missing input with its accepted sources. */
  plan(): ExecutionPlan {
    const missing = this.#resolution.missing;
    if (missing.length > 0) {
      throw InputError.fromIssues(
        'RUNE-201',
        missing.map((id) => this.#missingIssue(id)),
      );
    }
    return buildPlan({
      manifest: this.manifest,
      manifestPath: this.manifestPath,
      resolution: this.#resolution,
      context: this.#context,
      strings: this.#strings,
    });
  }

  /**
   * The result of cancelling before anything ran — the CLI edit-loop Cancel, the GUI
   * window closed before Proceed (§10). When the inputs are complete, every pending step
   * is NOT_RUN and plan-time skips are kept. When required inputs are still missing, no
   * truthful plan exists, so the result has zero steps and retains the resolved inputs.
   */
  describeCancelled(): RunResult {
    const plan =
      this.#resolution.missing.length === 0
        ? this.plan()
        : buildPlan({
            manifest: { ...this.manifest, steps: [] },
            manifestPath: this.manifestPath,
            resolution: this.#resolution,
            context: this.#context,
            strings: this.#strings,
          });
    return describeCancelled({
      plan,
      resolution: this.#resolution,
      product: this.manifest.product,
      secrets: this.#secrets,
      mode: this.#mode,
    });
  }

  /** The dry-run result: the plan described, nothing executed (§10, status `planned`). */
  describe(): RunResult {
    return describePlan({
      plan: this.plan(),
      resolution: this.#resolution,
      product: this.manifest.product,
      secrets: this.#secrets,
      mode: this.#mode,
    });
  }

  /** Stages 5 and 6: runs the plan; resolves with the result when the run is over. */
  async execute(observer?: EngineObserver, cancel?: CancelToken): Promise<RunResult> {
    const plan = this.plan();
    const token = cancel ?? new CancelToken();
    this.#cancel = token;
    const log = this.#logFile === undefined ? undefined : createLogFileSink(this.#logFile);
    const observers: EngineObserver = (event) => {
      log?.observer(event);
      observer?.(event);
    };
    try {
      return await executeRun({
        plan,
        resolution: this.#resolution,
        product: this.manifest.product,
        secrets: this.#secrets,
        observer: observers,
        cancel: token,
        mode: this.#mode,
        ...(this.#runner === undefined ? {} : { runner: this.#runner }),
      });
    } finally {
      this.#cancel = undefined;
      await log?.close();
    }
  }

  /** Fires the CancelToken of the running {@link execute} — the one flow for all frontends. */
  cancel(): void {
    this.#cancel?.cancel();
  }

  /**
   * Masks registered secrets in one line of text — the sink-safety belt a host applies to
   * its own boundaries, e.g. the GUI shell's bridge serializer (§9.2, §10).
   */
  mask(text: string): string {
    return this.#secrets.mask(text);
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

  #resolve(): Resolution {
    return resolveInputs({
      manifest: this.manifest,
      context: this.#context,
      values: this.#values,
      environment: this.#environment,
      overrides: this.#overrides,
      answers: this.#answers,
      secrets: this.#secrets,
    });
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
