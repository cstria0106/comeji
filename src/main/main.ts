import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import { execFile } from "node:child_process";
import { readFileSync, type Dirent } from "node:fs";
import { open, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCharacterLayout,
  DefaultCharacterScale,
  type CharacterLayout,
} from "../shared/character-layout.js";
import type { PointerSample } from "../shared/character-state.js";
import type {
  AppearanceSettingsInput,
  CodexLoginStatus,
  CodexSessionDetail,
  CodexSessionMessage,
  CodexSessionSummary,
  PromptSettings,
  SpriteSheetUpdate,
  SpriteSheetUpload,
} from "../shared/shimeji-api.js";
import { DevServerFilePath, readShimejiConfig, writeShimejiConfig } from "./config.js";
import { getPrimaryDesktopFloor } from "./display.js";
import { DesktopWalker } from "./movement.js";
import { buildDeveloperInstructions, getUserInstructions } from "./prompts.js";
import {
  clearCodexThread,
  forgetCodexThread,
  getActiveCodexThreadId,
  getKnownCodexThreadIds,
  reloadChatResponder,
  respondToMessage,
  selectCodexThread,
} from "./responder.js";
import {
  calculateCharacterAabb,
  deleteSpriteSheet,
  getAppearanceSettings,
  saveAppearanceSettings,
  selectSpriteSheet,
  updateSpriteSheet,
  uploadSpriteSheet,
  type CharacterAabb,
} from "./sprites.js";

const ChatWindowWidth = 380;
const ChatWindowHeight = 170;
const SettingsWindowWidth = 860;
const SettingsWindowHeight = 680;
const PreloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const RendererIndexPath = fileURLToPath(new URL("../../renderer/index.html", import.meta.url));
const CodexCommandPath = join(process.cwd(), "node_modules", ".bin", "codex.cmd");
const CodexSessionsRoot = join(homedir(), ".codex", "sessions");
const MaxShownSessions = 100;
const MaxShownSessionMessages = 80;

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
  const workArea = screen.getPrimaryDisplay().workArea;

  characterWindow = new BrowserWindow({
    width: workArea.width,
    height: workArea.height,
    x: workArea.x,
    y: workArea.y,
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
      label: "Pause",
      click: () => walker?.stop(),
    },
    {
      label: "Walk",
      click: () => walker?.start(),
    },
    {
      type: "separator",
    },
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
    viewportX: workArea.x,
    viewportY: workArea.y,
    viewportWidth: workArea.width,
    viewportHeight: workArea.height,
    renderOffsetX: 0,
    renderOffsetY: 0,
    grabOffsetX: characterLayout.grabDisplayX,
    grabOffsetY: characterLayout.grabDisplayY,
  });
  walker.start();

  screen.on("display-metrics-changed", updateCharacterFloor);
}

function createCodexEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
  };
}

function getPromptSettings(): PromptSettings {
  const config = readShimejiConfig();
  return {
    mode: config.codex?.mode === "agent" ? "agent" : "character",
    workingDirectory: process.env.SHIMEJI_CODEX_WORKDIR ?? config.codex?.workingDirectory ?? process.cwd(),
    userInstructions: getUserInstructions(config.codex),
  };
}

function savePromptSettings(settings: PromptSettings): void {
  const config = readShimejiConfig();
  const mode = settings.mode === "agent" ? "agent" : "character";
  const workingDirectory = settings.workingDirectory.trim();
  const userInstructions = settings.userInstructions.trim();

  writeShimejiConfig({
    ...config,
    codex: {
      ...config.codex,
      mode,
      workingDirectory: workingDirectory.length > 0 ? workingDirectory : process.cwd(),
      userInstructions,
      developerInstructions: buildDeveloperInstructions(mode, userInstructions),
      sandboxMode: mode === "agent" ? "workspace-write" : "read-only",
      approvalPolicy: "never",
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

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function getCodexLoginStatus(): Promise<CodexLoginStatus> {
  return await new Promise((resolve) => {
    execFile(
      "cmd.exe",
      ["/d", "/c", CodexCommandPath, "login", "status"],
      {
        cwd: process.cwd(),
        env: createCodexEnvironment(),
        windowsHide: true,
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        const output = stripAnsi(`${stdout}\n${stderr}`).trim();
        resolve({
          ok: error === null,
          text: output.length > 0 ? output : error === null ? "Codex 로그인 상태를 확인했습니다." : "Codex 로그인 상태를 확인하지 못했습니다.",
        });
      },
    );
  });
}

async function collectSessionFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return await collectSessionFiles(fullPath);
      }

      return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
    }),
  );

  return nestedFiles.flat();
}

async function readFirstLine(filePath: string): Promise<string> {
  const file = await open(filePath, "r");
  const buffer = Buffer.alloc(4096);
  let firstLine = "";
  let position = 0;

  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        return firstLine;
      }

      position += bytesRead;
      firstLine += buffer.subarray(0, bytesRead).toString("utf8");

      const newlineIndex = firstLine.search(/\r?\n/);
      if (newlineIndex >= 0) {
        return firstLine.slice(0, newlineIndex);
      }
    }
  } finally {
    await file.close();
  }
}

async function parseSessionSummary(
  filePath: string,
  fileStat: Awaited<ReturnType<typeof stat>>,
  activeThreadId: string | undefined,
): Promise<CodexSessionSummary | undefined> {
  try {
    const firstLine = await readFirstLine(filePath);
    const meta = JSON.parse(firstLine) as {
      payload?: {
        id?: string;
        timestamp?: string;
        cwd?: string;
        source?: string;
      };
    };
    const id = meta.payload?.id;

    if (id === undefined) {
      return undefined;
    }

    return {
      id,
      filePath,
      createdAt: meta.payload?.timestamp ?? fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
      cwd: meta.payload?.cwd ?? "",
      source: meta.payload?.source ?? "",
      isActive: activeThreadId === id,
    };
  } catch (error) {
    console.warn(`Could not parse Codex session: ${filePath}`, error);
    return undefined;
  }
}

function normalizePathForCompare(path: string): string {
  return resolve(path).toLocaleLowerCase();
}

function getConfiguredCodexWorkingDirectory(): string {
  const config = readShimejiConfig();
  return process.env.SHIMEJI_CODEX_WORKDIR ?? config.codex?.workingDirectory ?? process.cwd();
}

async function listCodexSessions(): Promise<CodexSessionSummary[]> {
  const activeThreadId = getActiveCodexThreadId();
  const knownThreadIds = new Set(getKnownCodexThreadIds());
  const targetWorkingDirectory = normalizePathForCompare(getConfiguredCodexWorkingDirectory());
  const filePaths = await collectSessionFiles(CodexSessionsRoot);
  const files = await Promise.all(
    filePaths.map(async (filePath) => ({
      filePath,
      fileStat: await stat(filePath),
    })),
  );
  const sessions: CodexSessionSummary[] = [];

  files.sort((first, second) => second.fileStat.mtimeMs - first.fileStat.mtimeMs);

  for (const file of files) {
    const session = await parseSessionSummary(file.filePath, file.fileStat, activeThreadId);
    if (
      session !== undefined &&
      session.cwd.length > 0 &&
      knownThreadIds.has(session.id) &&
      normalizePathForCompare(session.cwd) === targetWorkingDirectory
    ) {
      sessions.push(session);
    }

    if (sessions.length >= MaxShownSessions) {
      break;
    }
  }

  return sessions;
}

function assertSessionPathInsideRoot(filePath: string): void {
  const root = resolve(CodexSessionsRoot);
  const target = resolve(filePath);
  const pathFromRoot = relative(root, target);

  if (pathFromRoot.startsWith("..") || pathFromRoot === "" || pathFromRoot.includes(":")) {
    throw new Error("Invalid Codex session path.");
  }
}

async function findSessionById(id: string): Promise<CodexSessionSummary> {
  const session = (await listCodexSessions()).find((candidate) => candidate.id === id);

  if (session === undefined) {
    throw new Error(`Codex session not found: ${id}`);
  }

  return session;
}

async function selectCodexSession(id: string): Promise<void> {
  await findSessionById(id);
  selectCodexThread(id);
}

async function deleteCodexSession(id: string): Promise<void> {
  const session = await findSessionById(id);
  assertSessionPathInsideRoot(session.filePath);
  await unlink(session.filePath);

  if (getActiveCodexThreadId() === id) {
    clearCodexThread();
  }

  forgetCodexThread(id);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (typeof item !== "object" || item === null) {
        return "";
      }

      const record = item as Record<string, unknown>;
      const text = record.text ?? record.input_text ?? record.output_text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function createSessionMessageKey(message: CodexSessionMessage): string {
  return `${message.role}\u0000${message.timestamp}\u0000${message.text}`;
}

function parseSessionMessages(filePath: string): CodexSessionMessage[] {
  const messages: CodexSessionMessage[] = [];
  const seenMessages = new Set<string>();
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  function pushMessage(message: CodexSessionMessage): void {
    const key = createSessionMessageKey(message);
    if (seenMessages.has(key)) {
      return;
    }

    seenMessages.add(key);
    messages.push(message);
  }

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as {
        timestamp?: string;
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          content?: unknown;
          message?: string;
        };
      };
      const role = entry.payload?.role;

      if (entry.type === "response_item" && entry.payload?.type === "message" && (role === "user" || role === "assistant")) {
        const text = textFromContent(entry.payload.content).trim();
        if (text.length > 0) {
          pushMessage({
            role,
            text,
            timestamp: entry.timestamp ?? "",
          });
        }
      } else if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
        const text = entry.payload.message?.trim();
        if (text !== undefined && text.length > 0) {
          pushMessage({
            role: "user",
            text,
            timestamp: entry.timestamp ?? "",
          });
        }
      }
    } catch {
      // Ignore malformed lines from old or partial session files.
    }
  }

  return messages.slice(-MaxShownSessionMessages);
}

async function getCodexSessionDetail(id: string): Promise<CodexSessionDetail> {
  const session = await findSessionById(id);
  assertSessionPathInsideRoot(session.filePath);

  return {
    id,
    messages: parseSessionMessages(session.filePath),
  };
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
    y: Math.max(0, Math.round(characterTopY - ChatWindowHeight + 28)),
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

  ipcMain.handle("codex-sessions-list", () => listCodexSessions());

  ipcMain.handle("codex-session-detail", (_event, id: string) => getCodexSessionDetail(id));

  ipcMain.handle("codex-session-select", async (_event, id: string) => {
    await selectCodexSession(id);
    walker?.speak({ text: "Codex 세션을 바꿨어." });
  });

  ipcMain.handle("codex-session-clear", () => {
    clearCodexThread();
    walker?.speak({ text: "새 Codex 세션으로 시작할게." });
  });

  ipcMain.handle("codex-session-delete", async (_event, id: string) => {
    await deleteCodexSession(id);
    walker?.speak({ text: "Codex 세션을 삭제했어." });
  });

  ipcMain.handle("prompt-settings-get", () => getPromptSettings());

  ipcMain.handle("prompt-settings-save", (_event, settings: PromptSettings) => {
    savePromptSettings(settings);
    walker?.speak({ text: "캐릭터 설정을 저장했어." });
  });

  ipcMain.handle("appearance-settings-get", () => getAppearanceSettings());

  ipcMain.handle("appearance-settings-save", async (_event, settings: AppearanceSettingsInput) => {
    const savedSettings = saveAppearanceSettings(settings);
    await recreateCharacterWindow();
    return savedSettings;
  });

  ipcMain.handle("sprite-sheet-upload", async (_event, upload: SpriteSheetUpload) => {
    const savedSettings = await uploadSpriteSheet(upload);
    await recreateCharacterWindow();
    return savedSettings;
  });

  ipcMain.handle("sprite-sheet-select", async (_event, id: string) => {
    const savedSettings = selectSpriteSheet(id);
    await recreateCharacterWindow();
    return savedSettings;
  });

  ipcMain.handle("sprite-sheet-update", async (_event, settings: SpriteSheetUpdate) => {
    const savedSettings = updateSpriteSheet(settings);
    await recreateCharacterWindow();
    return savedSettings;
  });

  ipcMain.handle("sprite-sheet-delete", async (_event, id: string) => {
    const savedSettings = await deleteSpriteSheet(id);
    await recreateCharacterWindow();
    return savedSettings;
  });
}

wireIpc();
wireSettingsIpc();
app.whenReady().then(createCharacterWindow);

app.on("before-quit", () => {
  destroyWalker();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
