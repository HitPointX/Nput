// ============================================================
// state.rs — The single source of truth for all input state
//
// This module owns the mutable state (using HashSets for fast
// lookup) and knows how to serialize it into the wire format
// that the frontend expects.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// --------------- Wire-format structs (match the JSON schema) ---------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyboardState {
    pub pressed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Triggers {
    #[serde(rename = "LT")]
    pub lt: f32,
    #[serde(rename = "RT")]
    pub rt: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StickPosition {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sticks {
    pub left: StickPosition,
    pub right: StickPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControllerState {
    pub buttons: Vec<String>,
    pub triggers: Triggers,
    pub sticks: Sticks,
}

/// The full message sent to the frontend on every state change.
/// Matches the agreed-upon JSON schema exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputMessage {
    pub mode: String,
    pub keyboard: KeyboardState,
    pub controller: ControllerState,
    #[serde(rename = "totalInputs")]
    pub total_inputs: u64,
}

// --------------- Internal mutable state ---------------

/// The live working state. We keep HashSets internally for O(1)
/// press/release operations, then sort-and-collect when serializing.
pub struct State {
    pub mode: String,

    pub keyboard_pressed: HashSet<String>,

    pub controller_buttons: HashSet<String>,
    pub trigger_lt: f32,
    pub trigger_rt: f32,
    pub trigger_lt_pressed: bool, // debounced "is LT over threshold"
    pub trigger_rt_pressed: bool,

    pub left_stick: (f32, f32),
    pub right_stick: (f32, f32),

    /// Persistent — loaded from disk on startup, saved periodically
    pub total_inputs: u64,
}

impl State {
    pub fn new(total_inputs: u64) -> Self {
        State {
            mode: "keyboard".to_string(),
            keyboard_pressed: HashSet::new(),
            controller_buttons: HashSet::new(),
            trigger_lt: 0.0,
            trigger_rt: 0.0,
            trigger_lt_pressed: false,
            trigger_rt_pressed: false,
            left_stick: (0.0, 0.0),
            right_stick: (0.0, 0.0),
            total_inputs,
        }
    }

    /// Serialize the current state into the wire-format message.
    /// Keys and buttons are sorted so the output is deterministic.
    pub fn to_message(&self) -> InputMessage {
        let mut kb_pressed: Vec<String> = self.keyboard_pressed.iter().cloned().collect();
        kb_pressed.sort();

        let mut ctrl_buttons: Vec<String> = self.controller_buttons.iter().cloned().collect();
        ctrl_buttons.sort();

        InputMessage {
            mode: self.mode.clone(),
            keyboard: KeyboardState { pressed: kb_pressed },
            controller: ControllerState {
                buttons: ctrl_buttons,
                triggers: Triggers {
                    lt: round2(self.trigger_lt),
                    rt: round2(self.trigger_rt),
                },
                sticks: Sticks {
                    left: StickPosition {
                        x: round2(self.left_stick.0),
                        y: round2(self.left_stick.1),
                    },
                    right: StickPosition {
                        x: round2(self.right_stick.0),
                        y: round2(self.right_stick.1),
                    },
                },
            },
            total_inputs: self.total_inputs,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.to_message()).unwrap_or_default()
    }
}

/// Round to 2 decimal places — keeps the JSON clean and avoids
/// sending 16-digit floats over the wire for every stick wiggle.
fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}
