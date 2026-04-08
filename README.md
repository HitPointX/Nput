<div align="center">

# Nput

**A clean-room input overlay for streaming and content creation.**

![Version](https://img.shields.io/badge/version-v0.1.0-blueviolet?style=flat-square)
![Backend](https://img.shields.io/badge/backend-Rust-f74c00?style=flat-square)
![Frontend](https://img.shields.io/badge/frontend-Electron%2028-47848f?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-555555?style=flat-square)
![Status](https://img.shields.io/badge/status-active%20development-f59e0b?style=flat-square)

</div>

---

Nput is a standalone input overlay built for streamers and content creators. It displays live keyboard and controller input on a transparent, always-on-top window that can be captured directly in OBS or any other streaming tool.

The backend is written in Rust and handles all input capture and state broadcasting. The frontend is an Electron app that renders the overlay on a frameless transparent canvas. A second browser-source renderer is served over HTTP for direct OBS integration without window capture.

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Input Capture](#input-capture)
- [OBS Browser Source](#obs-browser-source)
- [Layout System](#layout-system)
- [Layout Editor](#layout-editor)
- [Building](#building)
- [Roadmap](#roadmap)
- [Contributor](#contributor)

---

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

---

## Features

| Feature | Status |
|---|:---:|
| Keyboard overlay - full layout with highlight + fade | ✅ |
| Controller overlay - buttons, triggers, analog sticks | ✅ |
| Always-on-top transparent frameless window | ✅ |
| Dark mode and light mode | ✅ |
| Lock mode - click-through overlay, header hidden | ✅ |
| Global unlock shortcut (`Ctrl+Alt+O`) | ✅ |
| Input counter (total inputs across session) | ✅ |
| OBS Browser Source renderer over HTTP | ✅ |
| Multiple controller layout support | ✅ |
| Right-click context menu | ✅ |
| Minimize and quit window controls | ✅ |
| WebSocket state stream | ✅ |
| Linux AppImage distribution | ✅ |
| Windows NSIS installer distribution | ✅ |

---

## Architecture

Nput is split into two processes that communicate over a local WebSocket.

```
┌─────────────────────────────────┐     ws://127.0.0.1:8765
│  Rust Backend                   │ ─────────────────────────► Electron renderer
│                                 │
│  - evdev keyboard capture       │     http://127.0.0.1:8766
│  - gilrs controller polling     │ ─────────────────────────► OBS Browser Source
│  - WebSocket broadcast server   │
│  - HTTP file server             │
│  - State serialisation          │
└─────────────────────────────────┘
```

### Backend (`backend/`)

- Written in Rust with Tokio async runtime
- Three concurrent services: WebSocket server, HTTP server, input event loop
- Keyboard input via evdev on Linux (reads `/dev/input/event*` directly, works under exclusive X11 grabs), with rdev fallback
- Controller input via gilrs at ~120 Hz polling
- Axis changes rate-limited to ~60 fps to avoid flooding the frontend
- State serialised to JSON and broadcast to all connected WebSocket clients on every change

### Frontend (`frontend/`)

- Electron 28 with TypeScript
- Frameless transparent window, always on top, visible on all workspaces including fullscreen
- Canvas-based renderer with per-key and per-button fade animation
- Preload bridge exposes a minimal IPC surface via `contextBridge`
- `web-renderer.ts` is a second standalone renderer compiled separately for the OBS path - no Electron APIs, URL-param driven

### Shared

- `config/layout.json` is the single source of truth for all button positions, image assets, and trigger thresholds
- `data/state.json` persists session data between runs

---

## Input Capture

### Keyboard

On Linux, Nput uses evdev to read directly from `/dev/input/event*` kernel devices. This bypasses X11 entirely, which means keys register correctly even when a game holds an exclusive X11 keyboard grab (which defeats X11 XRecord-based tools).

**Required setup:**

```bash
sudo usermod -aG input $USER
# Log out and back in for the group change to take effect
```

Without this, the evdev path is skipped and Nput falls back to rdev/XRecord, which will miss keys when games are focused.

### Controller

Controller input uses the gilrs crate with XInput-compatible polling. Face buttons, bumpers, triggers (analog), and both analog sticks are captured. Trigger values are analog (0.0 to 1.0) and rendered as fill bars with configurable thresholds.

---

## OBS Browser Source

The Rust HTTP server serves a standalone web renderer at `http://127.0.0.1:8766`. Add this as a Browser Source in OBS for a zero-capture-card overlay that connects directly to the backend WebSocket.

**URL parameters:**

| Parameter | Effect |
|---|---|
| `?mode=keyboard` | Start in keyboard mode |
| `?mode=controller` | Start in controller mode |
| `?dark=1` | Enable dark mode |
| `?obs=1` | Hide the control bar (clean stream layout) |
| `?ws=URL` | Override the WebSocket URL |

**Recommended OBS setup:**

```
URL:    http://127.0.0.1:8766?mode=controller&obs=1
Width:  479
Height: 310
```

---

## Layout System

All overlay positions are defined in `config/layout.json`. The file has three top-level sections: `keyboard`, `controller`, and `controller2`.

Each section declares the asset filename, image dimensions, and a map of named positions. Key and button positions are pixel centers on the base image.

```json
"A": { "x": 354, "y": 139, "r": 18 }
"Enter": { "x": 651, "y": 229, "w": 103, "h": 50 }
```

Controller sections also include `triggers` and `sticks` blocks for analog rendering.

Positions are re-read from disk on every launch - no rebuild required to tune layout values.

---

## Layout Editor

`tools/layout-editor.html` is a standalone browser tool for creating and adjusting layouts visually. Open it directly in any browser - no server required.

### Draw mode

Select a key name, choose Rectangle, Circle, or Point, then click and drag on the loaded image. Drawing a small area places a point marker. Existing entries are updated in place if the same name is drawn again.

### Move mode

Switch to Move mode (button or `M` key) to drag existing entries to new positions. Hover highlights in orange. Positions snap to integer pixels on release.

### Workflow

1. Load the controller or keyboard image with the file picker or drag-and-drop
2. Load an existing `layout.json` to see current positions
3. Adjust positions in Move mode or draw new ones in Draw mode
4. Export JSON and merge the `buttons` / `keys` block back into `layout.json`

**Keyboard shortcuts:**

| Key | Action |
|---|---|
| `D` | Draw mode |
| `M` | Move mode |
| `Del` / `Backspace` | Delete selected entry |
| `Escape` | Deselect / cancel drag |

---

## Building

### Prerequisites

- Rust (stable, 1.75+)
- Node.js 18+
- `x86_64-w64-mingw32-gcc` for Windows cross-compilation (Linux only)

### Dev mode

```bash
# Build backend
cd backend && cargo build --release

# Run frontend
cd frontend && npm install && npm run start
```

### Distribution builds

```bash
# Linux AppImage only
./build.sh --package

# Windows NSIS installer only (cross-compiled from Linux)
./build.sh --package-win

# Both targets
./build.sh --package --package-win
```

Output lands in `dist-app/`:

| File | Platform |
|---|---|
| `Nput-0.1.0.AppImage` | Linux x64 |
| `Nput Setup 0.1.0.exe` | Windows x64 |

### Linux - evdev group

```bash
sudo usermod -aG input $USER
```

Log out and back in. Required for global keyboard capture outside of focused windows.

### Windows

The Windows backend is cross-compiled from Linux using `x86_64-pc-windows-gnu`. The linker and ar tool are configured in `backend/.cargo/config.toml`.

---

## Roadmap

### Near-term

| # | Work Item |
|:---:|---|
| 1 | Keyboard layout editor export back to layout.json without manual merge |
| 2 | Layout selector in the UI for keyboard variants |
| 3 | macOS build and evdev equivalent (IOKit / CGEvent) |
| 4 | Configurable highlight colors per mode |

### Mid-term

| # | Work Item |
|:---:|---|
| 1 | Mouse overlay support |
| 2 | Inputs-per-minute (IPM) counter display |
| 3 | Per-key press count heatmap mode |
| 4 | Customisable fade duration and highlight opacity |

---

## Contributor

Nput is currently a solo project.

- **HitPointX**

## License

See [LICENSE](LICENSE).
