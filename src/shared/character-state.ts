export type Facing = "left" | "right";

export type Motion = "idle" | "walk" | "drag" | "throw" | "talk" | "think";

export interface CharacterState {
  readonly facing: Facing;
  readonly motion: Motion;
  readonly rotation: number;
  readonly renderX: number;
  readonly renderY: number;
}

export interface PointerSample {
  readonly screenX: number;
  readonly screenY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly time: number;
}

export interface SpeechMessage {
  readonly text: string;
  readonly loading?: boolean;
  readonly status?: "thinking" | "command" | "file" | "todo" | "tool" | "search" | "error" | "message";
}
