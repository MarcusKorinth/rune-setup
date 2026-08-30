import { describe, expect, it } from 'vitest';

import {
  INPUT_TYPES,
  InternalError,
  parseManifestText,
  resolveStrings,
  type InputState,
  type InputType,
} from '@rune/engine';

import { CliPromptRegistry, cliPromptPresenters, type CliPromptPresenter } from '../src/prompt.js';

const MANIFEST = parseManifestText(
  [
    'schemaVersion: 1',
    'product:',
    '  name: Example',
    '  version: "1.0.0"',
    'inputs:',
    '  plain:',
    '    type: text',
    '    description: Plain description',
    '  password:',
    '    type: secret',
    '  confirmed:',
    '    type: boolean',
    '  channel:',
    '    type: select',
    '    options:',
    '      - value: prod',
    '        label: Production',
    '  features:',
    '    type: multiselect',
    '    options: [git, docker]',
    '  sourceFile:',
    '    type: file',
    '  targetDirectory:',
    '    type: directory',
    'steps: []',
    '',
  ].join('\n'),
  'prompt-registry.yaml',
);

const STRINGS = resolveStrings({ manifest: MANIFEST });

function state(id: keyof typeof MANIFEST.inputs): InputState {
  const spec = MANIFEST.inputs[id];
  if (spec === undefined) {
    throw new Error(`the test manifest has no input named "${id}"`);
  }
  return {
    id,
    spec,
    enabled: true,
    value: undefined,
    source: undefined,
    invalid: undefined,
    ignored: undefined,
  };
}

describe('the CLI prompt presenter registry', () => {
  it('has one explicit presenter for every public input type', () => {
    expect([...cliPromptPresenters.names()].sort()).toEqual([...INPUT_TYPES].sort());
    for (const type of INPUT_TYPES) {
      expect(cliPromptPresenters.get(type).name).toBe(type);
    }
  });

  it('rejects duplicate registration instead of replacing a presenter', () => {
    const textPresenter = cliPromptPresenters.get('text');
    const registry = new CliPromptRegistry([textPresenter]);

    expect(() => registry.register(textPresenter)).toThrow(/registered twice/);
  });

  it('fails with a named internal error when a future type has no presenter', () => {
    const registry = new CliPromptRegistry();
    let thrown: unknown;

    try {
      registry.get('future');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalError);
    expect(thrown).toMatchObject({
      code: 'RUNE-500',
      message: expect.stringContaining(
        'no CLI prompt presenter is registered for input type "future"',
      ),
    });
  });

  it('fails the session-open assertion when any input type is not presentable', () => {
    const future = {
      ...state('plain'),
      spec: { ...MANIFEST.inputs.plain, type: 'future' as InputType },
    } as InputState;

    expect(() => new CliPromptRegistry().assertPresentable([future])).toThrow(
      /no CLI prompt presenter is registered for input type "future"/,
    );
  });

  it('preserves the type-specific help, labels, muting, and base questions', () => {
    const presentations = Object.fromEntries(
      Object.keys(MANIFEST.inputs).map((id) => {
        const input = state(id);
        return [id, cliPromptPresenters.get(input.spec.type).present(input, STRINGS)];
      }),
    ) as Record<string, ReturnType<CliPromptPresenter['present']>>;

    expect(presentations['plain']).toEqual({
      lines: ['Plain description'],
      question: 'Enter a value for plain: ',
      muted: false,
    });
    expect(presentations['password']).toEqual({
      lines: [],
      question: 'Enter a value for password: ',
      muted: true,
    });
    expect(presentations['confirmed']?.lines).toEqual(['enter true or false']);
    expect(presentations['channel']?.lines).toEqual([
      '  - Production (prod)',
      'enter the value of one option',
    ]);
    expect(presentations['features']?.lines).toEqual([
      '  - git (git)',
      '  - docker (docker)',
      'enter option values, separated by commas',
    ]);
    expect(presentations['sourceFile']).toEqual({
      lines: [],
      question: 'Enter a value for sourceFile: ',
      muted: false,
    });
    expect(presentations['targetDirectory']).toEqual({
      lines: [],
      question: 'Enter a value for targetDirectory: ',
      muted: false,
    });
  });
});
