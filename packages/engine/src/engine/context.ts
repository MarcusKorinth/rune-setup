/**
 * What `${...}` can refer to (docs/architecture.md §6.1).
 *
 * This module owns the *names*: which are built in, which belong to a namespace, and which
 * are reserved for a later schema version. The values behind them are produced during input
 * resolution and planning; a name that is not listed here resolves to nothing, anywhere.
 */

import { homedir, tmpdir } from 'node:os';
import { isAbsolute, win32 } from 'node:path';

import { InternalError, PlatformError, ResolutionError } from '../errors.js';
import { suggest } from '../suggest.js';
import type { InputType } from '../manifest/v1/schema.js';

/** Built-in variables that stand alone: `${home}`, `${temp}`, `${platform}`, `${manifestDir}`. */
export const BUILT_IN_VARIABLES = ['home', 'temp', 'platform', 'manifestDir'] as const;
export type BuiltInVariable = (typeof BUILT_IN_VARIABLES)[number];

/** Fields of `${product.*}`. */
export const PRODUCT_FIELDS = ['name', 'version'] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];

/** The process environment, read-only and freely readable (§6.1, §4.3). */
export const ENVIRONMENT_NAMESPACE = 'env';
export const PRODUCT_NAMESPACE = 'product';

/**
 * Namespaces v1 rejects on purpose, so a later version can define them (§13). A `Map` rather
 * than an object literal: a plain object answers for every name on `Object.prototype`, so an
 * input legitimately called `toString` would be rejected as a reserved namespace.
 */
export const RESERVED_NAMESPACES = new Map<string, string>([
  ['steps', 'step outputs'],
  ['rune', 'engine variables'],
]);

/**
 * Every name `${...}` already means something. An input may not take one as its id: the
 * reference would be ambiguous, and the built-in would win silently.
 */
export const BUILT_IN_NAMES: readonly string[] = [
  ...BUILT_IN_VARIABLES,
  PRODUCT_NAMESPACE,
  ENVIRONMENT_NAMESPACE,
  ...RESERVED_NAMESPACES.keys(),
];

/** What a `${...}` reference points at, once it is known to point at something. */
export type Reference =
  | { readonly kind: 'input'; readonly id: string }
  | { readonly kind: 'builtin'; readonly name: BuiltInVariable }
  | { readonly kind: 'product'; readonly field: ProductField }
  | { readonly kind: 'environment'; readonly name: string };

export type ReferenceResolution =
  | { readonly ok: true; readonly reference: Reference }
  | { readonly ok: false; readonly message: string };

/** Ordered input ids plus their constant-time declaration ordinals. */
export interface InputReferenceIndex {
  readonly orderedIds: readonly string[];
  readonly ordinals: ReadonlyMap<string, number>;
}

/** Builds the reference authority once for one immutable manifest input order. */
export function createInputReferenceIndex(inputIds: readonly string[]): InputReferenceIndex {
  return {
    orderedIds: inputIds,
    ordinals: new Map(inputIds.map((id, ordinal) => [id, ordinal])),
  };
}

/**
 * Resolves the dotted path of a `${...}` reference against the declared inputs and the
 * built-ins. The message of a failure is the whole error a reader gets, so it says what the
 * name would have to be instead of only that it is wrong.
 *
 * `visibleInputCount` is an ordinal boundary: valid input membership is constant-time while
 * the ordered ids remain available for deterministic suggestions on the invalid path.
 * Callers that only classify references may turn suggestions off, avoiding candidate work
 * that cannot affect their result.
 */
export function resolveReference(
  segments: readonly string[],
  inputs: InputReferenceIndex,
  visibleInputCount = inputs.orderedIds.length,
  includeSuggestion = true,
): ReferenceResolution {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return { ok: false, message: 'an empty reference points at nothing' };
  }

  const reserved = RESERVED_NAMESPACES.get(head);
  if (reserved !== undefined) {
    return {
      ok: false,
      message: `\${${segments.join('.')}} is reserved for ${reserved} and is not available in schemaVersion 1`,
    };
  }

  if (head === ENVIRONMENT_NAMESPACE) {
    const [name, ...extra] = rest;
    if (name === undefined) {
      return { ok: false, message: '${env} needs the name of a variable: ${env.PATH}' };
    }
    if (extra.length > 0) {
      return {
        ok: false,
        message: `\${${segments.join('.')}} has one segment too many — an environment variable is \${env.NAME}`,
      };
    }
    return { ok: true, reference: { kind: 'environment', name } };
  }

  if (head === PRODUCT_NAMESPACE) {
    const [field, ...extra] = rest;
    if (field === undefined || extra.length > 0 || !isProductField(field)) {
      return {
        ok: false,
        message: `\${${segments.join('.')}} is not a product field — ${PRODUCT_FIELDS.map((known) => `\${product.${known}}`).join(' and ')} exist`,
      };
    }
    return { ok: true, reference: { kind: 'product', field } };
  }

  if (isBuiltInVariable(head)) {
    if (rest.length > 0) {
      return {
        ok: false,
        message: `\${${head}} is a value, not a namespace — \${${segments.join('.')}} points at nothing`,
      };
    }
    return { ok: true, reference: { kind: 'builtin', name: head } };
  }

  const inputOrdinal = inputs.ordinals.get(head);
  if (inputOrdinal !== undefined && inputOrdinal < visibleInputCount) {
    if (rest.length > 0) {
      return {
        ok: false,
        message: `\${${head}} is an input value, not a namespace — \${${segments.join('.')}} points at nothing`,
      };
    }
    return { ok: true, reference: { kind: 'input', id: head } };
  }

  let suggestion: string | undefined;
  if (includeSuggestion) {
    const visibleInputIds =
      visibleInputCount >= inputs.orderedIds.length
        ? inputs.orderedIds
        : inputs.orderedIds.slice(0, visibleInputCount);
    suggestion = suggest(head, [...visibleInputIds, ...BUILT_IN_VARIABLES, PRODUCT_NAMESPACE]);
  }
  return {
    ok: false,
    message: `\${${segments.join('.')}} is neither a declared input nor a built-in variable${
      suggestion === undefined ? '' : ` — did you mean \${${suggestion}}?`
    }`,
  };
}

/** The type a reference carries into a condition (docs/architecture.md §6.2). */
export type ValueType = 'boolean' | 'string' | 'integer' | 'stringList';

/** The value type of an input, which is what makes conditions checkable without values. */
export function typeOfInput(type: InputType): ValueType {
  switch (type) {
    case 'boolean':
      return 'boolean';
    case 'multiselect':
      return 'stringList';
    default:
      return 'string';
  }
}

/** The value type of a resolved reference. Everything but an input is a plain string. */
export function typeOfReference(
  reference: Reference,
  typeOfInputId: (id: string) => InputType | undefined,
): ValueType | undefined {
  if (reference.kind !== 'input') {
    return 'string';
  }
  const type = typeOfInputId(reference.id);
  return type === undefined ? undefined : typeOfInput(type);
}

function isBuiltInVariable(name: string): name is BuiltInVariable {
  return (BUILT_IN_VARIABLES as readonly string[]).includes(name);
}

function isProductField(name: string): name is ProductField {
  return (PRODUCT_FIELDS as readonly string[]).includes(name);
}

// ------------------------------------------------------------------- runtime values

/** The platforms RUNE runs on. `macos` is reserved for a later schema version (§4.2). */
export const PLATFORMS = ['windows', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The platform this process is on. */
export function hostPlatform(): Platform {
  return platformForNode(process.platform);
}

/** Maps Node's host identifier without treating an unsupported host as Linux. */
export function platformForNode(platform: NodeJS.Platform): Platform {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      throw new PlatformError(
        `host platform "${platform}" is not supported; supported Node platforms are win32 and linux`,
      );
  }
}

export interface RuntimeContextOptions {
  /** Absolute directory of the manifest — what every relative path is anchored to (§6.1). */
  readonly manifestDir: string;
  readonly product: { readonly name: string; readonly version: string };
  /** Defaults to the host; `validate` and `--dry-run` may preview the other one. */
  readonly platform?: Platform;
  /** Defaults to this process's environment; names always follow host-platform semantics. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Host-dependent built-ins captured for one asynchronous engine invocation. */
export interface HostBuiltInSnapshot {
  readonly home: string;
  readonly temp: string;
}

/** Captures the host-dependent built-ins before an asynchronous invocation can yield. */
export function snapshotHostBuiltIns(): HostBuiltInSnapshot {
  return Object.freeze({ home: homedir(), temp: tmpdir() });
}

/**
 * The values behind the names of §6.1.
 *
 * When a platform other than the host is previewed, the values this machine could answer for
 * — a home directory, a temporary directory — are not the target's. RUNE renders a visible
 * placeholder there instead of a plausible lie, and marks the plan as a preview (§6.1).
 */
export interface RuntimeContext {
  readonly platform: Platform;
  readonly manifestDir: string;
  /** True when `platform` is not the host's, so host-dependent values are placeholders. */
  readonly preview: boolean;
  /** Reads one string-valued own property using the host platform's environment-name semantics. */
  environmentValue(name: string): string | undefined;
  /** The text a reference contributes. Throws {@link ResolutionError} for an unset variable. */
  valueOf(reference: Reference): string;
}

const runtimeContexts = new WeakMap<RuntimeContext, RuntimeContext>();

/** Internal fail-closed lookup: structural copies have no runtime provenance. */
export function runtimeContextFor(context: RuntimeContext): RuntimeContext {
  const trusted = runtimeContexts.get(context);
  if (trusted === undefined) {
    throw new InternalError('the runtime context was not created by createRuntimeContext');
  }
  return trusted;
}

export function createRuntimeContext(
  options: RuntimeContextOptions,
  hostBuiltIns?: HostBuiltInSnapshot,
): RuntimeContext {
  const windowsRoot = win32.parse(options.manifestDir).root;
  const hasUnboundWindowsRoot =
    process.platform === 'win32' && (windowsRoot === '\\' || windowsRoot === '/');
  if (!isAbsolute(options.manifestDir) || hasUnboundWindowsRoot) {
    throw new InternalError(
      'the runtime context manifest directory must be absolute and independent of the current drive',
    );
  }
  const host = hostPlatform();
  const platform =
    options.platform === undefined ? host : validatePreviewPlatform(options.platform);
  const manifestDir = options.manifestDir;
  const productName = options.product.name;
  const productVersion = options.product.version;
  const preview = platform !== host;
  const environment = options.environment ?? process.env;
  const environmentValues = snapshotEnvironment(environment, host === 'windows');
  const home = preview ? `<home@${platform}>` : (hostBuiltIns?.home ?? homedir());
  const temp = preview ? `<temp@${platform}>` : (hostBuiltIns?.temp ?? tmpdir());

  const environmentValue = (name: string): string | undefined =>
    environmentValues.get(host === 'windows' ? name.toLowerCase() : name);

  const context: RuntimeContext = Object.freeze({
    platform,
    manifestDir,
    preview,
    environmentValue,
    valueOf(reference: Reference): string {
      switch (reference.kind) {
        case 'builtin':
          switch (reference.name) {
            case 'home':
              return home;
            case 'temp':
              return temp;
            case 'platform':
              return platform;
            case 'manifestDir':
              return manifestDir;
          }
        // eslint-disable-next-line no-fallthrough -- every branch above returns
        case 'product':
          return reference.field === 'name' ? productName : productVersion;
        case 'environment': {
          const value = environmentValue(reference.name);
          if (value === undefined) {
            throw new ResolutionError(
              'RUNE-301',
              `the environment variable ${reference.name} is not set`,
            );
          }
          return value;
        }
        case 'input':
          throw new ResolutionError(
            'RUNE-301',
            `\${${reference.id}} is an input; only the resolver knows its value`,
          );
      }
    },
  });
  runtimeContexts.set(context, context);
  return context;
}

function validatePreviewPlatform(platform: unknown): Platform {
  if (platform === 'windows' || platform === 'linux') {
    return platform;
  }
  throw new PlatformError(
    `preview platform "${String(platform)}" is not supported; supported preview platforms are windows and linux`,
  );
}

function snapshotEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  caseInsensitive: boolean,
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(environment))) {
    if (!('value' in descriptor) || typeof descriptor.value !== 'string') {
      continue;
    }
    const key = caseInsensitive ? name.toLowerCase() : name;
    if (!values.has(key)) {
      values.set(key, descriptor.value);
    }
  }
  return values;
}
