// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Static-safety rules from docs/architecture.md (§14 "Static-safety lint test", invariant 2):
 * RUNE executes argv arrays only — never a shell — and never evaluates code.
 */
// `default` is part of the list on purpose: without it `import cp from 'node:child_process'`
// hands out cp.exec/cp.execSync unchecked, and no member-expression heuristic can see through
// an arbitrary local alias. Named argv-only APIs (spawn, spawnSync, fork) stay importable.
const childProcessShellApis = ['default', 'exec', 'execSync', 'execFile', 'execFileSync'];
const argvOnlyMessage =
  'RUNE executes argv arrays only: use spawn(command, args, { shell: false }) — see docs/architecture.md §8 and invariant 2.';
const shellOptionMessage = `the shell option must be the literal false — ${argvOnlyMessage}`;

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/node_modules/**',
      '**/coverage/**',
      'output/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['examples/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly' },
    },
  },
  {
    // CommonJS tool configuration (.dependency-cruiser.cjs today). Linted like everything else
    // so the static-safety rules below cover it too, instead of being excluded from the gate.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        module: 'writable',
        process: 'readonly',
        require: 'readonly',
      },
    },
    // `require` is the module system in a .cjs file; reaching child_process through it is
    // still banned by the no-restricted-syntax selector below.
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      // No code evaluation, ever.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // No shell-based process APIs; spawn with shell:false is the only execution primitive.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              importNames: childProcessShellApis,
              message: argvOnlyMessage,
            },
            { name: 'child_process', importNames: childProcessShellApis, message: argvOnlyMessage },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Scoped to object literals: reading a `shell` property back out of an options
          // object (`const { shell } = options`) is not an execution decision.
          selector:
            "ObjectExpression > Property[key.name='shell']:not([value.type='Literal'][value.value=false])",
          message: shellOptionMessage,
        },
        {
          selector:
            "ObjectExpression > Property[key.value='shell']:not([value.type='Literal'][value.value=false])",
          message: shellOptionMessage,
        },
        {
          // Belt and braces for the conventional aliases; the import ban above is the gate.
          selector:
            'MemberExpression[object.name=/^(cp|childProcess|child_process)$/][property.name=/^exec(Sync|File|FileSync)?$/]',
          message: argvOnlyMessage,
        },
        {
          // no-restricted-imports only sees static ESM imports, so close the two remaining
          // module forms: dynamic import() and CommonJS require().
          selector: 'ImportExpression[source.value=/^(node:)?child_process$/]',
          message: argvOnlyMessage,
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?child_process$/]",
          message: argvOnlyMessage,
        },
      ],

      // Hygiene.
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
