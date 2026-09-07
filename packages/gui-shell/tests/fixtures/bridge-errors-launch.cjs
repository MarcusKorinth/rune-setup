const { join } = require('node:path');
const { app } = require('electron');

const packageDirectory = join(__dirname, '..', '..');
app.setAppPath(packageDirectory);
process.argv = [process.execPath, packageDirectory, join(__dirname, 'edit-rejection.yaml')];

// Inject a located facade error before startup; production main and preload still own
// serialization, masking, IPC and contextBridge transfer.
void import('../../../engine/dist/index.js').then(({ Session, InputError }) => {
  Session.prototype.warnings = () => {
    throw new InputError('RUNE-202', 'invalid private-token', {
      location: { file: 'private-token/answers.yaml', line: 7, column: 9 },
      cause: new Error('private-token internal cause'),
    });
  };
  return import('../../dist/main/index.js');
});
