// ============================================================
// preload.ts — Context bridge between main and renderer
//
// main.ts sets NPUT_ASSETS_PATH and NPUT_CONFIG_PATH in
// process.env before the window is created.  We read them
// here so the renderer gets the right absolute paths whether
// we're running in dev or from a packaged AppImage / installer.
// ============================================================

import { contextBridge, ipcRenderer } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// Prefer the env vars set by main.ts; fall back to relative paths
// for the case where someone runs the renderer outside of Electron.
const assetsPath = process.env.NPUT_ASSETS_PATH
  ?? path.join(__dirname, '..', '..', 'assets');

const configPath = process.env.NPUT_CONFIG_PATH
  ?? path.join(__dirname, '..', '..', 'config');

contextBridge.exposeInMainWorld('nputBridge', {
  version:    '0.1.0',
  wsUrl:      'ws://127.0.0.1:8765',
  assetsPath,

  // Read and parse layout.json — re-reads on every call so
  // tuning positions takes effect without restarting.
  getLayout: (): unknown => {
    const raw = fs.readFileSync(path.join(configPath, 'layout.json'), 'utf8');
    return JSON.parse(raw);
  },

  // Ask main to resize the native window to match the canvas.
  // Main adds HEADER_H automatically when not in locked mode.
  resizeWindow: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke('nput:resize', { width, height }),

  // Enter (true) or exit (false) click-through overlay mode.
  setClickThrough: (lock: boolean): Promise<void> =>
    ipcRenderer.invoke('nput:set-click-through', lock),

  // Called when the global shortcut unlocks the overlay externally.
  onOverlayLocked: (cb: (locked: boolean) => void): void => {
    ipcRenderer.on('nput:overlay-locked', (_e, locked: boolean) => cb(locked));
  },

  minimize: (): Promise<void> => ipcRenderer.invoke('nput:minimize'),
  quit:     (): Promise<void> => ipcRenderer.invoke('nput:quit'),
});
