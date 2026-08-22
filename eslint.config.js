// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Static-safety rules from docs/architecture.md (§14 "Static-safety lint test", invariant 2):
 * RUNE executes argv arrays only — never a shell — and never evaluates code.
 */
const childProcessShellApis = ['exec', 'execSync', 'execFile', 'execFileSync'];
const argvOnlyMessage =
  'RUNE executes argv arrays only: use spawn(command, args, { shell: false }) — see docs/architecture.md §8 and invariant 2.';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.dependency-cruiser.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
          selector: "Property[key.name='shell']:not([value.type='Literal'][value.value=false])",
          message: `the shell option must be the literal false — ${argvOnlyMessage}`,
        },
        {
          selector: "Property[key.value='shell']:not([value.type='Literal'][value.value=false])",
          message: `the shell option must be the literal false — ${argvOnlyMessage}`,
        },
        {
          selector:
            'MemberExpression[object.name=/^(cp|childProcess|child_process)$/][property.name=/^exec(Sync|File|FileSync)?$/]',
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
