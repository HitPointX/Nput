# Changelog

All notable changes to Nput are documented here.

---

## [0.1.0] - 2026-04-07

Initial release. Full keyboard and controller overlay with Electron frontend, Rust backend, OBS browser source, and distribution builds for Linux and Windows.

---

### Backend

- Rust backend with Tokio async runtime running three concurrent services: WebSocket server on port 8765, HTTP file server on port 8766, and the input event loop
- WebSocket broadcast server streams the full input state to all connected clients on every change
- State serialised to JSON - keys pressed, buttons pressed, trigger values, stick axes, total input counter
- Directory resolution order: env override (set by Electron), CWD, parent directory - works correctly in dev and packaged builds
- Session state persisted to `data/state.json` across runs

#### Keyboard input

- Primary input path uses evdev on Linux - reads directly from `/dev/input/event*` kernel devices, bypasses X11 entirely
- evdev path works under exclusive X11 keyboard grabs (games using raw input or exclusive grabs) where XRecord-based tools go blind
- Scans all evdev devices for ones advertising KEY_A and KEY_SPACE, spawns one capture thread per device
- Raw Linux keycode-to-name mapping for the full key set
- rdev fallback when evdev is unavailable or the user is not in the `input` group
- Falls back gracefully - both paths coexist at startup with evdev preferred

#### Controller input

- gilrs-based controller polling at ~120 Hz
- Face buttons (A/B/X/Y), bumpers (LB/RB), triggers (LT/RT), thumbstick clicks (LS/RS), d-pad directions, Back/Guide/Start
- Analog trigger capture with configurable threshold for the highlight trigger
- Analog stick axes for both left and right sticks with deadzone filtering (0.08)
- Axis changes rate-limited to ~60 fps to prevent flooding the WebSocket

#### HTTP server

- Serves the web overlay directory over HTTP for OBS Browser Source integration
- Static file serving with CORS headers via axum and tower-http
- Serves `layout.json`, assets, and the compiled web renderer

---

### Frontend (Electron)

- Electron 28 frameless transparent window, always on top, visible on all workspaces including fullscreen apps
- TypeScript renderer with canvas-based drawing
- Preload bridge via `contextBridge` exposes layout reading, window resize IPC, click-through IPC, and overlay lock events
- `sandbox: false` required in webPreferences to allow Node built-ins (`path`, `fs`) in the preload
- No CSP meta tag - removed to allow WebSocket connections and `file://` image loads from the Electron renderer

#### Header and controls

- Header bar with draggable title area, connection status indicator, mode toggle, dark/light toggle, lock button, and total input counter
- Minimize and close window control buttons in the top-right corner styled to match the dark theme
- Right-click context menu anywhere on the window with: mode switch, controller layout switch, dark/light toggle, lock, minimize, and quit
- Close button goes red on hover, quit item in context menu uses a danger style

#### Canvas renderer

- Keyboard mode renders the full retro keyboard layout image with per-key highlight rectangles that fade out on release
- Controller mode renders the controller image with circular highlights for buttons, analog fill bars for triggers, and an animated dot-in-ring for each analog stick
- Highlight fade animation over 180 ms using `requestAnimationFrame`
- Dark mode: near-black canvas fill with the base image ghosted at 12% opacity, white highlights for active keys and buttons
- Light mode: full-opacity base image with near-black overlay highlights (0.72 alpha) for visible feedback on light backgrounds
- Analog sticks correct for gilrs Y-axis convention (positive = up) vs canvas coordinate direction (positive = down)
- Trigger bars render as fill bars with a cool blue fill in dark mode and warm orange in light mode
- `roundRect` helper for keyboard key highlights with 4 px corner radius

#### Dark mode

- Dark mode on by default, persists to `localStorage`
- Header visually matches dark/light state with separate CSS classes

#### Lock mode

- Lock button hides the header and makes the entire window click-through
- Window auto-resizes to canvas dimensions when locked (no header height)
- `Ctrl+Alt+O` global shortcut unlocks from outside the window when input is locked

#### Window management

- Window resizes to match the active layout image dimensions via IPC on mode switch and lock/unlock
- F12 opens DevTools in both dev and packaged builds

---

### Web renderer (OBS Browser Source)

- Separate TypeScript renderer compiled independently (`tsconfig.web.json`) to avoid global scope conflicts with the Electron renderer
- No Electron APIs - pure browser, connects to the backend WebSocket via URL parameter
- URL parameters: `?mode=`, `?dark=1`, `?obs=1` (hides control bar), `?ws=` (WebSocket URL override)
- Served at `http://127.0.0.1:8766` by the Rust HTTP server
- Same canvas drawing logic as the Electron renderer

---

### Layout system

- `config/layout.json` is the single source of truth for all button and key positions
- Keyboard section: per-key `x`, `y`, `w`, `h` pixel coordinates on the base image
- Controller section: per-button `x`, `y`, `r` coordinates; separate `triggers` and `sticks` blocks for analog rendering
- Multiple controller layouts supported - `controller` and `controller2` in the same file; renderer switches between them at runtime without restart
- Layout read from disk on every launch, no rebuild needed to adjust positions

#### Included layouts

| Layout | Image | Dimensions |
|---|---|---|
| Keyboard | `retrokblayout.jpg` | 1078 x 375 |
| Classic Controller | `controller.png` | 479 x 310 |
| Xbox 360 Controller | `360-controller-layout.png` | 840 x 467 |

- Xbox 360 controller image processed to remove white background via flood-fill from image edges, saved as PNG with alpha channel

---

### Layout editor (`tools/layout-editor.html`)

- Standalone HTML tool, no server or build step required
- Load any image via file picker or drag-and-drop
- Load an existing `layout.json` to overlay current positions
- **Draw mode** - type a key/button name, choose Rectangle, Circle, or Point shape, click and drag on the image to place; re-drawing the same name updates in place
- **Move mode** - click any entry to select it, drag to reposition; hover highlights in orange, selected entry highlights in white; positions snap to integers on release
- Keyboard shortcuts: `D` draw mode, `M` move mode, `Del`/`Backspace` delete selected, `Escape` cancel/deselect
- Sidebar list of all entries showing name, position, and size; click to select, X to delete
- Sort entries by Y then X position
- JSON preview panel updates live; Copy to clipboard and Download buttons
- Exports a flat `{ "key": { x, y, w, h } }` object ready to merge into `layout.json`

---

### Build system

- `build.sh` orchestrates the full build: Rust backend (release), TypeScript compilation, web renderer compilation, and optional packaging
- `--package` flag runs electron-builder for the Linux AppImage
- `--package-win` flag cross-compiles the Rust backend for `x86_64-pc-windows-gnu` then packages the Windows NSIS installer
- Per-platform `extraResources` in `package.json` - Linux build includes the Linux binary, Windows build includes the Windows exe
- Platform detection in `main.ts` selects the correct binary name and path at runtime
- `backend/.cargo/config.toml` sets the mingw linker and ar for Windows cross-compilation

#### Distribution artifacts

| File | Target |
|---|---|
| `dist-app/Nput-0.1.0.AppImage` | Linux x64 |
| `dist-app/Nput Setup 0.1.0.exe` | Windows x64 NSIS installer |

---

### Bug fixes

- **Blank canvas on launch** - removed CSP meta tag that was blocking WebSocket connections from `file://` origin; added `sandbox: false` to webPreferences to allow Node built-ins in preload; wrapped renderer boot in try/catch to surface init errors in the status bar instead of silently failing
- **Windows binary not bundled** - fixed by splitting `extraResources` in `package.json` into platform-specific sections
- **Keyboard input not captured when game is focused** - switched primary capture from rdev (XRecord) to evdev; evdev reads directly from the kernel and is unaffected by X11 exclusive grabs
- **Analog stick Y axis inverted** - gilrs reports positive Y as up, canvas Y increases downward; fixed by negating Y in the stick dot position calculation in both the Electron and web renderers
- **serde/log/serde_json unresolved on Windows cross-compile** - TOML section scoping bug placed these dependencies inside `[target.'cfg(target_os = "linux")'.dependencies]` accidentally; moved them above the section header
- **Corrupt Windows cross-compile cache** - first failed build attempt (before `x86_64-pc-windows-gnu` target was installed) left partial `.rlib` files; fixed by running `cargo clean --target x86_64-pc-windows-gnu`
