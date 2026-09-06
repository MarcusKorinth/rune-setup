const { join } = require('node:path');

const { app } = require('electron');

const packageDirectory = join(__dirname, '..', '..');
const launcherIndex = process.argv.indexOf(__filename);
const shellArgv = process.argv.slice(launcherIndex + 1);

if (launcherIndex === -1 || shellArgv.length === 0) {
  throw new Error('the smoke launcher needs a manifest path');
}

// Playwright adds its own Electron switches before the application path. Normalize the
// application argv before importing the real built main entry so the shell sees exactly
// the invocation it receives in production.
app.setAppPath(packageDirectory);
process.argv = [process.execPath, packageDirectory, ...shellArgv];
void import('../../dist/main/index.js');
