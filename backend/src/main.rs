// ============================================================
// main.rs — Nput backend entry point
//
// Spins up three concurrent services:
//   • WebSocket server  ws://127.0.0.1:8765   (frontend state stream)
//   • HTTP server       http://127.0.0.1:8766  (OBS / browser overlay)
//   • Input event loop  (keyboard + controller → state → broadcast)
//
// Path resolution order for all directories:
//   1. Environment variable (set by Electron when packaged)
//   2. CWD/<name>      (running from project root, typical dev)
//   3. ../<name>       (running from backend/ with cargo run)
// ============================================================

mod input;
mod server;
mod state;
mod web;

use input::{controller, keyboard, InputEvent};
use state::State;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};

// ── Axis rate-limiting ───────────────────────────────────────

const AXIS_FRAME: Duration = Duration::from_micros(16_667); // ~60 fps

// ── Directory helpers ────────────────────────────────────────

/// Find a named directory by checking an optional env override,
/// then CWD/<name>, then CWD/../<name>.
fn find_dir(env_key: &str, name: &str) -> PathBuf {
    // 1 — env override (used when spawned by the Electron app)
    if let Ok(v) = std::env::var(env_key) {
        let p = PathBuf::from(v);
        if p.exists() { return p; }
    }

    let cwd = std::env::current_dir().expect("can't read cwd");

    // 2 — CWD/<name>
    let in_cwd = cwd.join(name);
    if in_cwd.exists() { return in_cwd; }

    // 3 — parent/<name>
    let in_parent = cwd.join("..").join(name);
    if in_parent.exists() { return in_parent; }

    // Fall back to CWD/<name> even if it doesn't exist yet
    in_cwd
}

// ── Persistence helpers ──────────────────────────────────────

fn data_path() -> PathBuf {
    // NPUT_DATA_DIR can be an absolute path set by the Electron app
    // (points to app.getPath('userData') in production builds).
    if let Ok(dir) = std::env::var("NPUT_DATA_DIR") {
        let p = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&p);
        return p.join("state.json");
    }
    find_dir("", "data").join("state.json")
}

fn load_total_inputs() -> u64 {
    let path = data_path();
    let Ok(content) = std::fs::read_to_string(&path) else { return 0; };
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| v["totalInputs"].as_u64())
        .unwrap_or(0)
}

fn save_total_inputs(total: u64) {
    let path = data_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::json!({ "totalInputs": total });
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap());
}

// ── Main ─────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    env_logger::builder()
        .filter_level(log::LevelFilter::Info)
        .parse_default_env()
        .init();

    log::info!("Nput backend starting up 🎮");

    // Resolve all resource directories up front
    let assets_dir = find_dir("NPUT_ASSETS_DIR", "assets");
    let config_dir = find_dir("NPUT_CONFIG_DIR", "config");
    let web_dir    = find_dir("NPUT_WEB_DIR",    "web");

    log::info!("assets  → {:?}", assets_dir);
    log::info!("config  → {:?}", config_dir);
    log::info!("web     → {:?}", web_dir);

    let total_inputs = load_total_inputs();
    log::info!("Total inputs so far: {}", total_inputs);

    let mut state = State::new(total_inputs);

    // channel: input listeners → main event loop
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<InputEvent>();

    // channel: WS client messages → main loop (mode toggle, etc.)
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<String>();

    // broadcast: main loop → all connected WS clients
    let (bcast_tx, _) = broadcast::channel::<String>(256);

    // Start input listeners (each on its own OS thread)
    keyboard::start(event_tx.clone());
    controller::start(event_tx.clone());

    // WebSocket server
    let ws_bcast = bcast_tx.clone();
    tokio::spawn(async move {
        if let Err(e) = server::start(ws_bcast, ctrl_tx).await {
            log::error!("WebSocket server crashed: {}", e);
        }
    });

    // HTTP server — OBS browser source + browser overlay
    tokio::spawn(async move {
        if let Err(e) = web::start(web_dir, assets_dir, config_dir).await {
            log::error!("HTTP server crashed: {}", e);
        }
    });

    log::info!("Ready!");
    log::info!("  WebSocket → ws://{}", server::WS_ADDR);
    log::info!("  Overlay   → http://{}", web::HTTP_ADDR);

    // Push initial state immediately so early-connecting clients
    // don't stare at a blank canvas
    let _ = bcast_tx.send(state.to_json());

    let mut last_axis_bcast = Instant::now();
    let mut axis_dirty      = false;
    let mut save_tick       = tokio::time::interval(Duration::from_secs(5));
    save_tick.tick().await; // skip immediate first tick

    loop {
        tokio::select! {
            // ── Input event ───────────────────────────────────
            Some(event) = event_rx.recv() => {
                let is_axis = matches!(
                    &event,
                    InputEvent::TriggerChanged { .. }
                        | InputEvent::LeftStickChanged { .. }
                        | InputEvent::RightStickChanged { .. }
                );

                if process_event(&mut state, event) {
                    if is_axis {
                        axis_dirty = true;
                        if last_axis_bcast.elapsed() >= AXIS_FRAME {
                            let _ = bcast_tx.send(state.to_json());
                            last_axis_bcast = Instant::now();
                            axis_dirty = false;
                        }
                    } else {
                        let _ = bcast_tx.send(state.to_json());
                    }
                }
            }

            // ── Control message (mode toggle from client) ─────
            Some(msg) = ctrl_rx.recv() => {
                handle_control(&mut state, &msg);
                let _ = bcast_tx.send(state.to_json());
            }

            // ── Flush pending axis state at ~60 fps ───────────
            _ = tokio::time::sleep(AXIS_FRAME), if axis_dirty => {
                let _ = bcast_tx.send(state.to_json());
                last_axis_bcast = Instant::now();
                axis_dirty = false;
            }

            // ── Periodic save ─────────────────────────────────
            _ = save_tick.tick() => {
                save_total_inputs(state.total_inputs);
                log::debug!("Auto-saved total_inputs={}", state.total_inputs);
            }

            // ── Graceful shutdown ─────────────────────────────
            _ = tokio::signal::ctrl_c() => {
                log::info!("Shutting down — saving state...");
                save_total_inputs(state.total_inputs);
                log::info!("Total inputs recorded: {}  Goodbye!", state.total_inputs);
                std::process::exit(0);
            }
        }
    }
}

// ── Event processing ─────────────────────────────────────────

fn process_event(state: &mut State, event: InputEvent) -> bool {
    let threshold = controller::trigger_threshold();

    match event {
        InputEvent::KeyPressed(key) => {
            if state.keyboard_pressed.insert(key.clone()) {
                state.total_inputs += 1;
                log::info!("[KB]   ↓ {}  (total: {})", key, state.total_inputs);
                return true;
            }
        }
        InputEvent::KeyReleased(key) => {
            if state.keyboard_pressed.remove(&key) {
                log::info!("[KB]   ↑ {}", key);
                return true;
            }
        }
        InputEvent::ButtonPressed(btn) => {
            if state.controller_buttons.insert(btn.clone()) {
                state.total_inputs += 1;
                log::info!("[CTRL] ↓ {}  (total: {})", btn, state.total_inputs);
                return true;
            }
        }
        InputEvent::ButtonReleased(btn) => {
            if state.controller_buttons.remove(&btn) {
                log::info!("[CTRL] ↑ {}", btn);
                return true;
            }
        }
        InputEvent::TriggerChanged { lt, rt } => {
            let lt_now = lt > threshold;
            let rt_now = rt > threshold;

            if lt_now && !state.trigger_lt_pressed {
                state.total_inputs += 1;
                log::info!("[CTRL] ↓ LT  ({:.2})  (total: {})", lt, state.total_inputs);
            }
            if rt_now && !state.trigger_rt_pressed {
                state.total_inputs += 1;
                log::info!("[CTRL] ↓ RT  ({:.2})  (total: {})", rt, state.total_inputs);
            }
            if !lt_now && state.trigger_lt_pressed { log::info!("[CTRL] ↑ LT"); }
            if !rt_now && state.trigger_rt_pressed { log::info!("[CTRL] ↑ RT"); }

            state.trigger_lt = lt;
            state.trigger_rt = rt;
            state.trigger_lt_pressed = lt_now;
            state.trigger_rt_pressed = rt_now;
            return true;
        }
        InputEvent::LeftStickChanged { x, y } => {
            state.left_stick = (x, y);
            return true;
        }
        InputEvent::RightStickChanged { x, y } => {
            state.right_stick = (x, y);
            return true;
        }
    }

    false
}

// ── Control message handler ───────────────────────────────────

fn handle_control(state: &mut State, msg: &str) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(msg) else {
        log::warn!("Unparseable control message: {}", msg);
        return;
    };

    if let Some(mode) = json["setMode"].as_str() {
        match mode {
            "keyboard" | "controller" => {
                log::info!("Mode → {}", mode);
                state.mode = mode.to_string();
            }
            other => log::warn!("Unknown mode: {}", other),
        }
    }
}
