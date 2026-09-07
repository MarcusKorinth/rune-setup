/**
 * Renderer of the RUNE GUI shell (docs/architecture.md §9.3, §9.4): a pure renderer.
 *
 * Pages — Welcome, auto-chunked input pages, Summary, Progress, Result — are generated
 * from what the bridge returns; nothing here validates, plans, or executes. Engine
 * validation via `rune.setValue` is the only authority: a rejected value marks the field
 * and keeps Next disabled, and the enabled/disabled flips come back from the same call.
 */

import type {
  BridgeEvent,
  BridgeInput,
  BridgePlan,
  BridgeResult,
  BridgeStrings,
  BridgeWarning,
  RuneBridge,
} from '../preload/types.js';

declare global {
  interface Window {
    readonly rune: RuneBridge;
  }
}

const INPUTS_PER_PAGE = 5;
const LIVE_LOG_MAX_CHARACTERS = 20_000;
const LIVE_LOG_PENDING_MAX_CHARACTERS = LIVE_LOG_MAX_CHARACTERS * 2;

interface FieldIds {
  readonly control: string;
  readonly label: string;
  readonly description: string;
  readonly error: string;
}

/** The renderer's field registry — asserted against the manifest's types at open (§9.3). */
const RENDERABLE_TYPES = new Set([
  'text',
  'secret',
  'boolean',
  'select',
  'multiselect',
  'file',
  'directory',
]);

type PageName = 'welcome' | 'inputs' | 'summary' | 'progress' | 'result';

interface State {
  strings: Readonly<Record<string, string>>;
  inputs: readonly BridgeInput[];
  /** Ids the engine still needs, combined with projected rejection state for completeness. */
  pending: ReadonlySet<string>;
  planFailed: boolean;
  pageIndex: number;
  inputPages: number;
  page: PageName;
  result: BridgeResult | undefined;
  warnings: readonly BridgeWarning[];
  banner: string | undefined;
  displayProduct: BridgeStrings['displayProduct'];
}

const state: State = {
  strings: {},
  inputs: [],
  pending: new Set(),
  planFailed: false,
  pageIndex: 0,
  inputPages: 0,
  page: 'welcome',
  result: undefined,
  warnings: [],
  banner: undefined,
  displayProduct: { name: '', version: '', welcome: '' },
};

/** Advances on every page render so an async summary can only update its own page. */
let renderVersion = 0;
/** Keeps forward navigation closed until every in-flight engine submission has settled. */
let pendingInputSubmissions = 0;
/** Remembers a forward click whose blur-triggered validation is still in flight. */
let forwardRequested = false;
/** Keeps Summary navigation closed while Back refreshes plan-masked renderer state. */
let summaryBackPending = false;
/** Latches the renderer closed to navigation as soon as Cancel is accepted locally. */
let closing = false;

const el = {
  page: document.getElementById('page') as HTMLElement,
  back: document.getElementById('back') as HTMLButtonElement,
  next: document.getElementById('next') as HTMLButtonElement,
  cancel: document.getElementById('cancel') as HTMLButtonElement,
  logo: document.getElementById('logo') as HTMLImageElement,
  productName: document.getElementById('product-name') as HTMLElement,
  productVersion: document.getElementById('product-version') as HTMLElement,
};

function text(key: string): string {
  return state.strings[key] ?? '';
}

function applyStrings(strings: BridgeStrings): void {
  state.strings = strings.entries;
  state.displayProduct = strings.displayProduct;
  document.documentElement.lang = strings.locale ?? 'en';
  el.productName.textContent = strings.displayProduct.name;
  el.productVersion.textContent = strings.displayProduct.version;
}

async function boot(): Promise<void> {
  const opened = await window.rune.open();
  const unknown = opened.inputTypes.filter((type) => !RENDERABLE_TYPES.has(type));
  if (unknown.length > 0) {
    // Fail fast with a named error — no silent fallback (§9.3).
    el.page.textContent = `this shell cannot render input type(s): ${unknown.join(', ')}`;
    return;
  }

  applyStrings(await window.rune.getStrings());
  await refreshInputs();
  state.inputPages = Math.ceil(state.inputs.length / INPUTS_PER_PAGE);

  const theme = await window.rune.getThemeConfig();
  if (theme.accentColor !== undefined) {
    // A rule, not an inline style: the author stylesheet loads after it and stays the
    // last word of the theming cascade (§9.4 layer 3).
    const accent = document.createElement('style');
    accent.textContent = `:root { --rune-accent: ${theme.accentColor}; }`;
    document.head.append(accent);
  }
  if (theme.logo !== undefined) {
    el.logo.src = theme.logo;
    el.logo.hidden = false;
  }
  state.banner = theme.banner;
  if (theme.theme !== undefined) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = theme.theme;
    document.head.append(link);
  }
  if (theme.windowTitle !== undefined) {
    document.title = theme.windowTitle;
  }

  el.back.addEventListener('click', () => {
    void navigate(-1);
  });
  el.next.addEventListener('click', () => {
    void navigate(1);
  });
  el.next.addEventListener('pointerdown', () => {
    if (state.page === 'inputs') {
      forwardRequested = true;
    }
  });
  el.cancel.addEventListener('click', () => {
    if (closing) {
      return;
    }
    closing = true;
    forwardRequested = false;
    renderFooter();
    void window.rune.cancel();
  });

  window.rune.onEvent(onRunEvent);
  render(true);
}

async function navigate(direction: 1 | -1): Promise<void> {
  if (closing) {
    return;
  }
  if (direction === -1) {
    forwardRequested = false;
  }
  if (state.page === 'inputs' && direction === 1) {
    if (pendingInputSubmissions > 0) {
      forwardRequested = true;
      renderFooter();
      return;
    }
    forwardRequested = false;
    if (!currentPageComplete()) {
      renderFooter();
      return;
    }
  }
  if (state.page === 'welcome' && direction === 1) {
    state.page = state.inputs.length > 0 ? 'inputs' : 'summary';
    state.pageIndex = 0;
  } else if (state.page === 'inputs') {
    const nextIndex = state.pageIndex + direction;
    if (nextIndex < 0) {
      state.page = 'welcome';
    } else if (nextIndex >= state.inputPages) {
      state.page = 'summary';
    } else {
      state.pageIndex = nextIndex;
    }
  } else if (state.page === 'summary') {
    if (summaryBackPending) {
      return;
    }
    if (direction === -1) {
      summaryBackPending = true;
      renderFooter();
      try {
        await refreshStringsAndWindowTitle();
        await refreshInputs();
        state.page = state.inputs.length > 0 ? 'inputs' : 'welcome';
        state.pageIndex = Math.max(0, state.inputPages - 1);
      } finally {
        summaryBackPending = false;
        renderFooter();
      }
    } else {
      state.page = 'progress';
      render(true);
      const result = await window.rune.execute();
      state.warnings = await window.rune.warnings();
      state.result = result;
      state.page = 'result';
      render(true);
      return;
    }
  } else if (state.page === 'result') {
    await window.rune.done();
    return;
  }
  render(true);
}

function render(focusPage = false): void {
  const focusedInputControlId =
    state.page === 'inputs' &&
    !closing &&
    document.activeElement instanceof HTMLElement &&
    el.page.contains(document.activeElement)
      ? document.activeElement.id
      : undefined;
  const version = ++renderVersion;
  el.page.classList.remove('page');
  void el.page.offsetWidth; // restart the page-in animation
  el.page.classList.add('page');
  el.page.replaceChildren();

  switch (state.page) {
    case 'welcome':
      renderWelcome();
      break;
    case 'inputs':
      renderInputs();
      break;
    case 'summary':
      // A summary cannot proceed until the engine has produced the current plan.
      state.planFailed = true;
      void renderSummary(version);
      break;
    case 'progress':
      renderProgress();
      break;
    case 'result':
      renderResult();
      break;
  }
  renderFooter();
  if (focusedInputControlId !== undefined && state.page === 'inputs') {
    const control = document.getElementById(focusedInputControlId);
    if (
      control instanceof HTMLElement &&
      el.page.contains(control) &&
      !control.matches(':disabled')
    ) {
      control.focus();
    }
  }
  if (focusPage && !closing) {
    const heading = el.page.querySelector('h2');
    const target = heading instanceof HTMLElement ? heading : el.page;
    target.tabIndex = -1;
    target.focus();
  }
}

function renderFooter(): void {
  el.back.hidden = state.page === 'welcome' || state.page === 'progress' || state.page === 'result';
  el.back.disabled = summaryBackPending;
  el.back.textContent = text('rune.button.back');
  el.cancel.textContent = text('rune.button.cancel');
  el.cancel.hidden = state.page === 'result';

  if (state.page === 'result') {
    el.next.textContent = text('rune.button.finish');
    el.next.disabled = false;
  } else if (state.page === 'summary') {
    el.next.textContent = text('rune.button.install');
    el.next.disabled = state.planFailed || summaryBackPending;
  } else if (state.page === 'progress') {
    el.next.textContent = text('rune.button.install');
    el.next.disabled = true;
  } else {
    el.next.textContent = text('rune.button.next');
    el.next.disabled = !currentPageComplete();
  }
  if (closing) {
    el.back.disabled = true;
    el.next.disabled = true;
    el.cancel.disabled = true;
  }
}

function currentPageComplete(): boolean {
  if (state.page !== 'inputs') {
    return true;
  }
  if (pendingInputSubmissions > 0) {
    return false;
  }
  // Engine pending state and main's current rejected-edit projection together determine
  // completeness; a rejected transaction leaves the authoritative engine value unchanged.
  return pageInputs().every(
    (input) =>
      !input.enabled ||
      (input.editRejection === undefined &&
        input.rejection === undefined &&
        !state.pending.has(input.id)),
  );
}

function pageInputs(): readonly BridgeInput[] {
  const start = state.pageIndex * INPUTS_PER_PAGE;
  return state.inputs.slice(start, start + INPUTS_PER_PAGE);
}

function renderWelcome(): void {
  const container = div('welcome');
  if (state.banner !== undefined) {
    const banner = document.createElement('img');
    banner.className = 'banner';
    banner.src = state.banner;
    banner.alt = '';
    container.append(banner);
  }
  const heading = document.createElement('h2');
  heading.textContent = text('rune.page.welcome.title');
  const description = document.createElement('p');
  description.textContent = state.displayProduct.welcome;
  container.append(heading, description);
  el.page.append(container);
}

function renderInputs(): void {
  for (const input of pageInputs()) {
    el.page.append(renderField(input));
  }
}

function renderField(input: BridgeInput): HTMLElement {
  const field = div('field');
  field.dataset['id'] = input.id;
  const problem = inputProblem(input);
  if (!input.enabled) {
    field.classList.add('disabled');
  }
  if (problem !== undefined) {
    field.classList.add('invalid');
  }

  const ids = fieldIds(input.id);
  const description = text(`inputs.${input.id}.description`);
  const describedBy = [
    description === '' ? undefined : ids.description,
    problem === undefined ? undefined : ids.error,
  ]
    .filter((id): id is string => id !== undefined)
    .join(' ');

  const label = document.createElement('label');
  label.id = ids.label;
  if (input.spec.type !== 'multiselect') {
    label.htmlFor = ids.control;
  }
  label.textContent = text(`inputs.${input.id}.title`);
  field.append(label);

  if (description !== '') {
    const paragraph = document.createElement('p');
    paragraph.id = ids.description;
    paragraph.className = 'description';
    paragraph.textContent = description;
    field.append(paragraph);
  }

  const control = renderControl(input);
  configureControl(control, ids.control, describedBy, problem !== undefined);
  if (input.spec.type === 'multiselect') {
    control.setAttribute('role', 'group');
    control.setAttribute('aria-labelledby', ids.label);
  }
  field.append(control);

  if (problem !== undefined) {
    const error = document.createElement('p');
    error.id = ids.error;
    error.className = 'error';
    error.textContent = problem;
    field.append(error);
  }
  return field;
}

function inputProblem(input: BridgeInput): string | undefined {
  if (!input.enabled) {
    return undefined;
  }
  if (input.editRejection !== undefined) {
    return input.editRejection.displayText;
  }
  if (input.rejection === undefined) {
    return undefined;
  }
  return input.rejection.issue.message;
}

function fieldIds(inputId: string): FieldIds {
  const base = `rune-input-${encodeURIComponent(inputId)}`;
  return {
    control: `${base}-control`,
    label: `${base}-label`,
    description: `${base}-description`,
    error: `${base}-error`,
  };
}

function configureControl(
  control: HTMLElement,
  id: string,
  describedBy: string,
  invalid: boolean,
): void {
  control.id = id;
  if (describedBy !== '') {
    control.setAttribute('aria-describedby', describedBy);
  }
  if (invalid) {
    control.setAttribute('aria-invalid', 'true');
  }
}

function renderControl(input: BridgeInput): HTMLElement {
  const { spec } = input;
  if (spec.type === 'boolean') {
    return booleanSelect(input);
  }
  if (spec.type === 'select') {
    return selectBox(input);
  }
  if (spec.type === 'multiselect') {
    return multiselect(input);
  }
  const box = document.createElement('input');
  box.type = spec.type === 'secret' ? 'password' : 'text';
  const rejected = input.editRejection?.candidate ?? input.rejection?.candidate;
  box.value =
    spec.type === 'secret'
      ? ''
      : typeof rejected === 'string'
        ? rejected
        : typeof input.value === 'string'
          ? input.value
          : '';
  box.disabled = !input.enabled;
  box.addEventListener('change', () => {
    void submit(input.id, box.value);
  });
  return box;
}

function booleanSelect(input: BridgeInput): HTMLElement {
  const select = document.createElement('select');
  select.disabled = !input.enabled;
  if (input.value === undefined) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = text('rune.summary.notSet');
    select.append(placeholder);
  }
  for (const value of [true, false]) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(value);
    option.selected = input.value === value;
    select.append(option);
  }
  select.addEventListener('change', () => {
    void submit(input.id, select.value === 'true');
  });
  return select;
}

function selectBox(input: BridgeInput): HTMLElement {
  const select = document.createElement('select');
  select.disabled = !input.enabled;
  const options = input.spec.options ?? [];
  const hasSelectedOption = options.some((value) => input.value === value);
  // When the engine value is not an option, keep the first option from looking chosen.
  if (!hasSelectedOption) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.hidden = true;
    select.append(placeholder);
  }
  for (const value of options) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = text(`inputs.${input.id}.options.${value}.label`);
    if (input.value === value) {
      item.selected = true;
    }
    select.append(item);
  }
  select.addEventListener('change', () => {
    void submit(input.id, select.value);
  });
  return select;
}

function multiselect(input: BridgeInput): HTMLElement {
  const container = document.createElement('div');
  const controlId = fieldIds(input.id).control;
  const chosen = new Set(Array.isArray(input.value) ? input.value : []);
  for (const [index, value] of (input.spec.options ?? []).entries()) {
    const row = div('option-row');
    const box = document.createElement('input');
    box.id = `${controlId}-option-${index}`;
    box.type = 'checkbox';
    box.checked = chosen.has(value);
    box.disabled = !input.enabled;
    box.addEventListener('change', () => {
      if (box.checked) {
        chosen.add(value);
      } else {
        chosen.delete(value);
      }
      void submit(input.id, [...chosen]);
    });
    const label = document.createElement('label');
    label.htmlFor = box.id;
    label.textContent = text(`inputs.${input.id}.options.${value}.label`);
    row.append(box, label);
    container.append(row);
  }
  return container;
}

/** One authority: the engine's setValue. Rejection marks the field; flips re-render. */
async function submit(id: string, raw: unknown): Promise<void> {
  pendingInputSubmissions += 1;
  renderFooter();
  try {
    let accepted = false;
    try {
      await window.rune.setValue(id, raw);
      accepted = true;
    } catch {
      // Main publishes the recoverable failure through the refreshed input projection.
    }
    if (accepted) {
      await refreshStringsAndWindowTitle();
    }
    await refreshInputs();
  } finally {
    pendingInputSubmissions -= 1;
    render();
    if (
      pendingInputSubmissions === 0 &&
      forwardRequested &&
      state.page === 'inputs' &&
      currentPageComplete()
    ) {
      forwardRequested = false;
      await navigate(1);
    }
  }
}

async function refreshStringsAndWindowTitle(): Promise<void> {
  applyStrings(await window.rune.getStrings());
  const theme = await window.rune.getThemeConfig();
  if (theme.windowTitle !== undefined) {
    document.title = theme.windowTitle;
  }
}

async function refreshInputs(): Promise<void> {
  state.inputs = await window.rune.allInputs();
  state.pending = new Set((await window.rune.pendingInputs()).map((input) => input.id));
}

function messageOf(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'kind' in error &&
    error.kind === 'rune-error' &&
    'displayText' in error &&
    typeof error.displayText === 'string'
    ? error.displayText
    : 'RUNE-500 (exit 70): An unexpected shell error occurred.';
}

function isCurrentSummary(version: number): boolean {
  return state.page === 'summary' && renderVersion === version && !summaryBackPending && !closing;
}

async function renderSummary(version: number): Promise<void> {
  if (!isCurrentSummary(version)) {
    return;
  }
  const heading = document.createElement('h2');
  heading.textContent = text('rune.page.summary.title');
  heading.className = 'result-heading';
  el.page.append(heading);

  let plan: BridgePlan;
  try {
    plan = await window.rune.plan();
  } catch (error) {
    if (!isCurrentSummary(version)) {
      return;
    }
    const problem = document.createElement('p');
    problem.className = 'error';
    problem.textContent = messageOf(error);
    el.page.append(problem);
    renderFooter();
    return;
  }
  if (!isCurrentSummary(version)) {
    return;
  }
  await refreshStringsAndWindowTitle();
  await refreshInputs();
  if (!isCurrentSummary(version)) {
    return;
  }
  heading.textContent = text('rune.page.summary.title');
  state.planFailed = false;
  renderFooter();
  for (const step of plan.steps) {
    const row = div('summary-step');
    if (step.state === 'SKIPPED') {
      row.classList.add('skipped');
    }
    const title = document.createElement('strong');
    title.textContent = step.title;
    row.append(title);
    const detail = document.createElement('div');
    detail.className = 'command';
    detail.textContent = step.state === 'SKIPPED' ? step.skipReason : step.displayCommand;
    row.append(detail);
    el.page.append(row);
  }
}

let progress: { bar: HTMLProgressElement; title: HTMLElement; log: HTMLElement } | undefined;
let liveLog = '';
let pendingLiveLog: string[] = [];
let pendingLiveLogStart = 0;
let pendingLiveLogCharacters = 0;
let liveLogFrame: number | undefined;
let progressRenderVersion = 0;

function renderProgress(): void {
  const heading = document.createElement('h2');
  heading.id = 'rune-page-progress-title';
  heading.className = 'result-heading';
  heading.textContent = text('rune.page.progress.title');
  const bar = document.createElement('progress');
  bar.className = 'progress-track';
  bar.max = 1;
  bar.value = 0;
  bar.setAttribute('aria-labelledby', heading.id);
  const title = div('progress-title');
  title.setAttribute('role', 'status');
  const log = div('log');
  el.page.append(heading, bar, title, log);
  progress = { bar, title, log };
  progressRenderVersion += 1;
  liveLog = '';
  pendingLiveLog = [];
  pendingLiveLogStart = 0;
  pendingLiveLogCharacters = 0;
  if (liveLogFrame !== undefined) {
    cancelAnimationFrame(liveLogFrame);
    liveLogFrame = undefined;
  }
}

function appendLiveLog(line: string): void {
  if (progress === undefined) {
    return;
  }

  const entry = `${line}\n`;
  pendingLiveLog.push(entry);
  pendingLiveLogCharacters += entry.length;
  while (
    pendingLiveLogCharacters > LIVE_LOG_PENDING_MAX_CHARACTERS &&
    pendingLiveLogStart < pendingLiveLog.length - 1
  ) {
    pendingLiveLogCharacters -= pendingLiveLog[pendingLiveLogStart]?.length ?? 0;
    pendingLiveLogStart += 1;
  }
  if (pendingLiveLogCharacters > LIVE_LOG_PENDING_MAX_CHARACTERS) {
    const first = pendingLiveLog[pendingLiveLogStart];
    if (first !== undefined) {
      const omittedCharacters = pendingLiveLogCharacters - LIVE_LOG_PENDING_MAX_CHARACTERS;
      pendingLiveLog[pendingLiveLogStart] = first.slice(omittedCharacters);
      pendingLiveLogCharacters -= omittedCharacters;
    }
  }
  if (pendingLiveLogStart > 128 && pendingLiveLogStart * 2 > pendingLiveLog.length) {
    pendingLiveLog = pendingLiveLog.slice(pendingLiveLogStart);
    pendingLiveLogStart = 0;
  }

  if (liveLogFrame !== undefined) {
    return;
  }

  const renderVersion = progressRenderVersion;
  liveLogFrame = requestAnimationFrame(() => {
    liveLogFrame = undefined;
    if (renderVersion !== progressRenderVersion || progress === undefined) {
      return;
    }

    liveLog = `${liveLog}${pendingLiveLog.slice(pendingLiveLogStart).join('')}`.slice(
      -LIVE_LOG_MAX_CHARACTERS,
    );
    pendingLiveLog = [];
    pendingLiveLogStart = 0;
    pendingLiveLogCharacters = 0;
    progress.log.textContent = liveLog;
    progress.log.scrollTop = progress.log.scrollHeight;
  });
}

function onRunEvent(event: BridgeEvent): void {
  if (progress === undefined) {
    return;
  }
  if (event.kind === 'runStarted') {
    progress.title.textContent = event.displayText;
  }
  if (event.kind === 'stepStarted') {
    progress.title.textContent = event.displayText;
    const fraction = event.total > 0 ? event.index / event.total : 0;
    progress.bar.value = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
  }
  if (event.kind === 'stepOutput') {
    appendLiveLog(event.displayText);
  }
  if (event.kind === 'stepFinished') {
    appendLiveLog(event.displayText);
  }
  if (event.kind === 'runFinished') {
    progress.bar.value = progress.bar.max;
  }
}

function renderResult(): void {
  const result = state.result;
  if (result === undefined) {
    return;
  }
  const ok = result.status === 'succeeded';
  const badge = div(`result-badge ${ok ? 'ok' : 'bad'}`);
  badge.textContent = ok ? '✓' : '✕';
  const heading = document.createElement('h2');
  heading.className = 'result-heading';
  heading.textContent = text(
    result.status === 'cancelled'
      ? 'rune.result.cancelled'
      : ok
        ? 'rune.result.succeeded'
        : 'rune.result.failed',
  );
  const sub = document.createElement('p');
  sub.className = 'result-sub';
  sub.textContent =
    result.nothingExecuted && ok ? text('rune.result.nothingExecuted') : result.displaySummary;
  el.page.append(badge, heading, sub);

  // The §10 warnings: the same run never warns in one mode and stays silent in another.
  for (const warning of state.warnings) {
    const line = document.createElement('p');
    line.className = 'result-sub';
    line.textContent = warning.displayText;
    el.page.append(line);
  }

  for (const step of result.steps) {
    if (step.state !== 'FAILED') {
      continue;
    }
    const row = div('result-step');
    const title = document.createElement('strong');
    title.textContent = step.displayTitle;
    const tail = document.createElement('div');
    tail.className = 'tail';
    tail.textContent = (step.outputTail ?? []).map((entry) => entry.line).join('\n');
    row.append(title, tail);
    el.page.append(row);
  }
}

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

void boot();
