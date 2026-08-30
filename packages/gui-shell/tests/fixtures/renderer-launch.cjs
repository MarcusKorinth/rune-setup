const { join } = require('node:path');

const { app, BrowserWindow } = require('electron');

const packageDirectory = join(__dirname, '..', '..');

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'renderer-preload.cjs'),
    },
  });
  await window.loadFile(join(packageDirectory, 'src', 'renderer', 'index.html'));
  window.show();
});

app.on('window-all-closed', () => app.quit());
