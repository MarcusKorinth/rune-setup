/**
 * Reading a manifest from disk to a validated model (docs/architecture.md §4, §7 stages 1–2).
 *
 * `schemaVersion` is read from the raw document *before* any model validation and dispatched
 * through a version registry, so a manifest written for a future version is rejected with an
 * upgrade hint instead of a wall of schema errors.
 */

import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import { ManifestError } from '../errors.js';
import {
  loadYamlFile,
  loadYamlFileWithMetadata,
  loadYamlText,
  type LoadedDocument,
} from './loader.js';
import { startOfFile, type Location } from './source.js';
import { presentIssues } from './v1/present.js';
import { checkSemantics, environmentReferences, type EnvironmentUse } from './v1/rules.js';
import { manifestV1Schema, type ManifestV1 } from './v1/schema.js';

/** The validated manifest model. Today that is always the v1 model. */
export type Manifest = ManifestV1;

/** Package-internal manifest identity derived from the same bytes as the validated model. */
export interface ParsedManifest {
  readonly manifest: Manifest;
  readonly sha256: string;
}

export interface ParseManifestOptions {
  /** Check that `gui:` asset paths exist — `validate` and `run --gui` do, other modes do not. */
  readonly checkAssetFiles?: boolean;
  /** Directory relative paths resolve against; defaults to the manifest's own directory. */
  readonly manifestDir?: string;
}

interface ParseContext {
  readonly manifestDir: string;
  readonly checkAssetFiles: boolean;
}

type VersionParser = (document: LoadedDocument, context: ParseContext) => Manifest;

/** One parser per schema version; new versions are added here, never by reinterpreting v1. */
const PARSERS = new Map<number, VersionParser>([[1, parseV1]]);

export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [...PARSERS.keys()].sort(
  (a, b) => a - b,
);

/** Reads, parses and validates a manifest file. Throws {@link ManifestError} with every problem. */
export function parseManifest(file: string, options: ParseManifestOptions = {}): Manifest {
  return parseDocument(loadYamlFile(file), file, options);
}

/** Reads once, then validates and hashes that one byte snapshot. Not part of the root API. */
export function parseManifestWithMetadata(
  file: string,
  options: ParseManifestOptions = {},
): ParsedManifest {
  const document = loadYamlFileWithMetadata(file);
  return {
    manifest: parseDocument(document, file, options),
    sha256: document.sha256,
  };
}

/** Same as {@link parseManifest} for text that is already in memory. */
export function parseManifestText(
  text: string,
  file: string,
  options: ParseManifestOptions = {},
): Manifest {
  return parseDocument(loadYamlText(text, file), file, options);
}

/** What `rune validate` reports: the manifest it accepted, and what that manifest reads. */
export interface ValidationReport {
  readonly manifest: Manifest;
  /** Every environment variable the manifest reads, with the places that read it (§4.3). */
  readonly environment: readonly EnvironmentUse[];
}

/**
 * Stages 1 and 2 of the pipeline followed by the environment-variable audit (§7).
 *
 * `gui:` assets are checked on disk by default, because this is the command whose whole job
 * is to tell an author whether the manifest is ready to ship.
 */
export function validateManifest(
  file: string,
  options: ParseManifestOptions = {},
): ValidationReport {
  const document = loadYamlFile(file);
  const manifest = parseDocument(document, file, { checkAssetFiles: true, ...options });
  return {
    manifest,
    environment: environmentReferences(manifest, {
      file: document.file,
      sourceMap: document.sourceMap,
    }),
  };
}

/** The JSON Schema of the current manifest version, for editor integration (`rune schema`). */
export function manifestJsonSchema(): Record<string, unknown> {
  // `io: 'input'` describes what an author writes: fields with defaults stay optional.
  return z.toJSONSchema(manifestV1Schema, { io: 'input' }) as Record<string, unknown>;
}

function parseDocument(
  document: LoadedDocument,
  file: string,
  options: ParseManifestOptions,
): Manifest {
  const raw = document.value;

  // These carry a location, and the location already names the document — a message that
  // names it again makes every renderer print the file twice.
  if (raw === null || raw === undefined) {
    throw new ManifestError('RUNE-103', 'the manifest is empty', { location: startOf(document) });
  }
  if (!isRecord(raw)) {
    throw new ManifestError('RUNE-103', 'the manifest must contain a mapping at the top level', {
      location: startOf(document),
    });
  }

  const parser = selectParser(raw['schemaVersion'], document);
  return parser(document, {
    manifestDir: options.manifestDir ?? dirname(resolve(file)),
    checkAssetFiles: options.checkAssetFiles ?? false,
  });
}

function selectParser(version: unknown, document: LoadedDocument): VersionParser {
  const supported = SUPPORTED_SCHEMA_VERSIONS.join(', ');
  const location = document.sourceMap.best(['schemaVersion']) ?? startOf(document);

  if (version === undefined) {
    throw new ManifestError('RUNE-102', `schemaVersion is required (supported: ${supported})`, {
      location,
    });
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new ManifestError(
      'RUNE-102',
      `schemaVersion must be an integer (supported: ${supported})`,
      { location },
    );
  }

  const parser = PARSERS.get(version);
  if (!parser) {
    throw new ManifestError(
      'RUNE-102',
      `schemaVersion ${version} is not supported by this version of RUNE (supported: ${supported}) — upgrade RUNE, or lower the manifest's schemaVersion`,
      { location },
    );
  }
  return parser;
}

function parseV1(document: LoadedDocument, context: ParseContext): Manifest {
  const result = manifestV1Schema.safeParse(document.value);

  if (!result.success) {
    throw ManifestError.fromIssues(
      'RUNE-103',
      presentIssues(result.error.issues, {
        file: document.file,
        sourceMap: document.sourceMap,
        raw: document.value,
      }),
    );
  }

  const semantic = checkSemantics(result.data, {
    file: document.file,
    sourceMap: document.sourceMap,
    manifestDir: context.manifestDir,
    checkAssetFiles: context.checkAssetFiles,
  });
  if (semantic.length > 0) {
    throw ManifestError.fromIssues('RUNE-104', semantic);
  }

  // The manifest is handed to the CLI and to the GUI shell's main process and read from
  // there for the rest of the run; freezing it keeps "the manifest" one thing that cannot
  // be changed under another reader's feet (docs/architecture.md §3).
  return deepFreeze(result.data);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}

function startOf(document: LoadedDocument): Location {
  return startOfFile(document.file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
