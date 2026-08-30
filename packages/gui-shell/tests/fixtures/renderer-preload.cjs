const { contextBridge } = require('electron');

const pendingPlans = [];

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
  execute: async () => {
    throw new Error('execute is not available in the renderer fixture');
  },
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
  onEvent: () => undefined,
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
});
