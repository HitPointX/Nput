// ============================================================
// input/controller.rs — Gamepad / controller listener
//
// Uses gilrs to handle buttons, bumpers, triggers (analog),
// and thumbsticks. Runs in its own blocking thread, polling
// at ~120 Hz.
//
// Linux note: controller access needs the `input` group too.
// Most distros handle this automatically via udev rules,
// but if your pad isn't showing up, check:
//
//   ls -l /dev/input/js*     (should be group: input)
//   groups $USER              (should include: input)
// ============================================================

use super::InputEvent;
use gilrs::{Axis, Button, EventType, Gilrs};
use tokio::sync::mpsc::UnboundedSender;

/// How far a trigger needs to be pressed before we count it.
/// 0.1 = light touch, 0.5 = half press. Tune to taste.
const TRIGGER_THRESHOLD: f32 = 0.1;

/// Ignore stick changes smaller than this — cuts down on noise
/// from a slightly wobbly deadzone.
const STICK_DEADZONE: f32 = 0.08;

/// Spawns the controller listener on a dedicated OS thread.
/// gilrs polling is blocking so it lives in its own thread.
pub fn start(tx: UnboundedSender<InputEvent>) {
    std::thread::Builder::new()
        .name("nput-controller".into())
        .spawn(move || {
            let mut gilrs = match Gilrs::new() {
                Ok(g) => g,
                Err(e) => {
                    log::warn!("Controller init failed (no biggie if no pad is connected): {}", e);
                    return;
                }
            };

            // Log whatever's already plugged in
            for (_id, pad) in gilrs.gamepads() {
                log::info!("Gamepad found: {} — ready to go!", pad.name());
            }

            // Local axis state so we always emit full stick positions
            let mut left  = (0.0f32, 0.0f32);
            let mut right = (0.0f32, 0.0f32);
            let mut lt    = 0.0f32;
            let mut rt    = 0.0f32;

            log::info!("Controller listener started (polling ~120 Hz)");

            loop {
                while let Some(event) = gilrs.next_event() {
                    match event.event {
                        // --- Digital buttons (bumpers, face buttons, d-pad, etc.) ---
                        EventType::ButtonPressed(btn, _) => {
                            let name = button_name(btn);
                            log::info!("Button ↓  {}", name);
                            let _ = tx.send(InputEvent::ButtonPressed(name));
                        }
                        EventType::ButtonReleased(btn, _) => {
                            let name = button_name(btn);
                            log::debug!("Button ↑  {}", name);
                            let _ = tx.send(InputEvent::ButtonReleased(name));
                        }

                        // --- Analog axes: sticks + triggers ---
                        EventType::AxisChanged(axis, value, _) => {
                            match axis {
                                Axis::LeftStickX => {
                                    let v = deadzone(value, STICK_DEADZONE);
                                    if (v - left.0).abs() > 0.01 {
                                        left.0 = v;
                                        log::debug!("LeftStick  x={:.2} y={:.2}", left.0, left.1);
                                        let _ = tx.send(InputEvent::LeftStickChanged { x: left.0, y: left.1 });
                                    }
                                }
                                Axis::LeftStickY => {
                                    let v = deadzone(value, STICK_DEADZONE);
                                    if (v - left.1).abs() > 0.01 {
                                        left.1 = v;
                                        log::debug!("LeftStick  x={:.2} y={:.2}", left.0, left.1);
                                        let _ = tx.send(InputEvent::LeftStickChanged { x: left.0, y: left.1 });
                                    }
                                }
                                Axis::RightStickX => {
                                    let v = deadzone(value, STICK_DEADZONE);
                                    if (v - right.0).abs() > 0.01 {
                                        right.0 = v;
                                        log::debug!("RightStick x={:.2} y={:.2}", right.0, right.1);
                                        let _ = tx.send(InputEvent::RightStickChanged { x: right.0, y: right.1 });
                                    }
                                }
                                Axis::RightStickY => {
                                    let v = deadzone(value, STICK_DEADZONE);
                                    if (v - right.1).abs() > 0.01 {
                                        right.1 = v;
                                        log::debug!("RightStick x={:.2} y={:.2}", right.0, right.1);
                                        let _ = tx.send(InputEvent::RightStickChanged { x: right.0, y: right.1 });
                                    }
                                }
                                // Triggers report as analog axes (0.0 → 1.0)
                                Axis::LeftZ => {
                                    lt = normalize_trigger(value);
                                    log::debug!("LT {:.2}", lt);
                                    let _ = tx.send(InputEvent::TriggerChanged { lt, rt });
                                }
                                Axis::RightZ => {
                                    rt = normalize_trigger(value);
                                    log::debug!("RT {:.2}", rt);
                                    let _ = tx.send(InputEvent::TriggerChanged { lt, rt });
                                }
                                _ => {}
                            }
                        }

                        // Hotplug events — keep the user informed
                        EventType::Connected => {
                            let name = gilrs.gamepad(event.id).name().to_string();
                            log::info!("Gamepad connected: {}", name);
                        }
                        EventType::Disconnected => {
                            log::info!("Gamepad disconnected");
                        }

                        _ => {}
                    }
                }

                // Sleep between polls — 8ms gives us ~120 Hz which is plenty
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
        })
        .expect("failed to spawn controller thread");
}

/// Maps a gilrs Button to a friendly string name.
/// We follow Xbox naming since that's what most people know.
fn button_name(btn: Button) -> String {
    use Button::*;
    match btn {
        South        => "A",
        East         => "B",
        North        => "Y",
        West         => "X",
        LeftTrigger  => "LB",   // bumper
        RightTrigger => "RB",   // bumper
        LeftTrigger2  => "LT",  // trigger pressed as digital
        RightTrigger2 => "RT",  // trigger pressed as digital
        Select       => "Back",
        Start        => "Start",
        Mode         => "Guide",
        LeftThumb    => "LS",
        RightThumb   => "RS",
        DPadUp       => "DUp",
        DPadDown     => "DDown",
        DPadLeft     => "DLeft",
        DPadRight    => "DRight",
        C            => "C",
        Z            => "Z",
        _            => "Unknown",
    }
    .to_string()
}

/// gilrs triggers can arrive as -1.0→1.0 on some drivers.
/// This normalizes them to a clean 0.0→1.0 range.
fn normalize_trigger(v: f32) -> f32 {
    if v < 0.0 {
        (v + 1.0) / 2.0
    } else {
        v.clamp(0.0, 1.0)
    }
}

/// Apply a simple deadzone: values within ±deadzone snap to 0.
fn deadzone(v: f32, dz: f32) -> f32 {
    if v.abs() < dz { 0.0 } else { v }
}

/// Expose the threshold so main.rs can decide when a trigger
/// counts as "pressed" for the input counter.
pub fn trigger_threshold() -> f32 {
    TRIGGER_THRESHOLD
}
