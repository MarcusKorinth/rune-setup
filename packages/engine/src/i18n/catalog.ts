/**
 * RUNE's own UI strings — the "chrome" (docs/architecture.md §6.3).
 *
 * The catalogue is the key authority: an overlay may override exactly these keys under the
 * reserved `rune.` prefix, and anything else is a located validation error. RUNE ships
 * English built-ins only; every other language comes from the manifest author's overlays.
 */

export const SUMMARY_ACTIONS = Object.freeze({
  proceed: Object.freeze({
    alias: 'proceed',
    tokenKey: 'rune.summary.proceedToken',
    defaultToken: 'p',
  }),
  cancel: Object.freeze({
    alias: 'cancel',
    tokenKey: 'rune.summary.cancelToken',
    defaultToken: 'c',
  }),
});

export const CHROME_CATALOG: ReadonlyMap<string, string> = new Map([
  ['rune.button.next', 'Next'],
  ['rune.button.back', 'Back'],
  ['rune.button.cancel', 'Cancel'],
  ['rune.button.install', 'Install'],
  ['rune.button.finish', 'Finish'],
  ['rune.page.welcome.title', 'Welcome'],
  ['rune.page.inputs.title', 'Configuration'],
  ['rune.page.summary.title', 'Summary'],
  ['rune.page.progress.title', 'Installing'],
  ['rune.page.result.title', 'Result'],
  ['rune.prompt.value', 'Enter a value for {title}'],
  ['rune.prompt.inputEnded', 'input ended before every question was answered'],
  ['rune.prompt.selectOne', 'enter the value of one option'],
  ['rune.prompt.selectMany', 'enter option values, separated by commas'],
  ['rune.prompt.boolean', 'enter true or false'],
  ['rune.prompt.proceed', 'Proceed with these values?'],
  ['rune.summary.heading', 'Review your configuration'],
  ['rune.summary.proceed', 'Proceed'],
  [SUMMARY_ACTIONS.proceed.tokenKey, SUMMARY_ACTIONS.proceed.defaultToken],
  ['rune.summary.change', 'Change a value'],
  ['rune.summary.cancel', 'Cancel'],
  [SUMMARY_ACTIONS.cancel.tokenKey, SUMMARY_ACTIONS.cancel.defaultToken],
  ['rune.summary.notSet', '(not set)'],
  ['rune.summary.invalidChoice', '"{choice}" is not {proceed}, {cancel}, or the number of a value'],
  ['rune.run.cancelling', 'cancelling - press Ctrl+C again to force quit'],
  ['rune.run.cancelledAtSummary', 'cancelled at the summary'],
  ['rune.plan.heading', 'Plan for {product} {version} ({path}, platform {platform}{preview})'],
  ['rune.plan.crossPlatformPreview', ', cross-platform preview'],
  ['rune.plan.step', '  {number} {title}'],
  ['rune.plan.skipped', '  {number} {title} — {state} ({reason})'],
  ['rune.plan.command', '       {command}'],
  ['rune.progress.running', 'running {total} steps on {platform}'],
  ['rune.progress.step', 'Step {index} of {total}: {title}'],
  ['rune.progress.output', '  {line}'],
  ['rune.progress.finished', '  -> {state}{exit}{duration}'],
  ['rune.progress.exit', ' (exit {code})'],
  ['rune.progress.duration', ' after {duration}ms'],
  ['rune.warning.message', 'warning: {warning}'],
  ['rune.result.succeeded', 'Setup completed successfully.'],
  ['rune.result.failed', 'Setup failed.'],
  ['rune.result.cancelled', 'Setup was cancelled.'],
  ['rune.result.planned', 'Dry run: nothing was executed.'],
  ['rune.result.nothingExecuted', 'No step needed to run.'],
  [
    'rune.result.summary',
    '{succeeded} succeeded, {failed} failed, {skipped} skipped, {notrun} not run (exit {exit})',
  ],
  ['rune.result.written', 'result written to {path}'],
]);

/** The one normalization used for configured summary tokens and entered choices. */
export function normalizeSummaryChoice(choice: string): string {
  return choice.trim().toLowerCase();
}

/**
 * Fills `{name}` placeholders in a chrome string. Single pass over the template, and a
 * substituted value is never re-scanned — the same discipline as `${...}` interpolation.
 */
export function formatChrome(
  template: string,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
