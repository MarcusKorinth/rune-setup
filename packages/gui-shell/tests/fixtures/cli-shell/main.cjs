const { join } = require('node:path');
const { existsSync, writeFileSync } = require('node:fs');
const { clearInterval, setInterval } = require('node:timers');

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
const startupGate = process.env.RUNE_TEST_STARTUP_GATE;
if (shellArgv[0] === '--' && startupGate !== undefined) {
  // Hold before the shell installs its signal handler, while the version probe stays fast.
  writeFileSync(`${startupGate}.started`, String(process.pid));
  const poll = setInterval(() => {
    if (!existsSync(`${startupGate}.release`)) return;
    clearInterval(poll);
    void import('../../../dist/main/index.js');
  }, 10);
} else {
  void import('../../../dist/main/index.js');
}
