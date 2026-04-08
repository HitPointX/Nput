// ============================================================
// schema.ts — Shared type definitions
//
// This is the contract between backend and frontend.
// If you change the JSON shape, update it here first.
// ============================================================

export interface StickPosition {
  x: number; // -1.0 to 1.0
  y: number; // -1.0 to 1.0
}

export interface Sticks {
  left:  StickPosition;
  right: StickPosition;
}

export interface Triggers {
  LT: number; // 0.0 (not pressed) to 1.0 (full press)
  RT: number;
}

export interface ControllerState {
  buttons:  string[];   // e.g. ["A", "LB", "DUp"]
  triggers: Triggers;
  sticks:   Sticks;
}

export interface KeyboardState {
  pressed: string[]; // e.g. ["W", "Shift", "Space"]
}

export type Mode = 'keyboard' | 'controller';

/** The full message broadcast by the Rust backend at every state change. */
export interface InputMessage {
  mode:        Mode;
  keyboard:    KeyboardState;
  controller:  ControllerState;
  totalInputs: number; // persisted across sessions
}
