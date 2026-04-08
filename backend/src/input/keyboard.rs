// ============================================================
// input/keyboard.rs — Global keyboard listener
//
// On Linux we try two capture paths, in order:
//
//   1. evdev  — reads /dev/input/event* directly from the kernel.
//               Works no matter which app is focused, even when a
//               game holds an exclusive X11 keyboard grab.
//               Requires: `sudo usermod -aG input $USER` + re-login.
//
//   2. rdev   — falls back to XRecord (X11 global hook) if evdev
//               devices aren't accessible.  Works fine for regular
//               desktop use but misses keys while games are focused.
//
// On Windows / macOS rdev is always used (no evdev available).
// ============================================================

use super::InputEvent;
use rdev::{listen, EventType, Key};
use tokio::sync::mpsc::UnboundedSender;

pub fn start(tx: UnboundedSender<InputEvent>) {
    std::thread::Builder::new()
        .name("nput-keyboard".into())
        .spawn(move || {
            #[cfg(target_os = "linux")]
            {
                if linux_evdev::start(tx.clone()) {
                    log::info!("Keyboard listener started (evdev — global capture active)");
                    return; // evdev threads are running, we're done here
                }
                log::warn!("evdev keyboard devices not accessible — falling back to XRecord");
                log::warn!("  Keys may not register when games have exclusive keyboard focus.");
                log::warn!("  Fix: sudo usermod -aG input $USER   (then re-login)");
            }

            // rdev path — X11/XRecord on Linux, native hooks on Win/Mac
            log::info!("Keyboard listener started (rdev)");
            if let Err(e) = listen(move |event| {
                let ev = match event.event_type {
                    EventType::KeyPress(k) => {
                        let name = rdev_key_name(k);
                        log::debug!("[KB rdev] ↓ {}", name);
                        Some(InputEvent::KeyPressed(name))
                    }
                    EventType::KeyRelease(k) => {
                        let name = rdev_key_name(k);
                        log::debug!("[KB rdev] ↑ {}", name);
                        Some(InputEvent::KeyReleased(name))
                    }
                    _ => None,
                };
                if let Some(ev) = ev {
                    let _ = tx.send(ev);
                }
            }) {
                log::error!("Keyboard listener failed: {:?}", e);
            }
        })
        .expect("failed to spawn keyboard thread");
}

// ── evdev capture (Linux only) ───────────────────────────────

#[cfg(target_os = "linux")]
mod linux_evdev {
    use super::InputEvent;
    use tokio::sync::mpsc::UnboundedSender;

    /// Scans /dev/input/event* for keyboard devices and spawns a reader
    /// thread for each one found.  Returns true if at least one was opened.
    pub fn start(tx: UnboundedSender<InputEvent>) -> bool {
        let mut count = 0;

        for (path, device) in evdev::enumerate() {
            // Only physical keyboards — must support letter keys
            let is_kbd = device
                .supported_keys()
                .map(|k| k.contains(evdev::Key::KEY_A) && k.contains(evdev::Key::KEY_SPACE))
                .unwrap_or(false);

            if !is_kbd {
                continue;
            }

            log::info!("Keyboard device: {:?} ({})",
                path,
                device.name().unwrap_or("unknown"));

            let tx = tx.clone();
            std::thread::Builder::new()
                .name(format!("nput-kb-evdev-{}", count))
                .spawn(move || read_device(device, tx))
                .ok();

            count += 1;
        }

        count > 0
    }

    fn read_device(mut device: evdev::Device, tx: UnboundedSender<InputEvent>) {
        loop {
            let events = match device.fetch_events() {
                Ok(ev) => ev,
                Err(e) => {
                    log::error!("evdev read error: {} — keyboard thread exiting", e);
                    return;
                }
            };

            for ev in events {
                if ev.event_type() != evdev::EventType::KEY {
                    continue;
                }
                // value: 0 = release, 1 = press, 2 = repeat (ignore repeats)
                let value = ev.value();
                if value == 2 {
                    continue;
                }

                let name = match evdev_key_name(ev.code()) {
                    Some(n) => n,
                    None => continue,
                };

                let event = if value == 1 {
                    log::debug!("[KB evdev] ↓ {}", name);
                    InputEvent::KeyPressed(name)
                } else {
                    log::debug!("[KB evdev] ↑ {}", name);
                    InputEvent::KeyReleased(name)
                };

                let _ = tx.send(event);
            }
        }
    }

    /// Maps Linux input keycodes (from linux/input-event-codes.h) to the
    /// same string labels used in layout.json.  Unknown codes are dropped.
    fn evdev_key_name(code: u16) -> Option<String> {
        let s = match code {
            // ── Letters ──────────────────────────────────────
            30 => "A", 48 => "B", 46 => "C", 32 => "D",
            18 => "E", 33 => "F", 34 => "G", 35 => "H",
            23 => "I", 36 => "J", 37 => "K", 38 => "L",
            50 => "M", 49 => "N", 24 => "O", 25 => "P",
            16 => "Q", 19 => "R", 31 => "S", 20 => "T",
            22 => "U", 47 => "V", 17 => "W", 45 => "X",
            21 => "Y", 44 => "Z",

            // ── Number row ───────────────────────────────────
             2 => "1",  3 => "2",  4 => "3",  5 => "4",
             6 => "5",  7 => "6",  8 => "7",  9 => "8",
            10 => "9", 11 => "0", 12 => "-", 13 => "=",
            41 => "`",

            // ── Function keys ─────────────────────────────────
            59 => "F1",  60 => "F2",  61 => "F3",  62 => "F4",
            63 => "F5",  64 => "F6",  65 => "F7",  66 => "F8",
            67 => "F9",  68 => "F10", 87 => "F11", 88 => "F12",

            // ── Modifiers ──────────────────────────────────────
            42 => "Shift",  54 => "ShiftR",
            29 => "Ctrl",   97 => "CtrlR",
            56 => "Alt",   100 => "AltGr",
           125 => "Meta",  126 => "MetaR",

            // ── Navigation ──────────────────────────────────────
           103 => "Up",    108 => "Down",
           105 => "Left",  106 => "Right",
           102 => "Home",  107 => "End",
           104 => "PageUp", 109 => "PageDown",

            // ── Editing ──────────────────────────────────────
            14 => "Backspace",
           111 => "Delete",
           110 => "Insert",
            28 => "Enter",
            15 => "Tab",
            57 => "Space",
             1 => "Escape",
            58 => "CapsLock",

            // ── Punctuation ──────────────────────────────────
            26 => "[",  27 => "]",
            43 => "\\",
            39 => ";",  40 => "'",
            51 => ",",  52 => ".",  53 => "/",

            // ── System ──────────────────────────────────────
            99 => "PrintScreen",
            70 => "ScrollLock",
           119 => "Pause",
            69 => "NumLock",

            // ── Numpad ──────────────────────────────────────
            82 => "Num0", 79 => "Num1", 80 => "Num2",
            81 => "Num3", 75 => "Num4", 76 => "Num5",
            77 => "Num6", 71 => "Num7", 72 => "Num8",
            73 => "Num9",
            83 => "Num.",  98 => "Num/",
            96 => "NumEnter", 74 => "Num-",
            55 => "Num*",  78 => "Num+",

            _ => return None,
        };
        Some(s.to_string())
    }
}

// ── rdev key name mapping ────────────────────────────────────

/// Maps an rdev Key variant to the string label used in layout.json.
fn rdev_key_name(key: Key) -> String {
    use Key::*;
    match key {
        KeyA => "A", KeyB => "B", KeyC => "C", KeyD => "D",
        KeyE => "E", KeyF => "F", KeyG => "G", KeyH => "H",
        KeyI => "I", KeyJ => "J", KeyK => "K", KeyL => "L",
        KeyM => "M", KeyN => "N", KeyO => "O", KeyP => "P",
        KeyQ => "Q", KeyR => "R", KeyS => "S", KeyT => "T",
        KeyU => "U", KeyV => "V", KeyW => "W", KeyX => "X",
        KeyY => "Y", KeyZ => "Z",

        Num0 => "0", Num1 => "1", Num2 => "2", Num3 => "3",
        Num4 => "4", Num5 => "5", Num6 => "6", Num7 => "7",
        Num8 => "8", Num9 => "9",

        Kp0 => "Num0", Kp1 => "Num1", Kp2 => "Num2", Kp3 => "Num3",
        Kp4 => "Num4", Kp5 => "Num5", Kp6 => "Num6", Kp7 => "Num7",
        Kp8 => "Num8", Kp9 => "Num9",
        KpDelete   => "Num.",
        KpDivide   => "Num/",
        KpReturn   => "NumEnter",
        KpMinus    => "Num-",
        KpMultiply => "Num*",
        KpPlus     => "Num+",

        F1  => "F1",  F2  => "F2",  F3  => "F3",  F4  => "F4",
        F5  => "F5",  F6  => "F6",  F7  => "F7",  F8  => "F8",
        F9  => "F9",  F10 => "F10", F11 => "F11", F12 => "F12",

        ShiftLeft    => "Shift",  ShiftRight   => "ShiftR",
        ControlLeft  => "Ctrl",   ControlRight => "CtrlR",
        Alt          => "Alt",    AltGr        => "AltGr",
        MetaLeft     => "Meta",   MetaRight    => "MetaR",

        UpArrow    => "Up",     DownArrow  => "Down",
        LeftArrow  => "Left",   RightArrow => "Right",
        Home       => "Home",   End        => "End",
        PageUp     => "PageUp", PageDown   => "PageDown",

        Backspace => "Backspace",
        Delete    => "Delete",
        Insert    => "Insert",
        Return    => "Enter",
        Tab       => "Tab",
        Space     => "Space",
        Escape    => "Escape",
        CapsLock  => "CapsLock",

        Minus         => "-",
        Equal         => "=",
        LeftBracket   => "[",
        RightBracket  => "]",
        BackSlash     => "\\",
        IntlBackslash => "\\",
        SemiColon     => ";",
        Quote         => "'",
        Comma         => ",",
        Dot           => ".",
        Slash         => "/",
        BackQuote     => "`",

        PrintScreen => "PrintScreen",
        ScrollLock  => "ScrollLock",
        Pause       => "Pause",
        NumLock     => "NumLock",
        Function    => "Fn",

        Unknown(code) => return format!("Key({})", code),
    }
    .to_string()
}
