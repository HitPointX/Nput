// ============================================================
// input/mod.rs — Shared event type for the input subsystem
//
// Both keyboard.rs and controller.rs produce InputEvents.
// They get funnelled into a single mpsc channel so main.rs
// can process everything in one place without races.
// ============================================================

pub mod controller;
pub mod keyboard;

/// Every raw input gets normalized into one of these variants
/// before hitting the state manager. No platform specifics leak
/// past this boundary — just clean, named events.
#[derive(Debug, Clone)]
pub enum InputEvent {
    KeyPressed(String),
    KeyReleased(String),

    ButtonPressed(String),
    ButtonReleased(String),

    /// Both trigger values sent together — the controller module
    /// tracks both and always emits the full pair.
    TriggerChanged { lt: f32, rt: f32 },

    /// Full left-stick position. The controller module maintains
    /// both axes locally before emitting so we never get partial updates.
    LeftStickChanged { x: f32, y: f32 },

    /// Same deal for the right stick.
    RightStickChanged { x: f32, y: f32 },
}
