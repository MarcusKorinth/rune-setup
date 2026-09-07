const { contextBridge } = require('electron');

const pendingSetValues = [];
let currentValue = 'GOOD';
let editRejection;

function input() {
  return {
    id: 'code',
    enabled: true,
    source: 'default',
    value: currentValue,
    spec: {
      type: 'text',
      required: true,
      pattern: '[A-Z]+',
      patternHint: 'Use uppercase letters',
    },
    ...(editRejection === undefined ? {} : { editRejection }),
  };
}

contextBridge.exposeInMainWorld('rune', {
  open: async () => ({
    runeVersion: 'test',
    inputTypes: ['text'],
    product: { name: 'Input race test', version: '1.0.0' },
  }),
  pendingInputs: async () => [],
  allInputs: async () => [input()],
  setValue: (id, raw) =>
    new Promise((resolve, reject) => {
      pendingSetValues.push({ id, raw, resolve, reject });
    }),
  plan: async () => ({
    manifestPath: '/test/installer.yaml',
    platform: 'windows',
    preview: false,
    failFast: true,
    steps: [],
  }),
  execute: () => new Promise(() => {}),
  cancel: async () => undefined,
  getStrings: async () => ({
    locale: null,
    entries: {
      'inputs.code.title': 'Code',
      'inputs.code.patternHint': 'Use uppercase letters',
      'rune.page.welcome.title': 'Welcome',
      'rune.page.summary.title': 'Summary',
      'rune.button.back': 'Back',
      'rune.button.cancel': 'Cancel',
      'rune.button.next': 'Next',
      'rune.button.install': 'Install',
    },
    displayProduct: {
      name: 'Input race test',
      version: '1.0.0',
      welcome: 'Input race test 1.0.0',
    },
  }),
  getThemeConfig: async () => ({}),
  warnings: async () => [],
  done: async () => undefined,
  onEvent: () => undefined,
});

contextBridge.exposeInMainWorld('inputRaceTestControl', {
  submissionCount: () => pendingSetValues.length,
  rejectSubmission: (index) => {
    const submission = pendingSetValues[index];
    if (submission === undefined) {
      throw new Error(`no pending submission at index ${index}`);
    }
    editRejection = {
      ...(typeof submission.raw === 'string' ? { candidate: submission.raw } : {}),
      displayText: 'Use uppercase letters',
    };
    submission.reject(new Error('Use uppercase letters'));
  },
  resolveSubmission: (index) => {
    const submission = pendingSetValues[index];
    if (submission === undefined) {
      throw new Error(`no pending submission at index ${index}`);
    }
    currentValue = submission.raw;
    editRejection = undefined;
    submission.resolve([]);
  },
});
