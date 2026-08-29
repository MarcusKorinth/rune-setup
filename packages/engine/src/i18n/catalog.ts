/**
 * RUNE's own UI strings — the "chrome" (docs/architecture.md §6.3).
 *
 * The catalogue is the key authority: an overlay may override exactly these keys under the
 * reserved `rune.` prefix, and anything else is a located validation error. RUNE ships
 * English built-ins only; every other language comes from the manifest author's overlays.
 */

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
  ['rune.prompt.proceed', 'Proceed with these values?'],
  ['rune.summary.heading', 'Review your configuration'],
  ['rune.summary.proceed', 'Proceed'],
  ['rune.summary.change', 'Change a value'],
  ['rune.summary.cancel', 'Cancel'],
  ['rune.progress.step', 'Step {index} of {total}: {title}'],
  ['rune.result.succeeded', 'Setup completed successfully.'],
  ['rune.result.failed', 'Setup failed.'],
  ['rune.result.cancelled', 'Setup was cancelled.'],
  ['rune.result.planned', 'Dry run: nothing was executed.'],
  ['rune.result.nothingExecuted', 'No step needed to run.'],
]);

/**
 * Fills `{name}` placeholders in a chrome string. Single pass over the template, and a
 * substituted value is never re-scanned — the same discipline as `${...}` interpolation.
 */
export function formatChrome(
  template: string,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(values, name)) {
      return match;
    }
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
