import type { CharacterState, PointerSample, SpeechMessage } from "./character-state.js";

export interface CodexLoginStatus {
  readonly ok: boolean;
  readonly text: string;
}

export interface CodexSessionSummary {
  readonly id: string;
  readonly filePath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cwd: string;
  readonly source: string;
  readonly isActive: boolean;
}

export interface CodexSessionMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
}

export interface CodexSessionDetail {
  readonly id: string;
  readonly messages: readonly CodexSessionMessage[];
}

export interface PromptSettings {
  readonly mode: "character" | "agent";
  readonly workingDirectory: string;
  readonly userInstructions: string;
}

export interface AppearanceSettings {
  readonly characterScale: number;
  readonly activeSpriteSheetId: string;
  readonly spriteSheets: readonly SpriteSheetSettings[];
  readonly spriteSheetDataUrl: string;
}

export interface AppearanceSettingsInput {
  readonly characterScale: number;
}

export interface SpriteSheetSettings {
  readonly id: string;
  readonly name: string;
  readonly previewDataUrl: string;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export interface SpriteSheetUpload {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface SpriteSheetSaveResult {
  readonly canceled: boolean;
  readonly filePath?: string;
}

export interface ComejiApi {
  readonly onCharacterState: (listener: (state: CharacterState) => void) => () => void;
  readonly onSpeech: (listener: (message: SpeechMessage) => void) => () => void;
  readonly onAppearanceSettings: (listener: (settings: AppearanceSettings) => void) => () => void;
  readonly beginPointerCapture: () => void;
  readonly endPointerCapture: () => void;
  readonly beginDrag: (sample: PointerSample) => void;
  readonly drag: (sample: PointerSample) => void;
  readonly endDrag: (sample: PointerSample) => void;
  readonly reportSpeechBubbleHeight: (height: number) => void;
  readonly openChat: () => void;
  readonly closeChat: () => void;
  readonly submitChat: (message: string) => Promise<void>;
  readonly openSettings: () => void;
  readonly getCodexLoginStatus: () => Promise<CodexLoginStatus>;
  readonly listCodexSessions: () => Promise<readonly CodexSessionSummary[]>;
  readonly getCodexSessionDetail: (id: string) => Promise<CodexSessionDetail>;
  readonly selectCodexSession: (id: string) => Promise<void>;
  readonly clearCodexSession: () => Promise<void>;
  readonly archiveCodexSession: (id: string) => Promise<void>;
  readonly getPromptSettings: () => Promise<PromptSettings>;
  readonly savePromptSettings: (settings: PromptSettings) => Promise<void>;
  readonly getAppearanceSettings: () => Promise<AppearanceSettings>;
  readonly saveAppearanceSettings: (settings: AppearanceSettingsInput) => Promise<AppearanceSettings>;
  readonly uploadSpriteSheet: (upload: SpriteSheetUpload) => Promise<AppearanceSettings>;
  readonly saveActiveSpriteSheet: () => Promise<SpriteSheetSaveResult>;
  readonly selectSpriteSheet: (id: string) => Promise<AppearanceSettings>;
  readonly deleteSpriteSheet: (id: string) => Promise<AppearanceSettings>;
}
