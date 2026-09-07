const { contextBridge } = require('electron');

const pendingPlans = [];
const pendingWarnings = [];
let eventListener;
let doneCount = 0;
let cancelCount = 0;
let executeCount = 0;

function plan(title) {
  return {
    manifestPath: '/test/installer.yaml',
    platform: 'windows',
    preview: false,
    failFast: true,
    steps: [
      {
        id: 'test-step',
        title,
        state: 'PENDING',
        command: {
          argv: ['echo', title],
          cwd: '/test',
          env: {},
          timeoutSeconds: null,
          successExitCodes: [0],
        },
        displayCommand: `echo ${title}`,
      },
    ],
  };
}

function result() {
  return {
    status: 'succeeded',
    exitCode: 0,
    nothingExecuted: false,
    stepsSucceeded: 1,
    stepsFailed: 0,
    stepsCancelled: 0,
    stepsSkipped: 0,
    stepsNotRun: 0,
    stepsTotal: 1,
    steps: [],
    displaySummary: 'succeeded: 1 succeeded, 0 failed, 0 skipped, 0 cancelled, 0 not run (exit 0)',
  };
}

contextBridge.exposeInMainWorld('rune', {
  open: async () => ({
    runeVersion: 'test',
    inputTypes: [],
    product: { name: 'Summary test', version: '1.0.0' },
  }),
  pendingInputs: async () => [],
  allInputs: async () => [],
  setValue: async () => [],
  plan: () =>
    new Promise((resolve) => {
      pendingPlans.push(resolve);
    }),
  execute: async () => {
    executeCount += 1;
    return result();
  },
  cancel: async () => {
    cancelCount += 1;
  },
  getStrings: async () => ({
    locale: null,
    entries: {
      'rune.page.welcome.title': 'Welcome',
      'rune.page.summary.title': 'Summary',
      'rune.page.progress.title': 'Installing',
      'rune.button.back': 'Back',
      'rune.button.cancel': 'Cancel',
      'rune.button.next': 'Next',
      'rune.button.install': 'Install',
      'rune.button.finish': 'Finish',
      'rune.progress.output': '  {line}',
      'rune.progress.stepFinished': '  -> {state} (exit {exitCode}) after {durationMs}ms',
      'rune.progress.stepFinishedWithoutExitCode': '  -> {state} after {durationMs}ms',
      'rune.warning': 'warning: {message}',
      'rune.result.succeeded': 'Setup completed successfully.',
      'rune.result.summary':
        '{status}: {succeeded} succeeded, {failed} failed, {skipped} skipped, ' +
        '{cancelled} cancelled, {notRun} not run (exit {exitCode})',
    },
    displayProduct: {
      name: 'Summary test',
      version: '1.0.0',
      welcome: 'Summary test 1.0.0',
    },
  }),
  getThemeConfig: async () => ({}),
  warnings: () =>
    new Promise((resolve) => {
      pendingWarnings.push(resolve);
    }),
  done: async () => {
    doneCount += 1;
  },
  onEvent: (listener) => {
    eventListener = listener;
  },
});

contextBridge.exposeInMainWorld('summaryTestControl', {
  cancelCount: () => cancelCount,
  executeCount: () => executeCount,
  planCount: () => pendingPlans.length,
  resolvePlan: (index, title) => {
    const resolve = pendingPlans[index];
    if (resolve === undefined) {
      throw new Error(`no pending plan at index ${index}`);
    }
    resolve(plan(title));
  },
  warningCount: () => pendingWarnings.length,
  resolveWarnings: (index, warnings) => {
    const resolve = pendingWarnings[index];
    if (resolve === undefined) {
      throw new Error(`no pending warnings at index ${index}`);
    }
    resolve(warnings);
  },
  doneCount: () => doneCount,
  emitOutput: (line) => {
    eventListener?.({
      kind: 'stepOutput',
      stepId: 'test-step',
      stream: 'stdout',
      line,
      displayText: `  ${line}`,
    });
  },
  emitStepStarted: (index, total) => {
    eventListener?.({
      kind: 'stepStarted',
      stepId: 'test-step',
      index,
      total,
      title: 'test step',
      displayText: `Step ${index + 1} of ${total}: test step`,
    });
  },
  emitFinished: () => {
    eventListener?.({
      kind: 'stepFinished',
      stepId: 'test-step',
      state: 'SUCCEEDED',
      durationMs: 1,
      displayText: '  -> SUCCEEDED after 1ms',
    });
  },
  emitRunFinished: () => {
    eventListener?.({
      kind: 'runFinished',
      result: result(),
    });
  },
});
