import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createCharacterLayout,
  DefaultCharacterScale,
  type CharacterLayout,
} from "../shared/character-layout.js";
import type { PointerSample } from "../shared/character-state.js";
import type {
  AppearanceSettings,
  AppearanceSettingsInput,
  PromptSettings,
  SpriteSheetUpload,
} from "../shared/shimeji-api.js";
import { DevServerFilePath, readShimejiConfig, writeShimejiConfig } from "./config.js";
import { getPrimaryDesktopFloor } from "./display.js";
import { DesktopWalker } from "./movement.js";
import { buildDeveloperInstructions, getUserInstructions } from "./prompts.js";
import {
  archiveCodexThread,
  clearCodexThread,
  disposeChatResponder,
  getCodexLoginStatus,
  listCodexThreads,
  readCodexThread,
  reloadChatResponder,
  respondToMessage,
  selectCodexThread,
} from "./responder.js";
import { getApplicationBaseDirectory } from "./paths.js";
import {
  calculateCharacterAabb,
  deleteSpriteSheet,
  getAppearanceSettings,
  saveAppearanceSettings,
  selectSpriteSheet,
  uploadSpriteSheet,
  type CharacterAabb,
} from "./sprites.js";

const ChatWindowWidth = 380;
const ChatWindowHeight = 170;
const ChatWindowVerticalOffset = 4;
const SettingsWindowWidth = 860;
const SettingsWindowHeight = 680;
const PreloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const RendererIndexPath = fileURLToPath(new URL("../../renderer/index.html", import.meta.url));

let characterWindow: BrowserWindow | undefined;
let chatWindow: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let walker: DesktopWalker | undefined;
let characterLayout: CharacterLayout = createCharacterLayout(DefaultCharacterScale);
let characterAabb: CharacterAabb = {
  x: 0,
  y: 0,
  width: characterLayout.displaySize,
  height: characterLayout.displaySize,
};
let keepTalkingAfterChatClose = false;
let characterMouseTimer: NodeJS.Timeout | undefined;
let characterMouseCaptured = false;
let characterMouseIgnoring = false;

function updateCharacterFloor(): void {
  walker?.updateFloor(getPrimaryDesktopFloor(characterLayout.displaySize));
}

function destroyWalker(): void {
  walker?.destroy();
  walker = undefined;
  stopCharacterMouseHitTest();
  screen.off("display-metrics-changed", updateCharacterFloor);
}

async function recreateCharacterWindow(): Promise<void> {
  if (chatWindow !== undefined && !chatWindow.isDestroyed()) {
    closeChatWindow({ keepTalkingAfterClose: false });
  }

  if (characterWindow !== undefined && !characterWindow.isDestroyed()) {
    const windowToClose = characterWindow;
    await new Promise<void>((resolveClosed) => {
      windowToClose.once("closed", resolveClosed);
      windowToClose.close();
    });
  }

  await createCharacterWindow();
}

function isDevMode(): boolean {
  return process.argv.includes("--dev");
}

function getRendererDevUrl(): string {
  const file = JSON.parse(readFileSync(DevServerFilePath, "utf8")) as { readonly url?: unknown };

  if (typeof file.url !== "string" || file.url.length === 0) {
    throw new Error("Missing renderer dev server URL.");
  }

  return file.url;
}

async function loadRenderer(window: BrowserWindow, mode: "character" | "chat" | "settings"): Promise<void> {
  wireRendererDiagnostics(window, mode);

  if (isDevMode()) {
    const url = new URL(getRendererDevUrl());
    url.searchParams.set("mode", mode);
    await window.loadURL(url.toString());
    return;
  }

  await window.loadFile(RendererIndexPath, {
    query: { mode },
  });
}

function wireRendererDiagnostics(window: BrowserWindow, mode: "character" | "chat" | "settings"): void {
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer:${mode}] failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:${mode}] render process gone: ${details.reason}`);
  });

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer:${mode}] ${message} (${sourceId}:${line})`);
    }
  });
}

function startCharacterMouseHitTest(): void {
  if (characterMouseTimer !== undefined) {
    return;
  }

  characterMouseTimer = setInterval(updateCharacterMouseHitTest, 16);
}

function stopCharacterMouseHitTest(): void {
  if (characterMouseTimer !== undefined) {
    clearInterval(characterMouseTimer);
    characterMouseTimer = undefined;
  }

  characterMouseCaptured = false;
  characterMouseIgnoring = false;
}

function updateCharacterMouseHitTest(): void {
  if (characterWindow === undefined || characterWindow.isDestroyed()) {
    return;
  }

  const position = walker?.getScreenPosition();
  if (position === undefined) {
    return;
  }

  const cursor = screen.screenToDipPoint(screen.getCursorScreenPoint());
  const isInsideCharacterAabb =
    cursor.x >= position.x + characterAabb.x &&
    cursor.x <= position.x + characterAabb.x + characterAabb.width &&
    cursor.y >= position.y + characterAabb.y &&
    cursor.y <= position.y + characterAabb.y + characterAabb.height;
  const shouldIgnore = !characterMouseCaptured && !isInsideCharacterAabb;

  if (shouldIgnore === characterMouseIgnoring) {
    return;
  }

  characterMouseIgnoring = shouldIgnore;
  characterWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

async function createCharacterWindow(): Promise<void> {
  const appearance = getAppearanceSettings();
  characterLayout = createCharacterLayout(appearance.characterScale);
  characterAabb = calculateCharacterAabb(characterLayout);
  const floor = getPrimaryDesktopFloor(characterLayout.displaySize);
  const initialCharacterX = floor.x + 40;
  const initialCharacterY = floor.y;

  characterWindow = new BrowserWindow({
    width: characterLayout.windowWidth,
    height: characterLayout.windowHeight,
    x: Math.round(initialCharacterX - characterLayout.paddingLeft),
    y: Math.round(initialCharacterY - characterLayout.paddingTop),
    frame: false,
    resizable: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: PreloadPath,
    },
  });

  characterWindow.setAlwaysOnTop(true, "screen-saver");
  characterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  characterWindow.setMenu(null);
  startCharacterMouseHitTest();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Settings",
      click: () => {
        void openSettingsWindow();
      },
    },
    {
      type: "separator",
    },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  characterWindow.webContents.on("context-menu", () => {
    if (characterWindow !== undefined) {
      contextMenu.popup({ window: characterWindow });
    }
  });

  characterWindow.on("closed", () => {
    characterWindow = undefined;
    destroyWalker();
  });

  await loadRenderer(characterWindow, "character");

  if (characterWindow.isDestroyed()) {
    return;
  }

  walker = new DesktopWalker({
    window: characterWindow,
    floor,
    width: characterLayout.displaySize,
    height: characterLayout.displaySize,
    viewportWidth: characterLayout.windowWidth,
    viewportHeight: characterLayout.windowHeight,
    renderOffsetX: characterLayout.paddingLeft,
    renderOffsetY: characterLayout.paddingTop,
    grabOffsetX: characterLayout.grabDisplayX,
    grabOffsetY: characterLayout.grabDisplayY,
  });
  walker.start();

  screen.on("display-metrics-changed", updateCharacterFloor);
}

function getPromptSettings(): PromptSettings {
  const config = readShimejiConfig();
  const defaultWorkingDirectory = getApplicationBaseDirectory();
  return {
    mode: config.codex?.mode === "agent" ? "agent" : "character",
    workingDirectory: process.env.SHIMEJI_CODEX_WORKDIR ?? config.codex?.workingDirectory ?? defaultWorkingDirectory,
    userInstructions: getUserInstructions(config.codex),
  };
}

function savePromptSettings(settings: PromptSettings): void {
  const config = readShimejiConfig();
  const mode = settings.mode === "agent" ? "agent" : "character";
  const workingDirectory = settings.workingDirectory.trim();
  const defaultWorkingDirectory = getApplicationBaseDirectory();
  const userInstructions = settings.userInstructions.trim();
  const approvalPolicy = config.codex?.approvalPolicy ?? (mode === "agent" ? "on-request" : "never");

  writeShimejiConfig({
    ...config,
    codex: {
      ...config.codex,
      mode,
      workingDirectory: workingDirectory.length > 0 ? workingDirectory : defaultWorkingDirectory,
      userInstructions,
      developerInstructions: buildDeveloperInstructions(mode, userInstructions),
      sandboxMode: mode === "agent" ? "workspace-write" : "read-only",
      approvalPolicy,
    },
  });

  reloadChatResponder();
}

async function openSettingsWindow(): Promise<void> {
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: SettingsWindowWidth,
    height: SettingsWindowHeight,
    minWidth: 760,
    minHeight: 600,
    frame: true,
    resizable: true,
    transparent: false,
    hasShadow: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    title: "Shimeji Settings",
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: PreloadPath,
    },
  });

  settingsWindow.setMenu(null);
  settingsWindow.on("closed", () => {
    settingsWindow = undefined;
  });

  await loadRenderer(settingsWindow, "settings");
  settingsWindow.focus();
}

async function selectCodexSession(id: string): Promise<void> {
  await selectCodexThread(id);
}

async function archiveCodexSession(id: string): Promise<void> {
  await archiveCodexThread(id);
}

async function openChatWindow(): Promise<void> {
  if (characterWindow === undefined || characterWindow.isDestroyed()) {
    return;
  }

  if (walker === undefined) {
    return;
  }

  const motion = walker.getMotion();
  if (motion === "drag" || motion === "throw") {
    return;
  }

  if (chatWindow !== undefined && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return;
  }

  walker.beginThink();
  keepTalkingAfterChatClose = false;
  const position = walker.getScreenPosition();
  const characterCenterX = position.x + characterLayout.displaySize / 2;
  const characterTopY = position.y;
  chatWindow = new BrowserWindow({
    width: ChatWindowWidth,
    height: ChatWindowHeight,
    x: Math.round(characterCenterX - ChatWindowWidth / 2),
    y: Math.max(0, Math.round(characterTopY - ChatWindowHeight + ChatWindowVerticalOffset)),
    frame: false,
    resizable: false,
    transparent: true,
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: PreloadPath,
    },
  });

  chatWindow.setAlwaysOnTop(true, "screen-saver");
  chatWindow.on("closed", () => {
    chatWindow = undefined;
    if (keepTalkingAfterChatClose) {
      keepTalkingAfterChatClose = false;
    } else {
      walker?.endTalk();
    }
  });

  await loadRenderer(chatWindow, "chat");
  chatWindow.focus();
}

function closeChatWindow(options: { readonly keepTalkingAfterClose: boolean }): boolean {
  if (chatWindow === undefined || chatWindow.isDestroyed()) {
    return false;
  }

  keepTalkingAfterChatClose = options.keepTalkingAfterClose;
  chatWindow.close();
  return true;
}

function sendAppearanceSettingsToCharacter(settings: AppearanceSettings): void {
  if (characterWindow === undefined || characterWindow.isDestroyed()) {
    return;
  }

  characterWindow.webContents.send("appearance-settings", settings);
}

function refreshCharacterAabb(): void {
  characterAabb = calculateCharacterAabb(characterLayout);
}

function wireIpc(): void {
  ipcMain.on("pointer-capture-begin", () => {
    characterMouseCaptured = true;
    if (characterWindow !== undefined && !characterWindow.isDestroyed() && characterMouseIgnoring) {
      characterMouseIgnoring = false;
      characterWindow.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on("pointer-capture-end", () => {
    characterMouseCaptured = false;
    updateCharacterMouseHitTest();
  });

  ipcMain.on("drag-begin", (_event, sample: PointerSample) => {
    characterMouseCaptured = true;
    closeChatWindow({ keepTalkingAfterClose: true });
    walker?.beginDrag(sample);
  });

  ipcMain.on("drag-move", (_event, sample: PointerSample) => {
    walker?.drag(sample);
  });

  ipcMain.on("drag-end", (_event, sample: PointerSample) => {
    walker?.endDrag();
    characterMouseCaptured = false;
    updateCharacterMouseHitTest();
  });

  ipcMain.on("speech-layout", (_event, height: number) => {
    walker?.updateSpeechBubbleHeight(height);
  });

  ipcMain.on("chat-open", () => {
    if (chatWindow !== undefined && !chatWindow.isDestroyed()) {
      if (!closeChatWindow({ keepTalkingAfterClose: false })) {
        walker?.endTalk();
      }
      return;
    }

    void openChatWindow();
  });

  ipcMain.on("chat-close", () => {
    if (!closeChatWindow({ keepTalkingAfterClose: false })) {
      walker?.endTalk();
    }
  });

  ipcMain.handle("chat-submit", async (_event, message: string) => {
    walker?.speak({ text: "생각중...", loading: true, status: "thinking" });

    if (chatWindow !== undefined && !chatWindow.isDestroyed()) {
      closeChatWindow({ keepTalkingAfterClose: true });
    }

    let latestResponse = "";
    const response = await respondToMessage(message, (speechMessage) => {
      if (speechMessage.loading !== true) {
        latestResponse = speechMessage.text;
      }

      walker?.speak(speechMessage);
    });

    if (latestResponse !== response) {
      walker?.speak({ text: response });
    }
  });
}

function wireSettingsIpc(): void {
  ipcMain.on("settings-open", () => {
    void openSettingsWindow();
  });

  ipcMain.handle("codex-login-status", async () => {
    const status = await getCodexLoginStatus();

    if (status.ok) {
      walker?.speak({ text: "Codex 로그인이 확인됐어." });
    } else {
      walker?.speak({ text: "Codex 로그인이 아직 안 된 것 같아." });
    }

    return status;
  });

  ipcMain.handle("codex-sessions-list", () => listCodexThreads());

  ipcMain.handle("codex-session-detail", (_event, id: string) => readCodexThread(id));

  ipcMain.handle("codex-session-select", async (_event, id: string) => {
    await selectCodexSession(id);
    walker?.speak({ text: "Codex 세션을 바꿨어." });
  });

  ipcMain.handle("codex-session-clear", async () => {
    await clearCodexThread();
    walker?.speak({ text: "새 Codex 세션으로 시작할게." });
  });

  ipcMain.handle("codex-session-archive", async (_event, id: string) => {
    await archiveCodexSession(id);
    walker?.speak({ text: "Codex 세션을 보관했어." });
  });

  ipcMain.handle("prompt-settings-get", () => getPromptSettings());

  ipcMain.handle("prompt-settings-save", (_event, settings: PromptSettings) => {
    savePromptSettings(settings);
    walker?.speak({ text: "캐릭터 설정을 저장했어." });
  });

  ipcMain.handle("appearance-settings-get", () => getAppearanceSettings());

  ipcMain.handle("appearance-settings-save", async (_event, settings: AppearanceSettingsInput) => {
    const savedSettings = saveAppearanceSettings(settings);
    sendAppearanceSettingsToCharacter(savedSettings);
    await recreateCharacterWindow();
    return savedSettings;
  });

  ipcMain.handle("sprite-sheet-upload", async (_event, upload: SpriteSheetUpload) => {
    const savedSettings = await uploadSpriteSheet(upload);
    refreshCharacterAabb();
    sendAppearanceSettingsToCharacter(savedSettings);
    return savedSettings;
  });

  ipcMain.handle("sprite-sheet-select", async (_event, id: string) => {
    const savedSettings = selectSpriteSheet(id);
    refreshCharacterAabb();
    sendAppearanceSettingsToCharacter(savedSettings);
    return savedSettings;
  });

  ipcMain.handle("sprite-sheet-delete", async (_event, id: string) => {
    const savedSettings = await deleteSpriteSheet(id);
    refreshCharacterAabb();
    sendAppearanceSettingsToCharacter(savedSettings);
    return savedSettings;
  });
}

wireIpc();
wireSettingsIpc();
app.whenReady().then(createCharacterWindow);

app.on("before-quit", () => {
  destroyWalker();
  disposeChatResponder();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
