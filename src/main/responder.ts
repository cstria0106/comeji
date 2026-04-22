import { dialog } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import readline from "node:readline";
import type { SpeechMessage } from "../shared/character-state.js";
import type { CodexLoginStatus, CodexSessionDetail, CodexSessionMessage, CodexSessionSummary } from "../shared/shimeji-api.js";
import { ConfigFileName, getApplicationBaseDirectory, ShimejiConfigPath, ShimejiDataDirectory } from "./paths.js";
import { buildDeveloperInstructions, getUserInstructions } from "./prompts.js";

type ChatProvider = "local" | "codex";
type CodexMode = "character" | "agent";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type WebSearchMode = "disabled" | "cached" | "live";
type CommandApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
type LegacyReviewDecision = "approved" | "approved_for_session" | "denied" | "abort";

type ShimejiConfig = {
  chatProvider?: ChatProvider;
  appearance?: {
    characterScale?: number;
    activeSpriteSheetId?: string;
    customSpriteSheetPath?: string;
    customSpriteSheetName?: string;
    spriteSheets?: {
      id?: string;
      name?: string;
      path?: string;
    }[];
  };
  codex?: {
    mode?: CodexMode;
    model?: string;
    stateFile?: string;
    developerInstructions?: string;
    userInstructions?: string;
    workingDirectory?: string;
    codexPath?: string;
    skipGitRepoCheck?: boolean;
    sandboxMode?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
    modelReasoningEffort?: ReasoningEffort;
    webSearchMode?: WebSearchMode;
  };
};

type ChatResponder = {
  respond(input: string, onUpdate?: (message: SpeechMessage) => void): Promise<string>;
  dispose?(): void;
};

type ManagedChatResponder = ChatResponder & {
  getThreadId(): string | undefined;
  getKnownThreadIds(): readonly string[];
  selectThread(threadId: string): Promise<void>;
  clearThread(): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  listThreads(): Promise<CodexSessionSummary[]>;
  readThread(threadId: string): Promise<CodexSessionDetail>;
};

type ChatState = {
  codexThreadId?: string;
  knownCodexThreadIds?: string[];
};

type JsonObject = Record<string, unknown>;

type RpcMessage = {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
  };
};

type PendingRequest = {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
};

type AppServerRequestOptions = {
  readonly timeoutMs?: number;
};

type ThreadItem =
  | {
      readonly type: "userMessage";
      readonly id: string;
      readonly content: readonly UserInput[];
    }
  | {
      readonly type: "agentMessage";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly type: "reasoning" | "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "dynamicToolCall" | "collabAgentToolCall" | "plan" | "imageView" | "imageGeneration" | "enteredReviewMode" | "exitedReviewMode" | "contextCompaction" | "hookPrompt";
      readonly id: string;
      readonly [key: string]: unknown;
    };

type UserInput =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: string;
      readonly [key: string]: unknown;
    };

type AppServerThread = {
  readonly id: string;
  readonly preview: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cwd: string;
  readonly source: unknown;
  readonly path: string | null;
  readonly turns: readonly AppServerTurn[];
};

type AppServerTurn = {
  readonly id: string;
  readonly items: readonly ThreadItem[];
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly error: { readonly message?: string } | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
};

type AppServerOptions = {
  readonly commandPath: string;
  readonly workingDirectory: string;
  readonly mode: CodexMode;
  readonly model: string | undefined;
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalPolicy;
  readonly modelReasoningEffort: ReasoningEffort;
  readonly webSearchMode: WebSearchMode;
  readonly developerInstructions: string;
};

const EmptyMessageResponse = "말을 걸어주면 대답할게.";
const DefaultStateFile = join(ShimejiDataDirectory, "chat-state.json");
const PackagedCodexCommandPath = join(process.resourcesPath, "codex", "codex", "codex.exe");
const DevelopmentCodexCommandPath = join(getApplicationBaseDirectory(), "node_modules", ".bin", "codex.cmd");
const MaxShownSessions = 100;
const MaxShownSessionMessages = 80;
const MaxSessionListPages = 20;
const CharacterModeApprovalPolicy: ApprovalPolicy = "never";
const AgentModeApprovalPolicy: ApprovalPolicy = "on-request";
const StatusRequestTimeoutMs = 30_000;
const MaxStatusDetailLength = 96;

export function respondToMessageLocally(input: string): string {
  const message = input.trim();
  const normalized = message.toLocaleLowerCase();

  if (message.length === 0) {
    return EmptyMessageResponse;
  }

  if (normalized.includes("안녕") || normalized.includes("hello") || normalized.includes("hi")) {
    return "안녕. 오늘은 작업표시줄 산책하기 좋은 날이야.";
  }

  if (normalized.includes("이름")) {
    return "아직 이름은 없어. 임시로 시메지라고 불러줘.";
  }

  if (normalized.includes("뭐") || normalized.includes("무엇")) {
    return "나는 지금 걷고, 잡히고, 던져지고, 대화까지 연습하는 중이야.";
  }

  if (normalized.includes("고마")) {
    return "천만에. 다음엔 목소리도 붙여보자.";
  }

  return `"${message}"라고 했구나. 지금은 로컬 응답이지만, 나중엔 LLM이 여기서 이어받으면 돼.`;
}

class LocalChatResponder implements ChatResponder {
  public async respond(input: string, onUpdate?: (message: SpeechMessage) => void): Promise<string> {
    const response = respondToMessageLocally(input);
    onUpdate?.({ text: response, status: "message" });
    return response;
  }
}

class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private lines: readline.Interface | undefined;
  private startPromise: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(message: RpcMessage) => void>();

  public constructor(private readonly options: AppServerOptions) {}

  public dispose(): void {
    for (const request of this.pendingRequests.values()) {
      request.reject(new Error("Codex app-server stopped."));
    }

    this.pendingRequests.clear();
    this.notificationListeners.clear();
    this.lines?.close();
    this.lines = undefined;

    if (this.process !== undefined && !this.process.killed) {
      this.process.kill();
    }

    this.process = undefined;
    this.startPromise = undefined;
  }

  public onNotification(listener: (message: RpcMessage) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public async request(method: string, params: unknown, options: AppServerRequestOptions = {}): Promise<unknown> {
    await this.start();
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return await new Promise((resolve, reject) => {
      const timeoutId =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pendingRequests.delete(id);
              reject(new Error(`Codex app-server request timed out: ${method}`));
            }, options.timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          resolve(result);
        },
        reject: (error) => {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          reject(error);
        },
      });

      try {
        this.send({ method, id, params });
      } catch (error) {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error("Could not send Codex app-server request."));
      }
    });
  }

  private async start(): Promise<void> {
    if (this.startPromise === undefined) {
      this.startPromise = this.startProcess();
    }

    await this.startPromise;
  }

  private async startProcess(): Promise<void> {
    const child = spawnCodexAppServer(this.options.commandPath);
    this.process = child;

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        console.warn(`[codex app-server] ${text}`);
      }
    });

    child.once("exit", (code, signal) => {
      const detail = signal === null ? `code ${code ?? 1}` : `signal ${signal}`;
      const error = new Error(`Codex app-server exited with ${detail}.`);
      for (const request of this.pendingRequests.values()) {
        request.reject(error);
      }

      this.pendingRequests.clear();
      this.process = undefined;
      this.startPromise = undefined;
    });

    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));

    await this.sendInitialHandshake();
  }

  private async sendInitialHandshake(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const id = 0;
      this.pendingRequests.set(id, {
        resolve: () => resolve(),
        reject,
      });
      this.send({
        method: "initialize",
        id,
        params: {
          clientInfo: {
            name: "shimeji",
            title: "Shimeji",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      });
    });

    this.send({
      method: "initialized",
      params: {},
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.warn("Could not parse Codex app-server message.", error);
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    const rpcMessage = message as RpcMessage;
    if (rpcMessage.id !== undefined && rpcMessage.id !== null && rpcMessage.method !== undefined) {
      void this.handleServerRequest(rpcMessage);
      return;
    }

    if (rpcMessage.id !== undefined && rpcMessage.id !== null) {
      this.handleResponse(rpcMessage);
      return;
    }

    for (const listener of this.notificationListeners) {
      listener(rpcMessage);
    }
  }

  private handleResponse(message: RpcMessage): void {
    if (typeof message.id !== "number") {
      return;
    }

    const request = this.pendingRequests.get(message.id);
    if (request === undefined) {
      return;
    }

    this.pendingRequests.delete(message.id);

    if (message.error !== undefined) {
      request.reject(new Error(message.error.message ?? "Codex app-server request failed."));
      return;
    }

    request.resolve(message.result);
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    if (message.id === undefined || message.id === null) {
      return;
    }

    try {
      const result = await respondToServerRequest(message.method ?? "", message.params);
      this.send({ id: message.id, result });
    } catch (error) {
      this.send({
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Could not handle Codex app-server request.",
        },
      });
    }
  }

  private send(message: RpcMessage): void {
    if (this.process === undefined || this.process.killed) {
      throw new Error("Codex app-server is not running.");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

class CodexAppServerResponder implements ManagedChatResponder {
  private readonly stateFilePath: string;
  private readonly workingDirectory: string;
  private readonly mode: CodexMode;
  private readonly options: AppServerOptions;
  private readonly client: CodexAppServerClient;

  public constructor(config: ShimejiConfig) {
    const codexConfig = config.codex ?? {};
    this.stateFilePath = codexConfig.stateFile ?? DefaultStateFile;
    ensureDirectory(dirname(this.stateFilePath));
    this.clearThreadId();

    this.mode = getCodexMode(codexConfig.mode);
    this.workingDirectory = process.env.SHIMEJI_CODEX_WORKDIR ?? codexConfig.workingDirectory ?? getApplicationBaseDirectory();
    this.options = {
      commandPath: process.env.SHIMEJI_CODEX_PATH ?? codexConfig.codexPath ?? getDefaultCodexCommandPath(),
      workingDirectory: this.workingDirectory,
      mode: this.mode,
      model: process.env.SHIMEJI_CODEX_MODEL ?? codexConfig.model,
      sandboxMode: codexConfig.sandboxMode ?? (this.mode === "agent" ? "workspace-write" : "read-only"),
      approvalPolicy: getDefaultApprovalPolicy(this.mode),
      modelReasoningEffort: codexConfig.modelReasoningEffort ?? "low",
      webSearchMode: codexConfig.webSearchMode ?? "disabled",
      developerInstructions: buildDeveloperInstructions(this.mode, getUserInstructions(codexConfig)),
    };
    this.client = new CodexAppServerClient(this.options);
  }

  public dispose(): void {
    this.client.dispose();
  }

  public getThreadId(): string | undefined {
    return this.readThreadId();
  }

  public getKnownThreadIds(): readonly string[] {
    const state = readChatState(this.stateFilePath);
    return Array.from(new Set([...(state.knownCodexThreadIds ?? []), ...(state.codexThreadId !== undefined ? [state.codexThreadId] : [])]));
  }

  public async selectThread(threadId: string): Promise<void> {
    await this.resumeThread(threadId);
    this.writeThreadId(threadId);
  }

  public async clearThread(): Promise<void> {
    this.clearThreadId();
    await this.startThread();
  }

  public async archiveThread(threadId: string): Promise<void> {
    await this.client.request("thread/archive", { threadId });
    this.forgetThreadId(threadId);
  }

  public async listThreads(): Promise<CodexSessionSummary[]> {
    const knownThreadIds = new Set(this.getKnownThreadIds());
    const threads: AppServerThread[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    while (threads.length < knownThreadIds.size && pageCount < MaxSessionListPages) {
      const result = await this.client.request("thread/list", {
        cursor,
        limit: MaxShownSessions,
        sortKey: "updated_at",
        archived: false,
      });
      const page = getThreadListPage(result);
      threads.push(...page.threads.filter((thread) => knownThreadIds.has(thread.id)));
      cursor = page.nextCursor;
      pageCount += 1;

      if (cursor === null) {
        break;
      }
    }

    const activeThreadId = this.getThreadId();

    return threads.map((thread) => ({
      id: thread.id,
      filePath: thread.path ?? "",
      createdAt: timestampFromSeconds(thread.createdAt),
      updatedAt: timestampFromSeconds(thread.updatedAt),
      cwd: thread.cwd,
      source: sourceToString(thread.source),
      isActive: activeThreadId === thread.id,
    }));
  }

  public async readThread(threadId: string): Promise<CodexSessionDetail> {
    const result = await this.client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const thread = getThreadRead(result);
    return {
      id: thread.id,
      messages: getThreadMessages(thread),
    };
  }

  public async respond(input: string, onUpdate?: (message: SpeechMessage) => void): Promise<string> {
    const message = input.trim();

    if (message.length === 0) {
      return EmptyMessageResponse;
    }

    const threadId = this.readThreadId() ?? (await this.startThread());
    const finalResponse = await this.runTurn(threadId, message, onUpdate);
    return finalResponse.trim() || respondToMessageLocally(message);
  }

  public async getLoginStatus(): Promise<CodexLoginStatus> {
    const result = await this.client.request(
      "account/read",
      {
        refreshToken: false,
      },
      { timeoutMs: StatusRequestTimeoutMs },
    );
    const account = isRecord(result) ? result.account : undefined;

    if (isRecord(account) && account.type === "chatgpt") {
      return {
        ok: true,
        text: typeof account.email === "string" ? account.email : "ChatGPT 계정",
      };
    }

    if (isRecord(account) && account.type === "apiKey") {
      return {
        ok: true,
        text: "API key",
      };
    }

    return {
      ok: false,
      text: "Codex 로그인이 필요합니다.",
    };
  }

  private async startThread(): Promise<string> {
    const result = await this.client.request("thread/start", this.createThreadStartParams());
    const thread = getThreadFromResponse(result);
    this.writeThreadId(thread.id);
    return thread.id;
  }

  private async resumeThread(threadId: string): Promise<void> {
    await this.client.request("thread/resume", {
      ...this.createThreadStartParams(),
      threadId,
      persistExtendedHistory: true,
    });
  }

  private async runTurn(threadId: string, message: string, onUpdate?: (message: SpeechMessage) => void): Promise<string> {
    onUpdate?.({ text: "생각중...", loading: true, status: "thinking" });

    let finalResponse = "";
    let startedTurnId: string | undefined;

    const completed = new Promise<string>((resolve, reject) => {
      const unsubscribe = this.client.onNotification((notification) => {
        if (notification.method === "item/agentMessage/delta") {
          const params = notification.params;
          if (isRecord(params) && params.threadId === threadId && typeof params.delta === "string") {
            finalResponse += params.delta;
          }
          return;
        }

        if (notification.method === "item/started" || notification.method === "item/completed") {
          const params = notification.params;
          if (!isRecord(params) || params.threadId !== threadId || !isRecord(params.item)) {
            return;
          }

          const statusMessage = createStatusMessage(params.item);
          if (statusMessage !== undefined) {
            onUpdate?.(statusMessage);
          }

          if (params.item.type === "agentMessage" && typeof params.item.text === "string") {
            finalResponse = params.item.text;
          }
          return;
        }

        if (notification.method === "turn/completed") {
          const params = notification.params;
          if (!isRecord(params) || params.threadId !== threadId || !isRecord(params.turn)) {
            return;
          }

          if (startedTurnId !== undefined && params.turn.id !== startedTurnId) {
            return;
          }

          unsubscribe();

          if (params.turn.status === "failed") {
            const errorMessage = isRecord(params.turn.error) && typeof params.turn.error.message === "string" ? params.turn.error.message : "Codex turn failed.";
            reject(new Error(errorMessage));
            return;
          }

          resolve(finalResponse);
          return;
        }

        if (notification.method === "error") {
          const params = notification.params;
          if (!isRecord(params) || params.threadId !== threadId) {
            return;
          }

          unsubscribe();
          const errorMessage = isRecord(params.error) && typeof params.error.message === "string" ? params.error.message : "Codex app-server error.";
          reject(new Error(errorMessage));
        }
      });
    });

    const startResult = await this.client.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: message,
          text_elements: [],
        },
      ],
      cwd: this.workingDirectory,
      approvalPolicy: this.options.approvalPolicy,
      sandboxPolicy: createSandboxPolicy(this.options.sandboxMode, this.workingDirectory),
      model: this.options.model ?? null,
      effort: this.options.modelReasoningEffort,
      config: {
        web_search: this.options.webSearchMode,
        developer_instructions: this.options.developerInstructions,
      },
    });
    startedTurnId = getTurnId(startResult);
    return await completed;
  }

  private createThreadStartParams(): JsonObject {
    return {
      model: this.options.model ?? null,
      cwd: this.workingDirectory,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandboxMode,
      config: {
        web_search: this.options.webSearchMode,
        model_reasoning_effort: this.options.modelReasoningEffort,
      },
      developerInstructions: this.options.developerInstructions,
      serviceName: "Shimeji",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    };
  }

  private readThreadId(): string | undefined {
    return readChatState(this.stateFilePath).codexThreadId;
  }

  private writeThreadId(threadId: string): void {
    const state = readChatState(this.stateFilePath);
    const knownCodexThreadIds = Array.from(new Set([...(state.knownCodexThreadIds ?? []), threadId]));

    writeChatState(this.stateFilePath, {
      ...state,
      codexThreadId: threadId,
      knownCodexThreadIds,
    });
  }

  private clearThreadId(): void {
    const state = readChatState(this.stateFilePath);
    delete state.codexThreadId;
    writeChatState(this.stateFilePath, state);
  }

  private forgetThreadId(threadId: string): void {
    const state = readChatState(this.stateFilePath);
    const knownCodexThreadIds = (state.knownCodexThreadIds ?? []).filter((id) => id !== threadId);

    if (state.codexThreadId === threadId) {
      delete state.codexThreadId;
    }

    writeChatState(this.stateFilePath, {
      ...state,
      knownCodexThreadIds,
    });
  }
}

function spawnCodexAppServer(commandPath: string): ChildProcessWithoutNullStreams {
  const extension = extname(commandPath).toLocaleLowerCase();
  const cwd = getApplicationBaseDirectory();
  const runtimePathDirectories = getCodexRuntimePathDirectories(commandPath);
  const env = {
    ...process.env,
    PATH: runtimePathDirectories.length > 0 ? [runtimePathDirectories, process.env.PATH ?? ""].flat().filter((entry) => entry.length > 0).join(delimiter) : process.env.PATH,
  };

  if (extension === ".cmd" || extension === ".bat") {
    return spawn("cmd.exe", ["/d", "/c", commandPath, "app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  return spawn(commandPath, ["app-server"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function getDefaultCodexCommandPath(): string {
  if (existsSync(PackagedCodexCommandPath)) {
    return PackagedCodexCommandPath;
  }

  return DevelopmentCodexCommandPath;
}

function getCodexRuntimePathDirectories(commandPath: string): string[] {
  const vendorRoot = dirname(dirname(commandPath));
  const pathDirectory = join(vendorRoot, "path");

  if (!existsSync(pathDirectory)) {
    return [];
  }

  return [pathDirectory];
}

async function respondToServerRequest(method: string, params: unknown): Promise<unknown> {
  if (method === "item/commandExecution/requestApproval") {
    return {
      decision: await requestCommandApproval(params),
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      decision: await requestFileChangeApproval(params),
    };
  }

  if (method === "execCommandApproval") {
    return {
      decision: toLegacyReviewDecision(await requestCommandApproval(params)),
    };
  }

  if (method === "applyPatchApproval") {
    return {
      decision: toLegacyReviewDecision(await requestFileChangeApproval(params)),
    };
  }

  if (method === "item/permissions/requestApproval") {
    return requestPermissionsApproval(params);
  }

  throw new Error(`Unsupported Codex app-server request: ${method}`);
}

async function requestCommandApproval(params: unknown): Promise<CommandApprovalDecision> {
  const record = isRecord(params) ? params : {};
  const command = typeof record.command === "string" ? record.command : "(command unavailable)";
  const cwd = typeof record.cwd === "string" ? record.cwd : "";
  const reason = typeof record.reason === "string" ? record.reason : "";
  const available = getStringArray(record.availableDecisions);
  const decisions = filterDecisions<CommandApprovalDecision>(available, ["accept", "acceptForSession", "decline", "cancel"]);
  const buttons = createApprovalButtons(decisions);
  const messageLines = [
    "Codex가 명령을 실행하려고 해요.",
    "",
    command,
    cwd.length > 0 ? `\n위치: ${cwd}` : "",
    reason.length > 0 ? `\n이유: ${reason}` : "",
  ];
  const response = await dialog.showMessageBox({
    type: "question",
    title: "Codex 명령 승인",
    message: messageLines.join("\n"),
    buttons: buttons.map((button) => button.label),
    cancelId: buttons.findIndex((button) => button.decision === "cancel"),
    defaultId: buttons.findIndex((button) => button.decision === "accept"),
    noLink: true,
  });

  return buttons[response.response]?.decision ?? "cancel";
}

async function requestFileChangeApproval(params: unknown): Promise<FileChangeApprovalDecision> {
  const record = isRecord(params) ? params : {};
  const reason = typeof record.reason === "string" ? record.reason : "";
  const grantRoot = typeof record.grantRoot === "string" ? record.grantRoot : "";
  const available = getStringArray(record.availableDecisions);
  const decisions = filterDecisions<FileChangeApprovalDecision>(available, ["accept", "acceptForSession", "decline", "cancel"]);
  const buttons = createApprovalButtons(decisions);
  const response = await dialog.showMessageBox({
    type: "question",
    title: "Codex 파일 변경 승인",
    message: ["Codex가 파일을 변경하려고 해요.", grantRoot.length > 0 ? `\n허용 경로: ${grantRoot}` : "", reason.length > 0 ? `\n이유: ${reason}` : ""].join("\n"),
    buttons: buttons.map((button) => button.label),
    cancelId: buttons.findIndex((button) => button.decision === "cancel"),
    defaultId: buttons.findIndex((button) => button.decision === "accept"),
    noLink: true,
  });

  return buttons[response.response]?.decision ?? "cancel";
}

async function requestPermissionsApproval(params: unknown): Promise<JsonObject> {
  const record = isRecord(params) ? params : {};
  const reason = typeof record.reason === "string" ? record.reason : "";
  const response = await dialog.showMessageBox({
    type: "question",
    title: "Codex 권한 승인",
    message: ["Codex가 추가 권한을 요청했어요.", reason.length > 0 ? `\n이유: ${reason}` : ""].join("\n"),
    buttons: ["허용", "취소"],
    cancelId: 1,
    defaultId: 0,
    noLink: true,
  });

  if (response.response !== 0 || !isRecord(record.permissions)) {
    return {
      permissions: {},
      scope: "turn",
    };
  }

  const permissions: JsonObject = {};
  if (isRecord(record.permissions.network)) {
    permissions.network = record.permissions.network;
  }

  if (isRecord(record.permissions.fileSystem)) {
    permissions.fileSystem = record.permissions.fileSystem;
  }

  return {
    permissions,
    scope: "turn",
  };
}

function createApprovalButtons<TDecision extends CommandApprovalDecision | FileChangeApprovalDecision>(decisions: readonly TDecision[]): { readonly label: string; readonly decision: TDecision }[] {
  return decisions.map((decision) => ({
    decision,
    label: decision === "accept" ? "허용" : decision === "acceptForSession" ? "세션 동안 허용" : decision === "decline" ? "거절" : "취소",
  }));
}

function filterDecisions<TDecision extends string>(available: readonly string[], defaults: readonly TDecision[]): TDecision[] {
  if (available.length === 0) {
    return [...defaults];
  }

  const availableSet = new Set(available);
  const decisions = defaults.filter((decision) => availableSet.has(decision));
  return decisions.length > 0 ? decisions : [...defaults];
}

function toLegacyReviewDecision(decision: CommandApprovalDecision | FileChangeApprovalDecision): LegacyReviewDecision {
  if (decision === "accept") {
    return "approved";
  }

  if (decision === "acceptForSession") {
    return "approved_for_session";
  }

  if (decision === "decline") {
    return "denied";
  }

  return "abort";
}

function createSandboxPolicy(mode: SandboxMode, workingDirectory: string): JsonObject {
  if (mode === "danger-full-access") {
    return {
      type: "dangerFullAccess",
    };
  }

  if (mode === "read-only") {
    return {
      type: "readOnly",
      access: {
        type: "fullAccess",
      },
      networkAccess: false,
    };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [workingDirectory],
    readOnlyAccess: {
      type: "fullAccess",
    },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readChatState(path: string): ChatState {
  if (!existsSync(path)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as ChatState;
  } catch (error) {
    console.warn(`Could not read chat state from ${path}; starting fresh.`, error);
    return {};
  }
}

function writeChatState(path: string, state: ChatState): void {
  ensureDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getCodexMode(mode: CodexMode | undefined): CodexMode {
  return mode === "agent" ? "agent" : "character";
}

function getDefaultApprovalPolicy(mode: CodexMode): ApprovalPolicy {
  return mode === "agent" ? AgentModeApprovalPolicy : CharacterModeApprovalPolicy;
}

function createStatusMessage(item: JsonObject): SpeechMessage | undefined {
  if (item.type === "reasoning") {
    return { text: createDetailedStatusText("생각중", getFirstStringProperty(item, ["text", "summary"])), loading: true, status: "thinking" };
  }

  if (item.type === "commandExecution") {
    return { text: createDetailedStatusText("명령어 실행중", getCommandStatusDetail(item)), loading: true, status: "command" };
  }

  if (item.type === "fileChange") {
    return { text: createDetailedStatusText("파일 변경중", getFileChangeStatusDetail(item)), loading: true, status: "file" };
  }

  if (item.type === "plan") {
    return { text: createDetailedStatusText("작업 순서 정리중", getPlanStatusDetail(item)), loading: true, status: "todo" };
  }

  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return { text: createDetailedStatusText("도구 호출중", getToolStatusDetail(item)), loading: true, status: "tool" };
  }

  if (item.type === "webSearch") {
    return { text: createDetailedStatusText("검색중", getFirstStringProperty(item, ["query"])), loading: true, status: "search" };
  }

  return undefined;
}

function createDetailedStatusText(prefix: string, detail: string | undefined): string {
  const trimmedDetail = detail?.replace(/\s+/g, " ").trim();
  if (trimmedDetail === undefined || trimmedDetail.length === 0) {
    return `${prefix}...`;
  }

  return `${prefix}: ${truncateStatusDetail(trimmedDetail)}`;
}

function truncateStatusDetail(detail: string): string {
  if (detail.length <= MaxStatusDetailLength) {
    return detail;
  }

  return `${detail.slice(0, MaxStatusDetailLength - 1)}...`;
}

function getCommandStatusDetail(item: JsonObject): string | undefined {
  return getFirstStringProperty(item, ["command", "cmd", "description"]);
}

function getFileChangeStatusDetail(item: JsonObject): string | undefined {
  const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
  const firstPath = changes.map((change) => getFirstStringProperty(change, ["path", "filePath"])).find((path) => path !== undefined);

  if (firstPath === undefined) {
    return getFirstStringProperty(item, ["path", "filePath", "summary"]);
  }

  const remainingCount = changes.length - 1;
  return remainingCount > 0 ? `${firstPath} 외 ${remainingCount}개` : firstPath;
}

function getPlanStatusDetail(item: JsonObject): string | undefined {
  const items = Array.isArray(item.items) ? item.items.filter(isRecord) : [];
  const activeItem = items.find((planItem) => planItem.completed !== true);
  return getFirstStringProperty(activeItem ?? item, ["text", "title", "summary"]);
}

function getToolStatusDetail(item: JsonObject): string | undefined {
  const server = getFirstStringProperty(item, ["server", "serverName"]);
  const tool = getFirstStringProperty(item, ["tool", "toolName", "name"]);

  if (server !== undefined && tool !== undefined) {
    return `${server}.${tool}`;
  }

  return tool ?? server ?? getFirstStringProperty(item, ["description"]);
}

function getFirstStringProperty(record: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function getThreadListPage(result: unknown): { readonly threads: AppServerThread[]; readonly nextCursor: string | null } {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    return {
      threads: [],
      nextCursor: null,
    };
  }

  return {
    threads: result.data.filter(isAppServerThread),
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
  };
}

function getThreadRead(result: unknown): AppServerThread {
  if (!isRecord(result) || !isAppServerThread(result.thread)) {
    throw new Error("Codex thread read returned an unexpected response.");
  }

  return result.thread;
}

function getThreadFromResponse(result: unknown): AppServerThread {
  if (!isRecord(result) || !isAppServerThread(result.thread)) {
    throw new Error("Codex thread response was missing a thread.");
  }

  return result.thread;
}

function getTurnId(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.turn) || typeof result.turn.id !== "string") {
    return undefined;
  }

  return result.turn.id;
}

function isAppServerThread(value: unknown): value is AppServerThread {
  return isRecord(value) && typeof value.id === "string" && typeof value.preview === "string" && typeof value.cwd === "string" && typeof value.createdAt === "number" && typeof value.updatedAt === "number" && Array.isArray(value.turns);
}

function getThreadMessages(thread: AppServerThread): CodexSessionMessage[] {
  const messages: CodexSessionMessage[] = [];

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = item.content
          .map((content) => (content.type === "text" && typeof content.text === "string" ? content.text : ""))
          .filter((part): part is string => part.length > 0)
          .join("\n")
          .trim();
        if (text.length > 0) {
          messages.push({
            role: "user",
            text,
            timestamp: timestampFromSeconds(turn.startedAt ?? thread.createdAt),
          });
        }
      } else if (item.type === "agentMessage" && item.text.trim().length > 0) {
        messages.push({
          role: "assistant",
          text: item.text.trim(),
          timestamp: timestampFromSeconds(turn.completedAt ?? turn.startedAt ?? thread.updatedAt),
        });
      }
    }
  }

  return messages.slice(-MaxShownSessionMessages);
}

function timestampFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function sourceToString(source: unknown): string {
  return typeof source === "string" ? source : JSON.stringify(source);
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfig(): ShimejiConfig {
  try {
    const rawConfig = readFileSync(ShimejiConfigPath, "utf8");
    return JSON.parse(rawConfig) as ShimejiConfig;
  } catch (error) {
    console.warn(`Could not read ${ConfigFileName}; using default chat responder.`, error);
    return {};
  }
}

function createChatResponder(): ChatResponder {
  const config = readConfig();
  const provider = process.env.SHIMEJI_CHAT_PROVIDER ?? config.chatProvider ?? "codex";

  if (provider === "codex") {
    return new CodexAppServerResponder(config);
  }

  return new LocalChatResponder();
}

let chatResponder = createChatResponder();

function isManagedChatResponder(responder: ChatResponder): responder is ManagedChatResponder {
  return "getThreadId" in responder && "getKnownThreadIds" in responder && "selectThread" in responder && "clearThread" in responder && "archiveThread" in responder && "listThreads" in responder && "readThread" in responder;
}

function isCodexAppServerResponder(responder: ChatResponder): responder is CodexAppServerResponder {
  return responder instanceof CodexAppServerResponder;
}

export async function respondToMessage(input: string, onUpdate?: (message: SpeechMessage) => void): Promise<string> {
  try {
    return await chatResponder.respond(input, onUpdate);
  } catch (error) {
    console.error("Chat responder failed; using local fallback.", error);
    const response = respondToMessageLocally(input);
    onUpdate?.({ text: response, status: "message" });
    return response;
  }
}

export async function selectCodexThread(threadId: string): Promise<void> {
  if (!isManagedChatResponder(chatResponder)) {
    return;
  }

  await chatResponder.selectThread(threadId);
}

export async function clearCodexThread(): Promise<void> {
  if (!isManagedChatResponder(chatResponder)) {
    return;
  }

  await chatResponder.clearThread();
}

export async function archiveCodexThread(threadId: string): Promise<void> {
  if (!isManagedChatResponder(chatResponder)) {
    return;
  }

  await chatResponder.archiveThread(threadId);
}

export async function listCodexThreads(): Promise<CodexSessionSummary[]> {
  if (!isManagedChatResponder(chatResponder)) {
    return [];
  }

  return await chatResponder.listThreads();
}

export async function readCodexThread(threadId: string): Promise<CodexSessionDetail> {
  if (!isManagedChatResponder(chatResponder)) {
    throw new Error("Codex is not enabled.");
  }

  return await chatResponder.readThread(threadId);
}

export async function getCodexLoginStatus(): Promise<CodexLoginStatus> {
  if (!isCodexAppServerResponder(chatResponder)) {
    return {
      ok: false,
      text: "Codex provider is not enabled.",
    };
  }

  return await chatResponder.getLoginStatus();
}

export function reloadChatResponder(): void {
  chatResponder.dispose?.();
  chatResponder = createChatResponder();
}

export function disposeChatResponder(): void {
  chatResponder.dispose?.();
}

export { ConfigFileName };
export type { ShimejiConfig };
