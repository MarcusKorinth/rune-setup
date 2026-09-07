const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const { app, dialog } = require('electron');

const packageDirectory = join(__dirname, '..', '..');
const launcherPath = join(__dirname, 'launch.cjs');
const launcherIndex = process.argv.indexOf(__filename);
const shellArgv = process.argv.slice(launcherIndex + 1);
const dialogCapturePath = process.env['RUNE_DIALOG_CAPTURE'];

if (launcherIndex === -1 || shellArgv.length === 0) {
  throw new Error('the lifecycle launcher needs a manifest path');
}

if (dialogCapturePath !== undefined) {
  dialog.showErrorBox = (title, content) => {
    writeFileSync(dialogCapturePath, JSON.stringify({ title, content }), 'utf8');
  };
}

// Reuse the production-equivalent launcher after replacing only the native fatal dialog.
app.setAppPath(packageDirectory);
process.argv = [process.execPath, packageDirectory, launcherPath, ...shellArgv];
require(launcherPath);
