/**
 * The bridge's type declarations (docs/architecture.md §9.2) — the ONLY thing the
 * renderer may import from the preload side (enforced by the dependency cruiser): plain
 * data shapes, no runtime code.
 */

/** What `window.rune` looks like from the renderer — the bridge's type declaration. */
export interface RuneBridge {
  open(): Promise<{
    runeVersion: string;
    inputTypes: readonly BridgeInputType[];
    product: { readonly name: string; readonly version: string };
  }>;
  pendingInputs(): Promise<readonly BridgeInput[]>;
  allInputs(): Promise<readonly BridgeInput[]>;
  setValue(id: string, raw: unknown): Promise<readonly { inputId: string; enabled: boolean }[]>;
  plan(): Promise<BridgePlan>;
  describe(): Promise<BridgeResult>;
  execute(): Promise<BridgeResult>;
  cancel(): Promise<void>;
  getStrings(): Promise<Readonly<Record<string, string>>>;
  getThemeConfig(): Promise<BridgeTheme>;
  /** The §10 warnings the Result page surfaces — same run, same warnings, every mode. */
  warnings(): Promise<readonly string[]>;
  /** Signals that the result page is done and the shell may close with the run's code. */
  done(): Promise<void>;
  onEvent(listener: (event: BridgeEvent) => void): void;
}

export type BridgeValueSource = 'default' | 'values' | 'environment' | 'set' | 'answer';

export interface BridgeInputRejection {
  readonly source: BridgeValueSource;
  readonly issue: {
    readonly code: 'RUNE-202';
    readonly message: string;
    readonly location?: { readonly file: string; readonly line: number; readonly column: number };
  };
  /** Plain non-secret data only; rejected secret candidates are never projected. */
  readonly candidate?: string | boolean | readonly string[];
}

export type BridgeInputType =
  'text' | 'secret' | 'boolean' | 'select' | 'multiselect' | 'file' | 'directory';

export type BridgeOption = string | { readonly value: string; readonly label: string };

interface BridgeInputSpecBase {
  readonly required: boolean;
}

export type BridgeInputSpec =
  | (BridgeInputSpecBase & {
      readonly type: 'text';
      readonly options?: never;
    })
  | (BridgeInputSpecBase & {
      readonly type: 'secret';
      readonly options?: never;
    })
  | (BridgeInputSpecBase & {
      readonly type: 'boolean';
      readonly options?: never;
    })
  | (BridgeInputSpecBase & {
      readonly type: 'select';
      readonly options: readonly string[];
    })
  | (BridgeInputSpecBase & {
      readonly type: 'multiselect';
      readonly options: readonly string[];
    })
  | (BridgeInputSpecBase & {
      readonly type: 'file' | 'directory';
      readonly options?: never;
    });

interface BridgeInputBase {
  readonly id: string;
  readonly enabled: boolean;
  /** Absent until a layer supplies the enabled input. */
  readonly source?: BridgeValueSource;
  /** Present only when a supplied value was discarded because the input is disabled. */
  readonly ignored?: BridgeValueSource;
  /** Present when a recoverable layers 1–4 value failed engine validation. */
  readonly rejection?: BridgeInputRejection;
}

/**
 * The projection of an InputState. An unanswered value is absent, while a resolved
 * secret's value is always `null` (§9.2).
 */
export type BridgeInput =
  | (BridgeInputBase & {
      readonly spec: Extract<
        BridgeInputSpec,
        { readonly type: 'text' | 'select' | 'file' | 'directory' }
      >;
      readonly value?: string;
    })
  | (BridgeInputBase & {
      readonly spec: Extract<BridgeInputSpec, { readonly type: 'secret' }>;
      readonly value?: null;
    })
  | (BridgeInputBase & {
      readonly spec: Extract<BridgeInputSpec, { readonly type: 'boolean' }>;
      readonly value?: boolean;
    })
  | (BridgeInputBase & {
      readonly spec: Extract<BridgeInputSpec, { readonly type: 'multiselect' }>;
      readonly value?: readonly string[];
    });

/** JSON-safe projection of the frozen ExecutionPlan returned by Session.plan(). */
export interface BridgePlan {
  readonly planSchemaVersion: 1;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly locale: string | null;
  readonly platform: 'windows' | 'linux';
  readonly preview: boolean;
  readonly resolvedInputs: readonly BridgePlanInput[];
  readonly executionOptions: BridgePlanExecutionOptions;
  readonly steps: readonly BridgePlannedStep[];
}

/** JSON-safe final input state from the static execution plan. */
export interface BridgePlanInput {
  readonly id: string;
  /** SecretString serializes to the literal mask `***`. */
  readonly value: string | boolean | readonly string[];
  /** Omitted when no source supplied the input. */
  readonly source?: BridgeValueSource;
  readonly secret: boolean;
  readonly enabled: boolean;
  /** Omitted unless a supplied value was discarded for a disabled input. */
  readonly ignored?: BridgeValueSource;
}

/** JSON-safe execution settings captured in the static plan. */
export interface BridgePlanExecutionOptions {
  readonly failFast: boolean;
  /** Omitted when the manifest and invocation specify no log file. */
  readonly logFile?: string;
}

export type BridgePlannedStep =
  | {
      readonly id: string;
      readonly title: string;
      readonly state: 'PENDING';
      readonly command: BridgePlannedCommand;
    }
  | {
      readonly id: string;
      readonly title: string;
      readonly state: 'SKIPPED';
      readonly skipReason: string;
    };

export interface BridgePlannedCommand {
  /** Secret-wrapped entries are projected as the literal mask `***`. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number | null;
  readonly successExitCodes: readonly number[];
}

export type BridgeStepState =
  'PENDING' | 'SKIPPED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'NOT_RUN';

export type BridgeStream = 'stdout' | 'stderr';

export interface BridgeStep {
  readonly id: string;
  readonly title: string;
  readonly state: BridgeStepState;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly command: readonly string[] | null;
  readonly skipReason: string | null;
  readonly outputTail?: readonly { readonly stream: BridgeStream; readonly line: string }[];
}

export interface BridgeResultInput {
  readonly id: string;
  /** Secret values are always `null` in a result projection (§10). */
  readonly value: string | boolean | readonly string[] | null;
  readonly source: BridgeValueSource | null;
  readonly secret: boolean;
  readonly enabled: boolean;
  readonly ignored?: 'input disabled';
}

export type BridgeRunStatus =
  | 'succeeded'
  | 'planned'
  | 'failed'
  | 'cancelled'
  | 'config_error'
  | 'input_error'
  | 'resolution_error'
  | 'internal_error';

export type BridgeRunMode = 'gui' | 'interactive' | 'non-interactive';

/** The complete plain-data RunResult that already crosses the bridge. */
export interface BridgeResult {
  readonly resultSchemaVersion: 2;
  readonly id: string;
  readonly status: BridgeRunStatus;
  readonly exitCode: number;
  readonly mode: BridgeRunMode;
  readonly dryRun: boolean;
  readonly crossPlatformPreview: boolean;
  readonly platform: 'windows' | 'linux';
  readonly locale: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly runeVersion: string;
  readonly product: { readonly name: string; readonly version: string } | null;
  readonly manifest: {
    readonly path: string;
    readonly sha256: string | null;
    readonly schemaVersion: number | null;
  };
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly location: {
      readonly file: string;
      readonly line: number;
      readonly column: number;
    } | null;
  } | null;
  readonly stepsTotal: number;
  readonly stepsExecuted: number;
  readonly stepsSucceeded: number;
  readonly stepsFailed: number;
  readonly stepsCancelled: number;
  readonly stepsSkipped: number;
  readonly stepsNotRun: number;
  readonly nothingExecuted: boolean;
  readonly inputs: readonly BridgeResultInput[];
  readonly steps: readonly BridgeStep[];
}

export interface BridgeTheme {
  readonly accentColor?: string;
  /** Canonical `file:` URL projected from the engine's absolute logo path. */
  readonly logo?: string;
  /** Canonical `file:` URL projected from the engine's absolute banner path. */
  readonly banner?: string;
  /** Canonical `file:` URL projected from the engine's absolute author-theme path. */
  readonly theme?: string;
  readonly windowTitle?: string;
}

export type BridgeEvent =
  | { readonly kind: 'runStarted'; readonly plan: BridgePlan }
  | {
      readonly kind: 'stepStarted';
      readonly stepId: string;
      readonly index: number;
      readonly total: number;
      readonly title: string;
    }
  | {
      readonly kind: 'stepOutput';
      readonly stepId: string;
      readonly stream: BridgeStream;
      readonly line: string;
    }
  | {
      readonly kind: 'stepFinished';
      readonly stepId: string;
      readonly state: BridgeStepState;
      /** Absent when the step has no exit code. */
      readonly exitCode?: number;
      readonly durationMs: number;
    }
  | { readonly kind: 'runFinished'; readonly result: BridgeResult };
