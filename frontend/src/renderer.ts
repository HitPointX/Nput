// ============================================================
// renderer.ts — Canvas overlay renderer  (Phase F + dark mode)
//
// New in this phase:
//
//   Dark mode (toggle button / localStorage)
//   ─────────────────────────────────────────
//   Light: base image at full opacity + warm yellow highlights
//   Dark:  near-black canvas fill + ghost image at 12% opacity
//          + bright white/blue highlights so only active keys
//          really pop — very stream-friendly on any background.
//
//   Lock / overlay mode
//   ─────────────────────────────────────────
//   Lock button → header hides, window becomes fully click-through.
//   Ctrl+Alt+O global shortcut → unlocks from the outside (main
//   pushes 'nput:overlay-locked' = false and we restore the header).
//
//   Window auto-resize
//   ─────────────────────────────────────────
//   Whenever the canvas dimensions change (mode switch, lock/unlock)
//   we tell main the canvas size and it sets the exact window size.
// ============================================================

// ── Bridge / preload types ───────────────────────────────────

interface NputBridge {
  version:      string;
  wsUrl:        string;
  assetsPath:   string;
  getLayout:    () => LayoutConfig;
  resizeWindow: (w: number, h: number) => Promise<void>;
  setClickThrough: (lock: boolean) => Promise<void>;
  onOverlayLocked: (cb: (locked: boolean) => void) => void;
  minimize:     () => Promise<void>;
  quit:         () => Promise<void>;
}

// ── Layout config (mirrors layout.json) ─────────────────────

interface KeyEntry     { x: number; y: number; w: number; h: number }
interface ButtonEntry  { x: number; y: number; r: number }
interface TriggerEntry { x: number; y: number; threshold: number }
interface StickEntry   { x: number; y: number; radius: number }

interface KeyboardLayout {
  asset:  string; width: number; height: number;
  keys:   Record<string, KeyEntry>;
}
interface ControllerLayout {
  asset:    string; width: number; height: number;
  buttons:  Record<string, ButtonEntry>;
  triggers: { LT: TriggerEntry; RT: TriggerEntry };
  sticks:   { left: StickEntry; right: StickEntry };
}
interface LayoutConfig {
  keyboard:    KeyboardLayout;
  controller:  ControllerLayout;
  controller2?: ControllerLayout;
}

// ── Input state (matches backend JSON schema) ────────────────

interface StickPosition { x: number; y: number }
interface InputMessage {
  mode:       'keyboard' | 'controller';
  keyboard:   { pressed: string[] };
  controller: {
    buttons:  string[];
    triggers: { LT: number; RT: number };
    sticks:   { left: StickPosition; right: StickPosition };
  };
  totalInputs: number;
}

// ── Fade animation state ─────────────────────────────────────

interface HlState {
  alpha:     number;   // 0.0 → 1.0
  fading:    boolean;
  fadeStart: number;   // performance.now() when fade began
}

// ── Constants ────────────────────────────────────────────────

const FADE_DURATION = 180;    // ms — released key/button fade time
const RECONNECT_MS  = 2000;
const STICK_DOT_R   = 6;      // movable dot radius (px)
const STICK_HALO_R  = 9;      // dark halo behind dot (px)
const TRIGGER_FONT  = 'bold 9px monospace';
const DARK_BG       = 'rgba(8, 8, 12, 0.90)';
const DARK_IMG_A    = 0.12;   // ghost opacity in dark mode

// ── DOM refs ─────────────────────────────────────────────────

const canvas    = document.getElementById('overlay')    as HTMLCanvasElement;
const ctx       = canvas.getContext('2d')!;
const statusEl  = document.getElementById('status')     as HTMLElement;
const countEl   = document.getElementById('count')      as HTMLElement;
const modeBtn   = document.getElementById('mode-btn')   as HTMLButtonElement;
const darkBtn   = document.getElementById('dark-btn')   as HTMLButtonElement;
const lockBtn   = document.getElementById('lock-btn')   as HTMLButtonElement;
const winMin    = document.getElementById('win-min')    as HTMLButtonElement;
const winClose  = document.getElementById('win-close')  as HTMLButtonElement;
const ctxMenu   = document.getElementById('ctx-menu')   as HTMLElement;
const ctxMode   = document.getElementById('ctx-mode')   as HTMLElement;
const ctxLayout = document.getElementById('ctx-layout') as HTMLElement;
const ctxDark   = document.getElementById('ctx-dark')   as HTMLElement;
const ctxLock   = document.getElementById('ctx-lock')   as HTMLElement;
const ctxMin    = document.getElementById('ctx-min')    as HTMLElement;
const ctxQuit   = document.getElementById('ctx-quit')   as HTMLElement;

// ── Globals ──────────────────────────────────────────────────

const bridge = (window as unknown as { nputBridge: NputBridge }).nputBridge;
const layout = bridge.getLayout();

const images: Record<string, HTMLImageElement> = {
  keyboard:    loadImage(`file://${bridge.assetsPath}/keyboard/${layout.keyboard.asset}`),
  controller:  loadImage(`file://${bridge.assetsPath}/controller/${layout.controller.asset}`),
  ...(layout.controller2 ? {
    controller2: loadImage(`file://${bridge.assetsPath}/controller/${layout.controller2.asset}`),
  } : {}),
};

let ws:                  WebSocket | null = null;
let currentMode:         'keyboard' | 'controller' = 'keyboard';
let controllerLayout:    'controller' | 'controller2' = 'controller';
let currentState:        InputMessage | null = null;
let isLocked             = false;

// Returns whichever controller layout is currently active
function activeCtrl(): ControllerLayout {
  return (controllerLayout === 'controller2' && layout.controller2)
    ? layout.controller2
    : layout.controller;
}

// Dark mode persists across sessions via localStorage
let darkMode = localStorage.getItem('nput-dark-mode') !== 'false'; // default ON

const kbHighlights:  Map<string, HlState> = new Map();
const btnHighlights: Map<string, HlState> = new Map();

// ── Image loading ────────────────────────────────────────────

function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  img.onload  = () => { console.log('[nput] Loaded:', src); renderFrame(); }
  img.onerror = () => console.error('[nput] Failed to load:', src);
  return img;
}

// ── Window sizing ────────────────────────────────────────────

// Tell main the canvas pixel dimensions; it handles adding header height.
function syncWindowSize(): void {
  const l = currentMode === 'keyboard' ? layout.keyboard : activeCtrl();
  bridge.resizeWindow(l.width, l.height).catch(console.error);
}

// ── Lock / overlay mode ──────────────────────────────────────

function applyLockState(locked: boolean): void {
  isLocked = locked;

  if (locked) {
    document.body.classList.add('locked');
  } else {
    document.body.classList.remove('locked');
  }

  bridge.setClickThrough(locked).catch(console.error);
  syncWindowSize(); // window height changes with header visibility
}

lockBtn.addEventListener('click', () => applyLockState(true));

// Main process pushes this when the global shortcut unlocks us
bridge.onOverlayLocked((locked: boolean) => applyLockState(locked));

// ── Dark mode ────────────────────────────────────────────────

function applyDarkMode(on: boolean): void {
  darkMode = on;
  localStorage.setItem('nput-dark-mode', String(on));

  if (on) {
    document.body.classList.add('dark-mode');
    darkBtn.textContent = '☀ Light';
    darkBtn.title = 'Switch to light mode';
  } else {
    document.body.classList.remove('dark-mode');
    darkBtn.textContent = '🌙 Dark';
    darkBtn.title = 'Switch to dark mode';
  }
}

darkBtn.addEventListener('click', () => applyDarkMode(!darkMode));

// ── Window controls ──────────────────────────────────────────

winMin.addEventListener('click',   () => bridge.minimize().catch(console.error));
winClose.addEventListener('click', () => bridge.quit().catch(console.error));

// ── Context menu ─────────────────────────────────────────────

function updateCtxLabels(): void {
  ctxMode.textContent   = currentMode === 'keyboard' ? '🎮 Switch to Controller' : '⌨ Switch to Keyboard';
  ctxDark.textContent   = darkMode ? '☀ Light Mode' : '🌙 Dark Mode';
  ctxLock.textContent   = '🔒 Lock Inputs';
  // Hide layout toggle if controller2 not in layout.json
  if (layout.controller2) {
    ctxLayout.style.display = '';
    ctxLayout.textContent   = controllerLayout === 'controller'
      ? '🎮 Layout: Xbox 360'
      : '🎮 Layout: Classic';
  } else {
    ctxLayout.style.display = 'none';
  }
}

function showCtxMenu(x: number, y: number): void {
  updateCtxLabels();
  // Keep menu within viewport
  const mw = 190, mh = 160;
  ctxMenu.style.left    = `${Math.min(x, window.innerWidth  - mw)}px`;
  ctxMenu.style.top     = `${Math.min(y, window.innerHeight - mh)}px`;
  ctxMenu.style.display = 'block';
}

function hideCtxMenu(): void {
  ctxMenu.style.display = 'none';
}

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY);
});
document.addEventListener('click',   hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

ctxMode.addEventListener('click', () => {
  switchMode(currentMode === 'keyboard' ? 'controller' : 'keyboard');
});
ctxLayout.addEventListener('click', () => {
  switchControllerLayout(controllerLayout === 'controller' ? 'controller2' : 'controller');
});
ctxDark.addEventListener('click', () => applyDarkMode(!darkMode));
ctxLock.addEventListener('click', () => applyLockState(true));
ctxMin.addEventListener('click',  () => bridge.minimize().catch(console.error));
ctxQuit.addEventListener('click', () => bridge.quit().catch(console.error));

// ── Highlight helpers ────────────────────────────────────────

function syncHighlights(
  map:    Map<string, HlState>,
  active: string[],
  now:    number,
): void {
  const activeSet = new Set(active);

  for (const key of activeSet) {
    const h = map.get(key);
    if (!h || h.fading) {
      map.set(key, { alpha: 1.0, fading: false, fadeStart: 0 });
    }
  }

  for (const [key, h] of map.entries()) {
    if (!activeSet.has(key) && !h.fading) {
      h.fading = true;
      h.fadeStart = now;
    }
  }
}

function tickFades(map: Map<string, HlState>, now: number): void {
  for (const [key, h] of map.entries()) {
    if (h.fading) {
      h.alpha = Math.max(0, 1 - (now - h.fadeStart) / FADE_DURATION);
      if (h.alpha === 0) map.delete(key);
    }
  }
}

// ── Canvas helpers ───────────────────────────────────────────

function resizeCanvas(mode: 'keyboard' | 'controller'): void {
  const l = mode === 'keyboard' ? layout.keyboard : activeCtrl();
  canvas.width  = l.width;
  canvas.height = l.height;
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number, y: number,
  w: number, h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.quadraticCurveTo(x + w, y, x + w, y + rr);
  c.lineTo(x + w, y + h - rr);
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  c.lineTo(x + rr, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - rr);
  c.lineTo(x, y + rr);
  c.quadraticCurveTo(x, y, x + rr, y);
  c.closePath();
}

// ── Base image ───────────────────────────────────────────────

function drawBase(mode: 'keyboard' | 'controller'): void {
  const imgKey = mode === 'keyboard' ? 'keyboard' : controllerLayout;
  const img = images[imgKey] ?? images[mode];
  const ready = img.complete && img.naturalWidth > 0;

  if (darkMode) {
    // Dark background first — this IS the visible background in dark mode
    ctx.fillStyle = DARK_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Faint ghost of the layout so the user can see the shape
    if (ready) {
      ctx.globalAlpha = DARK_IMG_A;
      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = 1.0;
    }
  } else {
    if (ready) {
      ctx.drawImage(img, 0, 0);
    } else {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#555';
      ctx.font = '13px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('Loading asset…', 12, 12);
    }
  }
}

// ── Keyboard rendering ───────────────────────────────────────

function drawKeyHighlights(): void {
  const keys = layout.keyboard.keys;
  for (const [key, h] of kbHighlights.entries()) {
    const k = keys[key];
    if (!k) continue;
    ctx.fillStyle = darkMode
      ? `rgba(255, 255, 255, ${h.alpha * 0.88})`   // bright white glow
      : `rgba(10,  10,  10,  ${h.alpha * 0.72})`;  // near-black overlay
    roundRect(ctx, k.x - k.w / 2, k.y - k.h / 2, k.w, k.h, 4);
    ctx.fill();
  }
}

// ── Controller rendering ─────────────────────────────────────

function drawButtonHighlights(): void {
  const btns = activeCtrl().buttons;
  for (const [btn, h] of btnHighlights.entries()) {
    const b = btns[btn];
    if (!b) continue;
    ctx.fillStyle = darkMode
      ? `rgba(255, 255, 255, ${h.alpha * 0.90})`
      : `rgba(10,  10,  10,  ${h.alpha * 0.72})`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Trigger fill bars ─────────────────────────────────────────

function drawTriggerBars(lt: number, rt: number): void {
  drawOneTrigger('LT', lt, activeCtrl().triggers.LT);
  drawOneTrigger('RT', rt, activeCtrl().triggers.RT);
}

function drawOneTrigger(label: string, value: number, entry: TriggerEntry): void {
  const barW = 34, barH = 8;
  const x = entry.x - barW / 2;
  const y = entry.y - barH / 2;

  // Track background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.40)';
  roundRect(ctx, x, y, barW, barH, 3);
  ctx.fill();

  // Analog fill — colour shifts yellow→orange→white in dark mode
  if (value > 0.01) {
    const fillW = Math.max(4, value * (barW - 4));
    if (darkMode) {
      // In dark mode: cool blue fill that gets brighter at full press
      ctx.fillStyle = `rgba(80, 180, 255, ${0.5 + value * 0.5})`;
    } else {
      // Light mode: warm orange that deepens with pressure
      const g = Math.round(210 - value * 80);
      ctx.fillStyle = `rgba(255, ${g}, 0, ${0.5 + value * 0.5})`;
    }
    roundRect(ctx, x + 2, y + 2, fillW, barH - 4, 2);
    ctx.fill();
  }

  // Label — appears once threshold is crossed
  if (value > entry.threshold) {
    ctx.fillStyle    = darkMode ? '#7df' : '#fff';
    ctx.font         = TRIGGER_FONT;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, entry.x, entry.y);
  }
}

// ── Thumbstick animation ──────────────────────────────────────

function drawStickIndicators(left: StickPosition, right: StickPosition): void {
  drawOneStick(activeCtrl().sticks.left,  left);
  drawOneStick(activeCtrl().sticks.right, right);
}

function drawOneStick(entry: StickEntry, axis: StickPosition): void {
  // Travel-range ring — more visible in dark mode
  ctx.strokeStyle = darkMode
    ? 'rgba(255, 255, 255, 0.35)'
    : 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(entry.x, entry.y, entry.radius, 0, Math.PI * 2);
  ctx.stroke();

  const dotX = entry.x + axis.x * entry.radius;
  const dotY = entry.y - axis.y * entry.radius; // gilrs Y: +1=up, canvas Y: +1=down

  // Dark halo for contrast on light backgrounds
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.arc(dotX, dotY, STICK_HALO_R, 0, Math.PI * 2);
  ctx.fill();

  // The dot itself — white in both modes (works on light and dark)
  ctx.fillStyle = darkMode ? 'rgba(80, 200, 255, 0.95)' : 'rgba(255, 255, 255, 0.92)';
  ctx.beginPath();
  ctx.arc(dotX, dotY, STICK_DOT_R, 0, Math.PI * 2);
  ctx.fill();
}

// ── Master render ────────────────────────────────────────────

function renderFrame(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBase(currentMode);

  if (!currentState) return;
  const s = currentState;

  if (s.mode === 'keyboard') {
    drawKeyHighlights();
  } else {
    drawButtonHighlights();
    drawTriggerBars(s.controller.triggers.LT, s.controller.triggers.RT);
    drawStickIndicators(s.controller.sticks.left, s.controller.sticks.right);
  }
}

// ── Animation loop ───────────────────────────────────────────

function animLoop(now: DOMHighResTimeStamp): void {
  tickFades(kbHighlights,  now);
  tickFades(btnHighlights, now);
  renderFrame();
  requestAnimationFrame(animLoop);
}

// ── WebSocket ────────────────────────────────────────────────

type StatusClass = 'connected' | 'disconnected' | 'connecting';

function setStatus(text: string, cls: StatusClass): void {
  statusEl.textContent = text;
  statusEl.className   = cls;
}

function connect(): void {
  setStatus(`● Connecting to ${bridge.wsUrl}…`, 'connecting');
  ws = new WebSocket(bridge.wsUrl);

  ws.addEventListener('open', () => {
    setStatus(`● Connected  →  ${bridge.wsUrl}`, 'connected');
    ws!.send(JSON.stringify({ setMode: currentMode }));
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    let msg: InputMessage;
    try { msg = JSON.parse(event.data as string) as InputMessage; }
    catch { console.error('[nput] Bad JSON:', event.data); return; }

    const now = performance.now();

    if (msg.mode !== currentMode) {
      currentMode = msg.mode;
      resizeCanvas(msg.mode);
      kbHighlights.clear();
      btnHighlights.clear();
      modeBtn.textContent = msg.mode === 'keyboard' ? '🎮 Controller' : '⌨ Keyboard';
      syncWindowSize();
    }

    syncHighlights(kbHighlights,  msg.keyboard.pressed,   now);
    syncHighlights(btnHighlights, msg.controller.buttons, now);

    currentState        = msg;
    countEl.textContent = String(msg.totalInputs);
  });

  ws.addEventListener('close', () => {
    setStatus('● Disconnected — retrying…', 'disconnected');
    ws = null;
    setTimeout(connect, RECONNECT_MS);
  });

  ws.addEventListener('error', (e: Event) => {
    console.error('[nput] WS error:', e);
    setStatus(`● WS error — retrying in ${RECONNECT_MS / 1000}s…`, 'disconnected');
  });
}

// ── Mode toggle button ───────────────────────────────────────

function switchMode(next: 'keyboard' | 'controller'): void {
  currentMode = next;
  kbHighlights.clear();
  btnHighlights.clear();
  resizeCanvas(next);
  syncWindowSize();
  modeBtn.textContent = next === 'keyboard' ? '🎮 Controller' : '⌨ Keyboard';
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ setMode: next }));
  }
}

modeBtn.addEventListener('click', () => {
  switchMode(currentMode === 'keyboard' ? 'controller' : 'keyboard');
});

function switchControllerLayout(next: 'controller' | 'controller2'): void {
  if (!layout.controller2 && next === 'controller2') return;
  controllerLayout = next;
  btnHighlights.clear();
  resizeCanvas('controller');
  syncWindowSize();
}

// ── Boot ─────────────────────────────────────────────────────

// Wrap everything so a crash on init shows in the status bar
// instead of silently dying and leaving a blank transparent canvas.
try {
  applyDarkMode(darkMode);
  resizeCanvas(currentMode);
  syncWindowSize();
  requestAnimationFrame(animLoop);
  connect();
} catch (err) {
  console.error('[nput] init crash:', err);
  setStatus(`✗ Init error: ${(err as Error).message}`, 'disconnected');
}
