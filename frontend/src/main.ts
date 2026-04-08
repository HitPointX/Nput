// ============================================================
// main.ts — Electron main process  (Phase F + packaging)
//
// New in this version:
//   • Spawns the Rust backend binary as a child process so the
//     user only needs to launch one thing.
//   • Sets NPUT_* environment variables so the backend finds
//     assets, config, and the writable data dir in both dev
//     and packaged (AppImage / installer) builds.
//   • Kills the backend cleanly when Electron exits.
//
// Dev layout  (cargo run / npm run start):
//   Binary:  ../../backend/target/release/nput-backend
//   Assets:  ../../assets/
//   Config:  ../../config/
//   Data:    ../../data/          (project root — easy to inspect)
//
// Packaged layout (AppImage / NSIS):
//   Binary:  resources/backend/nput-backend
//   Assets:  resources/assets/
//   Config:  resources/config/
//   Web:     resources/web/
//   Data:    app.getPath('userData')/nput/data/   (writable)
// ============================================================

import {
  app, BrowserWindow, ipcMain, globalShortcut, screen,
} from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

const HEADER_H = 34; // px — must match the CSS header height in index.html

let mainWindow:      BrowserWindow  | null = null;
let backendProcess:  ChildProcess   | null = null;
let isLocked                               = false;

// ── Path resolution ──────────────────────────────────────────

const isDev = !app.isPackaged;

function devRoot(): string {
  // __dirname = frontend/dist/ in both dev and prod.
  // Walk up two levels to reach the project root in dev.
  return path.join(__dirname, '..', '..');
}

function resourcesRoot(): string {
  return process.resourcesPath; // set by Electron for packaged builds
}

const assetsPath = isDev
  ? path.join(devRoot(),       'assets')
  : path.join(resourcesRoot(), 'assets');

const configPath = isDev
  ? path.join(devRoot(),       'config')
  : path.join(resourcesRoot(), 'config');

const webPath = isDev
  ? path.join(devRoot(),       'web')
  : path.join(resourcesRoot(), 'web');

const dataPath = isDev
  ? path.join(devRoot(), 'data')
  : path.join(app.getPath('userData'), 'nput', 'data');

const binaryName = process.platform === 'win32' ? 'nput-backend.exe' : 'nput-backend';

const binaryPath = isDev
  ? path.join(devRoot(), 'backend', 'target',
      process.platform === 'win32'
        ? 'x86_64-pc-windows-gnu/release'
        : 'release',
      binaryName)
  : path.join(resourcesRoot(), 'backend', binaryName);

// Expose paths to the preload via env — preload runs in a Node.js
// context and can read process.env directly.
process.env.NPUT_ASSETS_PATH = assetsPath;
process.env.NPUT_CONFIG_PATH = configPath;
process.env.NPUT_IS_DEV      = isDev ? '1' : '0';

// ── Backend spawning ─────────────────────────────────────────

function startBackend(): void {
  if (backendProcess) return;

  backendProcess = spawn(binaryPath, [], {
    env: {
      ...process.env,
      RUST_LOG:         'info',
      NPUT_DATA_DIR:    dataPath,
      NPUT_ASSETS_DIR:  assetsPath,
      NPUT_CONFIG_DIR:  configPath,
      NPUT_WEB_DIR:     webPath,
    },
    // Run in project root (dev) or resources dir (prod) so relative
    // path fallbacks inside the Rust binary still work.
    cwd: isDev ? devRoot() : resourcesRoot(),
  });

  backendProcess.stdout?.on('data', (d: Buffer) =>
    console.log('[backend]', d.toString().trimEnd()));
  backendProcess.stderr?.on('data', (d: Buffer) =>
    console.error('[backend]', d.toString().trimEnd()));

  backendProcess.on('exit', (code) => {
    console.log(`[backend] exited (code ${code})`);
    backendProcess = null;
  });

  backendProcess.on('error', (err) => {
    console.error('[backend] failed to start:', err.message);
    console.error('  Expected binary at:', binaryPath);
    console.error('  Run `cargo build --release` in backend/ first.');
  });

  console.log('[backend] started:', binaryPath);
}

// ── Window creation ──────────────────────────────────────────

function createWindow(): void {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width:  1078,
    height: 375 + HEADER_H,
    x: Math.round((sw - 1078) / 2),
    y: 60,

    transparent:     true,
    frame:           false,
    hasShadow:       false,
    backgroundColor: '#00000000',
    alwaysOnTop:     true,
    resizable:       true,
    skipTaskbar:     false,

    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Electron 28 sandboxes preload scripts by default, which blocks
      // Node built-ins (path, fs) that the preload needs to read layout.json
      // and resolve asset paths.  contextIsolation is the real security
      // boundary here — sandbox is redundant and actively harmful for us.
      sandbox: false,
    },

    title: 'Nput Overlay',
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open DevTools in dev mode for easy debugging.
  // In packaged builds, F12 still opens them — handy for diagnosing issues.
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC handlers ─────────────────────────────────────────────

ipcMain.handle('nput:resize', (_e, { width, height }: { width: number; height: number }) => {
  if (!mainWindow) return;
  mainWindow.setContentSize(width, isLocked ? height : height + HEADER_H);
});

ipcMain.handle('nput:set-click-through', (_e, lock: boolean) => {
  if (!mainWindow) return;
  isLocked = lock;
  mainWindow.setIgnoreMouseEvents(lock, { forward: true });
});

ipcMain.handle('nput:minimize', () => { mainWindow?.minimize(); });
ipcMain.handle('nput:quit',     () => { app.quit(); });

// ── Global shortcut ──────────────────────────────────────────

function registerShortcuts(): void {
  const ok = globalShortcut.register('CommandOrControl+Alt+O', () => {
    if (!mainWindow) return;

    if (isLocked) {
      isLocked = false;
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.webContents.send('nput:overlay-locked', false);
      if (!mainWindow.isVisible()) mainWindow.show();
      return;
    }

    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  if (!ok) {
    console.warn('[nput] Could not register Ctrl+Alt+O — may already be in use by another app');
  }
}

// ── App lifecycle ────────────────────────────────────────────

app.whenReady().then(() => {
  startBackend();
  // Small delay so the backend's WebSocket is up before the
  // renderer tries to connect — avoids the first "connecting…" flicker.
  setTimeout(() => {
    createWindow();
    registerShortcuts();
  }, 600);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Give the backend a moment to flush state.json before we kill it
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    backendProcess = null;
  }
});
