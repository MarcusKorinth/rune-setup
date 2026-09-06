const { contextBridge } = require('electron');

const pendingPlans = [];
let eventListener;

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
      },
    ],
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
  execute: () => new Promise(() => {}),
  cancel: async () => undefined,
  getStrings: async () => ({
    'rune.page.welcome.title': 'Welcome',
    'rune.page.summary.title': 'Summary',
    'rune.button.back': 'Back',
    'rune.button.cancel': 'Cancel',
    'rune.button.next': 'Next',
    'rune.button.install': 'Install',
  }),
  getThemeConfig: async () => ({}),
  warnings: async () => [],
  done: async () => undefined,
  onEvent: (listener) => {
    eventListener = listener;
  },
});

contextBridge.exposeInMainWorld('summaryTestControl', {
  planCount: () => pendingPlans.length,
  resolvePlan: (index, title) => {
    const resolve = pendingPlans[index];
    if (resolve === undefined) {
      throw new Error(`no pending plan at index ${index}`);
    }
    resolve(plan(title));
  },
  emitOutput: (line) => {
    eventListener?.({
      kind: 'stepOutput',
      stepId: 'test-step',
      stream: 'stdout',
      line,
    });
  },
  emitStepStarted: (index, total) => {
    eventListener?.({
      kind: 'stepStarted',
      stepId: 'test-step',
      index,
      total,
      title: 'test step',
    });
  },
  emitFinished: () => {
    eventListener?.({
      kind: 'stepFinished',
      stepId: 'test-step',
      state: 'SUCCEEDED',
      durationMs: 1,
    });
  },
  emitRunFinished: () => {
    eventListener?.({
      kind: 'runFinished',
      result: {},
    });
  },
});
