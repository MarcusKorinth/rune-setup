import { describe, expect, it, vi } from 'vitest';

import { ManifestError } from '../../src/errors.js';
import { parseManifestText } from '../../src/manifest/index.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];

/** Every message a manifest is rejected with; the checks under test collect, never stop early. */
function errorOf(lines: readonly string[]): ManifestError {
  try {
    parseManifestText([...HEAD, ...lines, ''].join('\n'), 'installer.yaml');
  } catch (error) {
    if (error instanceof ManifestError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the manifest to be rejected');
}

function messagesOf(lines: readonly string[]): string[] {
  return errorOf(lines).issues.map((issue) => issue.message);
}

function accepts(lines: readonly string[]): void {
  expect(() =>
    parseManifestText([...HEAD, ...lines, ''].join('\n'), 'installer.yaml'),
  ).not.toThrow();
}

describe('references in interpolated fields', () => {
  it('accepts inputs, built-ins, product fields and the environment', () => {
    accepts([
      'inputs:',
      '  installDirectory:',
      '    type: directory',
      '    default: "${home}/${product.name}"',
      'steps:',
      '  - id: install',
      '    run:',
      '      command: "${env.JAVA_HOME}/bin/java"',
      '      args: ["-jar", "${manifestDir}/setup.jar", "${installDirectory}"]',
      '      cwd: "${installDirectory}"',
      '      env:',
      '        TARGET: "${installDirectory}"',
      '        PLATFORM: "${platform}"',
    ]);
  });

  it('checks every interpolated field, wherever it sits', () => {
    const messages = messagesOf([
      'steps:',
      '  - id: install',
      '    run:',
      '      command: "${nope1}"',
      '      args: ["${nope2}"]',
      '      cwd: "${nope3}"',
      '      env:',
      '        A: "${nope4}"',
      '  - id: second',
      '    run:',
      '      windows:',
      '        command: "${nope5}"',
      '      linux:',
      '        command: "${nope6}"',
    ]);

    expect(messages).toHaveLength(6);
    expect(messages[0]).toBe(
      'steps[0].run.command: ${nope1} is neither a declared input nor a built-in variable',
    );
    expect(messages[1]).toMatch(/^steps\[0\]\.run\.args\[0\]: /);
    expect(messages[3]).toMatch(/^steps\[0\]\.run\.env\.A: /);
    expect(messages[4]).toMatch(/^steps\[1\]\.run\.windows\.command: /);
    expect(messages[5]).toMatch(/^steps\[1\]\.run\.linux\.command: /);
  });

  it('reports a malformed reference as a syntax problem of that field', () => {
    expect(messagesOf(['steps:', '  - id: a', '    run:', '      command: "x ${home"'])).toEqual([
      'steps[0].run.command: unterminated ${ — a reference needs a closing brace, and a literal $ followed by a brace is written $${',
    ]);
  });

  it('says the same about a malformed reference in a condition as in an argument', () => {
    const inArgument = messagesOf([
      'steps:',
      '  - id: install',
      '    run:',
      '      command: echo',
      '      args: ["${a-b}"]',
    ]);
    const inCondition = messagesOf([
      'steps:',
      '  - id: install',
      '    when: "${a-b}"',
      '    run:',
      '      command: echo',
    ]);

    const explanation = '${a-b} is not a name: "a-b" must match [A-Za-z_][A-Za-z0-9_]*';
    expect(inArgument).toEqual([`steps[0].run.args[0]: ${explanation}`]);
    expect(inCondition).toEqual([`steps[0].when: ${explanation}`]);
  });

  it('accepts an escaped ${ as the text it is', () => {
    accepts(['steps:', '  - id: a', '    run:', '      command: echo', '      args: ["$${home}"]']);
  });

  it('refuses a reference to an input from a default, and says why', () => {
    expect(
      messagesOf([
        'inputs:',
        '  root:',
        '    type: directory',
        '  logs:',
        '    type: directory',
        '    default: "${root}/logs"',
        'steps: []',
      ]),
    ).toEqual([
      'inputs.logs.default: ${root} cannot be used in a default — defaults are rendered before the other inputs are known, so they may only use built-in variables and ${env.*}',
    ]);
  });

  it('accepts built-ins and the environment in a default', () => {
    accepts([
      'inputs:',
      '  logs:',
      '    type: directory',
      '    default: "${home}/${env.USER}/logs"',
      'steps: []',
    ]);
  });
});

describe('conditions', () => {
  const withInputs = (...lines: readonly string[]): string[] => [
    'inputs:',
    '  installDatabase:',
    '    type: boolean',
    '  environment:',
    '    type: select',
    '    options: [dev, prod]',
    '  tools:',
    '    type: multiselect',
    '    options: [git, docker]',
    ...lines,
  ];

  it('accepts the documented forms', () => {
    accepts(
      withInputs(
        'steps:',
        '  - id: a',
        '    when: "${installDatabase}"',
        '    run:',
        '      command: x',
        '  - id: b',
        "    when: \"${environment} == 'prod' && 'git' in ${tools}\"",
        '    run:',
        '      command: y',
      ),
    );
  });

  it('reports a condition that does not parse', () => {
    expect(
      messagesOf(
        withInputs('steps:', '  - id: a', '    when: "prod"', '    run:', '      command: x'),
      ),
    ).toEqual([
      'steps[0].when: "prod" is not a value — write a quoted string, or ${prod} to mean the input',
    ]);
  });

  it('reports unsafe integer literals in input and step conditions as located RUNE-104 issues', () => {
    const error = errorOf([
      'inputs:',
      '  guarded:',
      '    type: text',
      '    when: "-9007199254740992 == -9007199254740991"',
      'steps:',
      '  - id: guarded-step',
      '    when: "9007199254740992 == 9007199254740991"',
      '    run:',
      '      command: x',
    ]);

    expect(error.code).toBe('RUNE-104');
    expect(error.issues).toEqual([
      expect.objectContaining({
        code: 'RUNE-104',
        message:
          'inputs.guarded.when: integer literals must be between -9007199254740991 and 9007199254740991',
        location: expect.objectContaining({ file: 'installer.yaml', line: 8, column: 5 }),
      }),
      expect.objectContaining({
        code: 'RUNE-104',
        message:
          'steps[0].when: integer literals must be between -9007199254740991 and 9007199254740991',
        location: expect.objectContaining({ file: 'installer.yaml', line: 11, column: 5 }),
      }),
    ]);
  });

  it('refuses a select standing on its own and shows the comparison to write', () => {
    expect(
      messagesOf(
        withInputs(
          'steps:',
          '  - id: a',
          '    when: "${environment}"',
          '    run:',
          '      command: x',
        ),
      ),
    ).toEqual([
      "steps[0].when: ${environment} is a string, not a condition — compare it explicitly, for example ${environment} == 'production'",
    ]);
  });

  it('checks a condition against the declared types with no values at all', () => {
    expect(
      messagesOf(
        withInputs(
          'steps:',
          '  - id: a',
          '    when: "${installDatabase} == \'yes\'"',
          '    run:',
          '      command: x',
        ),
      ),
    ).toEqual([
      'steps[0].when: ${installDatabase} is a boolean and "yes" is a string — only values of the same type can be compared',
    ]);
  });

  it('rejects a reference a condition cannot resolve', () => {
    expect(
      messagesOf(
        withInputs('steps:', '  - id: a', '    when: "${nope}"', '    run:', '      command: x'),
      ),
    ).toEqual(['steps[0].when: ${nope} is neither a declared input nor a built-in variable']);
  });

  it('reuses one unknown-reference explanation across repeated step conditions', () => {
    const inputCount = 64;
    const stepCount = 100;
    const inputs = [
      '  cacheTarget:',
      '    type: text',
      ...Array.from({ length: inputCount - 1 }, (_unused, index) => [
        `  cache${index.toString().padStart(3, '0')}:`,
        '    type: text',
      ]).flat(),
    ];
    const steps = Array.from({ length: stepCount }, (_unused, index) => [
      `  - id: cached-${index}`,
      '    when: "${cacheTargte} == \'x\'"',
      '    run:',
      '      command: x',
    ]).flat();
    const lowercase = vi.spyOn(String.prototype, 'toLowerCase');
    let messages: string[];
    let inputCandidateReads = 0;

    try {
      messages = messagesOf(['inputs:', ...inputs, 'steps:', ...steps]);
      inputCandidateReads = lowercase.mock.contexts.filter((value) =>
        /^cache(?:Target|\d{3})$/.test(String(value)),
      ).length;
    } finally {
      lowercase.mockRestore();
    }

    expect(messages).toHaveLength(stepCount);
    expect(messages.every((message) => message.includes('did you mean ${cacheTarget}?'))).toBe(
      true,
    );
    // At most one pass indexes candidate widths and one cache miss scans candidates for the hint.
    expect(inputCandidateReads).toBeLessThanOrEqual(inputCount * 2);
  });

  it('bounds unique-reference suggestion work without dropping any issue', () => {
    const inputCount = 100;
    const inputs = Array.from({ length: inputCount }, (_unused, index) => [
      `  budget${index.toString().padStart(3, '0')}:`,
      '    type: text',
    ]).flat();
    const steps = Array.from({ length: inputCount }, (_unused, index) => [
      `  - id: budget-${index}`,
      `    when: "\${budegt${index.toString().padStart(3, '0')}} == 'x'"`,
      '    run:',
      '      command: x',
    ]).flat();
    const lowercase = vi.spyOn(String.prototype, 'toLowerCase');
    let messages: string[];
    let inputCandidateReads = 0;

    try {
      messages = messagesOf(['inputs:', ...inputs, 'steps:', ...steps]);
      inputCandidateReads = lowercase.mock.contexts.filter((value) =>
        /^budget\d{3}$/.test(String(value)),
      ).length;
    } finally {
      lowercase.mockRestore();
    }

    expect(messages).toHaveLength(inputCount);
    expect(messages.filter((message) => message.includes('did you mean')).length).toBe(24);
    // At most one width-index pass plus 24 allowed candidate scans; denied hints do not scan.
    expect(inputCandidateReads).toBeLessThanOrEqual(inputCount * 25);
  });
});

describe('an input condition may only look up the document', () => {
  it('accepts a reference to an input declared above it', () => {
    accepts([
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '  databasePort:',
      '    type: text',
      '    when: "${installDatabase}"',
      'steps: []',
    ]);
  });

  it('refuses a reference to an input declared below it', () => {
    expect(
      messagesOf([
        'inputs:',
        '  databasePort:',
        '    type: text',
        '    when: "${installDatabase}"',
        '  installDatabase:',
        '    type: boolean',
        'steps: []',
      ]),
    ).toEqual([
      'inputs.databasePort.when: ${installDatabase} is declared below this input — a condition may only use inputs written above it, so move "installDatabase" up',
    ]);
  });

  it('refuses an input that decides about itself', () => {
    expect(
      messagesOf(['inputs:', '  a:', '    type: boolean', '    when: "${a}"', 'steps: []']),
    ).toEqual([
      "inputs.a.when: ${a} is this input's own value — a condition cannot depend on the input it decides about",
    ]);
  });

  it('lets a step condition see every input, wherever it is declared', () => {
    accepts([
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      'steps:',
      '  - id: a',
      '    when: "${installDatabase}"',
      '    run:',
      '      command: x',
    ]);
  });
});
