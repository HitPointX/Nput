// ============================================================
// web-renderer.ts — Browser-native overlay renderer
//
// This is the OBS Browser Source / regular-browser version.
// No Electron APIs here — everything goes through standard
// web primitives: fetch, WebSocket, URL query params.
//
// Stick it behind the Rust HTTP server (port 8766) and it
// just works.  OBS setup: Add Source → Browser Source →
// http://localhost:8766
//
// URL params (all optional — sane defaults apply):
//   ?mode=keyboard | controller   initial display mode
//   ?dark=1                        start in dark mode
//   ?obs=1                         hides the control bar for clean capture
//   ?ws=ws://127.0.0.1:8765        override WebSocket address
// ============================================================

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
interface LayoutConfig { keyboard: KeyboardLayout; controller: ControllerLayout }

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

const FADE_DURATION = 180;    // ms — key/button release fade time
const RECONNECT_MS  = 2000;
const STICK_DOT_R   = 6;      // movable dot radius (px)
const STICK_HALO_R  = 9;      // dark halo behind dot (px)
const TRIGGER_FONT  = 'bold 9px monospace';
const DARK_BG       = 'rgba(8, 8, 12, 0.90)';
const DARK_IMG_A    = 0.12;   // ghost opacity in dark mode

// ── Query param helpers ──────────────────────────────────────

const params = new URLSearchParams(window.location.search);

function qparam(key: string): string | null { return params.get(key); }

// ── Globals ──────────────────────────────────────────────────

let layout:       LayoutConfig | null = null;
let currentMode:  'keyboard' | 'controller' = 'keyboard';
let currentState: InputMessage | null        = null;
let darkMode      = qparam('dark') === '1';
let ws:           WebSocket | null           = null;

const WS_URL   = qparam('ws') ?? 'ws://127.0.0.1:8765';
const OBS_MODE = qparam('obs') === '1';

const kbHighlights:  Map<string, HlState> = new Map();
const btnHighlights: Map<string, HlState> = new Map();

// Images keyed by mode — populated once layout is fetched
const images: Partial<Record<'keyboard' | 'controller', HTMLImageElement>> = {};

// ── DOM refs ─────────────────────────────────────────────────

const canvas   = document.getElementById('overlay')  as HTMLCanvasElement;
const ctx      = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')   as HTMLElement;
const countEl  = document.getElementById('count')    as HTMLElement;
const modeBtn  = document.getElementById('mode-btn') as HTMLButtonElement;
const darkBtn  = document.getElementById('dark-btn') as HTMLButtonElement;
const controlBar = document.getElementById('control-bar') as HTMLElement;

// ── OBS mode — hide the control bar for a clean capture ─────

if (OBS_MODE && controlBar) {
  controlBar.style.display = 'none';
}

// ── Image loading ────────────────────────────────────────────

// Assets are served from /assets/ relative to this page (port 8766).
function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  img.onload  = () => { console.log('[nput] loaded:', src); renderFrame(); };
  img.onerror = () => console.error('[nput] failed to load:', src);
  return img;
}

// ── Layout fetch ─────────────────────────────────────────────

// Fetches /layout.json from the same origin as this page.
// The Rust backend re-reads the file on every request, so live
// layout edits are picked up without restarting anything.
async function fetchLayout(): Promise<LayoutConfig> {
  const res = await fetch('/layout.json');
  if (!res.ok) throw new Error(`layout.json → ${res.status}`);
  return res.json() as Promise<LayoutConfig>;
}

// ── Dark mode ────────────────────────────────────────────────

function applyDarkMode(on: boolean): void {
  darkMode = on;
  if (on) {
    document.body.classList.add('dark-mode');
    if (darkBtn) {
      darkBtn.textContent = '☀ Light';
      darkBtn.title = 'Switch to light mode';
    }
  } else {
    document.body.classList.remove('dark-mode');
    if (darkBtn) {
      darkBtn.textContent = '🌙 Dark';
      darkBtn.title = 'Switch to dark mode';
    }
  }
}

if (darkBtn) darkBtn.addEventListener('click', () => applyDarkMode(!darkMode));

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
  if (!layout) return;
  const l = mode === 'keyboard' ? layout.keyboard : layout.controller;
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
  const img = images[mode];
  const ready = img && img.complete && img.naturalWidth > 0;

  if (darkMode) {
    ctx.fillStyle = DARK_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (ready && img) {
      ctx.globalAlpha = DARK_IMG_A;
      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = 1.0;
    }
  } else {
    if (ready && img) {
      ctx.drawImage(img, 0, 0);
    } else {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#555';
      ctx.font = '13px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('Loading…', 12, 12);
    }
  }
}

// ── Keyboard rendering ───────────────────────────────────────

function drawKeyHighlights(): void {
  if (!layout) return;
  const keys = layout.keyboard.keys;
  for (const [key, h] of kbHighlights.entries()) {
    const k = keys[key];
    if (!k) continue;
    ctx.fillStyle = darkMode
      ? `rgba(255, 255, 255, ${h.alpha * 0.88})`
      : `rgba(10,  10,  10,  ${h.alpha * 0.72})`;
    roundRect(ctx, k.x - k.w / 2, k.y - k.h / 2, k.w, k.h, 4);
    ctx.fill();
  }
}

// ── Controller rendering ─────────────────────────────────────

function drawButtonHighlights(): void {
  if (!layout) return;
  const btns = layout.controller.buttons;
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

function drawTriggerBars(lt: number, rt: number): void {
  if (!layout) return;
  drawOneTrigger('LT', lt, layout.controller.triggers.LT);
  drawOneTrigger('RT', rt, layout.controller.triggers.RT);
}

function drawOneTrigger(label: string, value: number, entry: TriggerEntry): void {
  const barW = 34, barH = 8;
  const x = entry.x - barW / 2;
  const y = entry.y - barH / 2;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.40)';
  roundRect(ctx, x, y, barW, barH, 3);
  ctx.fill();

  if (value > 0.01) {
    const fillW = Math.max(4, value * (barW - 4));
    if (darkMode) {
      ctx.fillStyle = `rgba(80, 180, 255, ${0.5 + value * 0.5})`;
    } else {
      const g = Math.round(210 - value * 80);
      ctx.fillStyle = `rgba(255, ${g}, 0, ${0.5 + value * 0.5})`;
    }
    roundRect(ctx, x + 2, y + 2, fillW, barH - 4, 2);
    ctx.fill();
  }

  if (value > entry.threshold) {
    ctx.fillStyle    = darkMode ? '#7df' : '#fff';
    ctx.font         = TRIGGER_FONT;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, entry.x, entry.y);
  }
}

function drawStickIndicators(left: StickPosition, right: StickPosition): void {
  if (!layout) return;
  drawOneStick(layout.controller.sticks.left,  left);
  drawOneStick(layout.controller.sticks.right, right);
}

function drawOneStick(entry: StickEntry, axis: StickPosition): void {
  ctx.strokeStyle = darkMode
    ? 'rgba(255, 255, 255, 0.35)'
    : 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(entry.x, entry.y, entry.radius, 0, Math.PI * 2);
  ctx.stroke();

  const dotX = entry.x + axis.x * entry.radius;
  const dotY = entry.y - axis.y * entry.radius; // gilrs Y: +1=up, canvas Y: +1=down

  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.arc(dotX, dotY, STICK_HALO_R, 0, Math.PI * 2);
  ctx.fill();

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
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className   = cls;
}

function connect(): void {
  setStatus(`● Connecting to ${WS_URL}…`, 'connecting');
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    setStatus(`● Connected  →  ${WS_URL}`, 'connected');
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
      if (modeBtn) {
        modeBtn.textContent = msg.mode === 'keyboard' ? '🎮 Controller' : '⌨ Keyboard';
      }
    }

    syncHighlights(kbHighlights,  msg.keyboard.pressed,   now);
    syncHighlights(btnHighlights, msg.controller.buttons, now);

    currentState = msg;
    if (countEl) countEl.textContent = String(msg.totalInputs);
  });

  ws.addEventListener('close', () => {
    setStatus('● Disconnected — retrying…', 'disconnected');
    ws = null;
    setTimeout(connect, RECONNECT_MS);
  });

  ws.addEventListener('error', (e: Event) => console.error('[nput] WS error:', e));
}

// ── Mode toggle ──────────────────────────────────────────────

if (modeBtn) {
  modeBtn.addEventListener('click', () => {
    const next = currentMode === 'keyboard' ? 'controller' : 'keyboard';
    currentMode = next;
    kbHighlights.clear();
    btnHighlights.clear();
    resizeCanvas(next);
    modeBtn.textContent = next === 'keyboard' ? '🎮 Controller' : '⌨ Keyboard';
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ setMode: next }));
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Honour ?mode= query param — gives OBS a fixed starting mode
  const modeParam = qparam('mode');
  if (modeParam === 'controller' || modeParam === 'keyboard') {
    currentMode = modeParam;
  }

  // Honour ?dark= query param — OBS doesn't have localStorage
  applyDarkMode(darkMode);

  try {
    layout = await fetchLayout();
  } catch (err) {
    console.error('[nput] Could not load layout.json:', err);
    setStatus('● layout.json not found', 'disconnected');
    return;
  }

  // Load assets from the HTTP server — /assets/<subdir>/<file>
  images.keyboard   = loadImage(`/assets/keyboard/${layout.keyboard.asset}`);
  images.controller = loadImage(`/assets/controller/${layout.controller.asset}`);

  // Size the canvas to match the initial mode
  resizeCanvas(currentMode);
  if (modeBtn) {
    modeBtn.textContent = currentMode === 'keyboard' ? '🎮 Controller' : '⌨ Keyboard';
  }

  requestAnimationFrame(animLoop);
  connect();
}

boot().catch(console.error);
