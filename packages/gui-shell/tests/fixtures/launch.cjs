const { join } = require('node:path');

const { app } = require('electron');

const packageDirectory = join(__dirname, '..', '..');
const manifestPath = process.argv.at(-1);

if (manifestPath === undefined) {
  throw new Error('the smoke launcher needs a manifest path');
}

// Playwright adds its own Electron switches before the application path. Normalize the
// application argv before importing the real built main entry so the shell sees exactly
// the invocation it receives in production.
app.setAppPath(packageDirectory);
process.argv = [process.execPath, packageDirectory, manifestPath];
void import('../../dist/main/index.js');
