const { join } = require('node:path');

const { app } = require('electron');

const shellDirectory = join(__dirname, '..', '..', '..');
const launcherIndex = process.argv.indexOf(__dirname);
const shellArgv = process.argv.slice(launcherIndex + 1);
const userData = process.env.RUNE_TEST_USER_DATA;

if (launcherIndex === -1 || userData === undefined) {
  throw new Error('the CLI shell smoke fixture needs its launch arguments');
}
if (shellArgv[0] !== '--rune-version-probe' && shellArgv[0] !== '--') {
  throw new Error('the CLI shell smoke fixture needs the literal manifest marker');
}

app.commandLine.appendSwitch('remote-debugging-port', '0');
app.setPath('userData', userData);
app.setAppPath(shellDirectory);
process.argv = [process.execPath, shellDirectory, ...shellArgv];
void import('../../../dist/main/index.js');
