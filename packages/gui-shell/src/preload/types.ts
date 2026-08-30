/**
 * The bridge's type declarations (docs/architecture.md §9.2) — the ONLY thing the
 * renderer may import from the preload side (enforced by the dependency cruiser): plain
 * data shapes, no runtime code.
 */

/** What `window.rune` looks like from the renderer — the bridge's type declaration. */
export interface RuneBridge {
  open(): Promise<{
    runeVersion: string;
    inputTypes: readonly string[];
    product: { readonly name: string; readonly version: string };
  }>;
  pendingInputs(): Promise<readonly BridgeInput[]>;
  allInputs(): Promise<readonly BridgeInput[]>;
  setValue(id: string, raw: unknown): Promise<readonly { inputId: string; enabled: boolean }[]>;
  plan(): Promise<BridgePlan>;
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

/** The projection of an InputState: plain data, a secret's value already `null` (§9.2). */
export interface BridgeInput {
  readonly id: string;
  readonly spec: {
    readonly type: string;
    readonly title?: string;
    readonly description?: string;
    readonly required?: boolean;
    readonly patternHint?: string;
    readonly options?: readonly (string | { readonly value: string; readonly label: string })[];
  };
  readonly enabled: boolean;
  readonly value: string | boolean | readonly string[] | null;
  readonly source: string | null;
}

/** JSON-safe projection of the frozen ExecutionPlan returned by Session.plan(). */
export interface BridgePlan {
  readonly manifestPath: string;
  readonly locale?: string;
  readonly platform: 'windows' | 'linux';
  readonly preview: boolean;
  readonly failFast: boolean;
  readonly logFile?: string;
  readonly steps: readonly BridgePlannedStep[];
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

export interface BridgeStep {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly command: readonly string[] | null;
  readonly skipReason: string | null;
  readonly outputTail: readonly { readonly stream: string; readonly line: string }[] | null;
}

export interface BridgeResult {
  readonly status: string;
  readonly exitCode: number;
  readonly nothingExecuted: boolean;
  readonly stepsTotal: number;
  readonly stepsSucceeded: number;
  readonly stepsFailed: number;
  readonly stepsSkipped: number;
  readonly product: { readonly name: string; readonly version: string };
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
  | { readonly kind: 'runStarted' }
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
      readonly stream: string;
      readonly line: string;
    }
  | {
      readonly kind: 'stepFinished';
      readonly stepId: string;
      readonly state: string;
      readonly exitCode?: number;
      readonly durationMs: number;
    }
  | { readonly kind: 'runFinished'; readonly result: BridgeResult };
