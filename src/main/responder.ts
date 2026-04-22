import { Codex, type CodexOptions, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpeechMessage } from "../shared/character-state.js";
import { buildDeveloperInstructions, getUserInstructions } from "./prompts.js";

type ChatProvider = "local" | "codex";
type CodexMode = "character" | "agent";

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
    sandboxMode?: ThreadOptions["sandboxMode"];
    approvalPolicy?: ThreadOptions["approvalPolicy"];
    modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
    webSearchMode?: ThreadOptions["webSearchMode"];
  };
};

type ChatResponder = {
  respond(input: string, onUpdate?: (message: SpeechMessage) => void): Promise<string>;
};

type ManagedChatResponder = ChatResponder & {
  getThreadId(): string | undefined;
  getKnownThreadIds(): readonly string[];
  selectThread(threadId: string): void;
  clearThread(): void;
  forgetThread(threadId: string): void;
};

type ChatState = {
  codexThreadId?: string;
  knownCodexThreadIds?: string[];
};

const EmptyMessageResponse = "말을 걸어주면 대답할게.";
const ConfigFileName = "shimeji.config.json";
const DefaultDataDirectory = ".shimeji";
const DefaultStateFile = join(DefaultDataDirectory, "chat-state.json");
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

class CodexChatResponder implements ChatResponder {
  private readonly codex: Codex;
  private thread: Thread;
  private readonly stateFilePath: string;
  private readonly threadOptions: ThreadOptions;

  public constructor(config: ShimejiConfig) {
    const codexConfig = config.codex ?? {};
    this.stateFilePath = codexConfig.stateFile ?? join(process.cwd(), DefaultStateFile);
    ensureDirectory(dirname(this.stateFilePath));

    const mode = getCodexMode(codexConfig.mode);
    const codexOptions: CodexOptions = {
      config: {
        developer_instructions: buildDeveloperInstructions(mode, getUserInstructions(codexConfig)),
      },
    };

    const codexPath = process.env.SHIMEJI_CODEX_PATH ?? codexConfig.codexPath;
    if (codexPath !== undefined) {
      codexOptions.codexPathOverride = codexPath;
    }

    this.codex = new Codex(codexOptions);
    this.threadOptions = {
      workingDirectory: process.env.SHIMEJI_CODEX_WORKDIR ?? codexConfig.workingDirectory ?? process.cwd(),
      sandboxMode: mode === "agent" ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      modelReasoningEffort: codexConfig.modelReasoningEffort ?? "low",
      webSearchMode: codexConfig.webSearchMode ?? "disabled",
      skipGitRepoCheck: process.env.SHIMEJI_CODEX_SKIP_GIT_CHECK === "1" || codexConfig.skipGitRepoCheck === true,
    };

    const model = process.env.SHIMEJI_CODEX_MODEL ?? codexConfig.model;
    if (model !== undefined) {
      this.threadOptions.model = model;
    }

    this.thread = this.createThread();
  }

  public getThreadId(): string | undefined {
    return this.readThreadId();
  }

  public getKnownThreadIds(): readonly string[] {
    const state = readChatState(this.stateFilePath);
    return Array.from(new Set([...(state.knownCodexThreadIds ?? []), ...(state.codexThreadId !== undefined ? [state.codexThreadId] : [])]));
  }

  public selectThread(threadId: string): void {
    this.writeThreadId(threadId);
    this.thread = this.codex.resumeThread(threadId, this.threadOptions);
  }

  public clearThread(): void {
    this.clearThreadId();
    this.thread = this.codex.startThread(this.threadOptions);
  }

  public forgetThread(threadId: string): void {
    const state = readChatState(this.stateFilePath);
    const knownCodexThreadIds = (state.knownCodexThreadIds ?? []).filter((id) => id !== threadId);

    if (state.codexThreadId === threadId) {
      delete state.codexThreadId;
      this.thread = this.codex.startThread(this.threadOptions);
    }

    writeChatState(this.stateFilePath, {
      ...state,
      knownCodexThreadIds,
    });
  }

  public async respond(input: string, onUpdate?: (message: SpeechMessage) => void): Promise<string> {
    const message = input.trim();

    if (message.length === 0) {
      return EmptyMessageResponse;
    }

    const codexInput = [{ type: "text" as const, text: createCodexInput(message) }];

    let result;
    try {
      result = await this.runWithStreaming(codexInput, onUpdate);
    } catch (error) {
      if (this.readThreadId() === undefined) {
        throw error;
      }

      console.warn("Could not resume saved Codex thread; starting a new one.", error);
      this.clearThreadId();
      this.thread = this.codex.startThread(this.threadOptions);
      result = await this.runWithStreaming(codexInput, onUpdate);
    }

    if (this.thread.id !== null) {
      this.writeThreadId(this.thread.id);
    }

    return result.finalResponse.trim() || respondToMessageLocally(message);
  }

  private async runWithStreaming(input: { type: "text"; text: string }[], onUpdate?: (message: SpeechMessage) => void): Promise<{ finalResponse: string }> {
    const streamed = await this.thread.runStreamed(input, {
      signal: AbortSignal.timeout(45_000),
    });
    let finalResponse = "";
    let turnFailure: string | undefined;

    for await (const event of streamed.events) {
      if (event.type === "turn.started") {
        onUpdate?.({ text: "생각중...", loading: true, status: "thinking" });
      } else if (event.type === "turn.completed") {
        onUpdate?.({ text: "생각중...", loading: true, status: "thinking" });
      } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
        const statusMessage = createStatusMessage(event.item);
        if (statusMessage !== undefined) {
          onUpdate?.(statusMessage);
        }

        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
          if (finalResponse.trim().length > 0) {
            if (process.env.SHIMEJI_DEBUG_STREAM === "1") {
              console.log(`Codex stream ${event.type}: ${finalResponse.length} chars`);
            }
          }
        }
      } else if (event.type === "turn.failed") {
        turnFailure = event.error.message;
        onUpdate?.({ text: "작업이 실패했어요.", loading: true, status: "error" });
        break;
      } else if (event.type === "error") {
        turnFailure = event.message;
        onUpdate?.({ text: "오류가 발생했어요.", loading: true, status: "error" });
        break;
      }
    }

    if (turnFailure !== undefined) {
      throw new Error(turnFailure);
    }

    return { finalResponse };
  }

  private createThread(): Thread {
    return this.codex.startThread(this.threadOptions);
  }

  private readThreadId(): string | undefined {
    const state = readChatState(this.stateFilePath);
    return state.codexThreadId;
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

function createCodexInput(message: string): string {
  return message;
}

function createStatusMessage(item: { readonly type: string }): SpeechMessage | undefined {
  if (item.type === "reasoning") {
    return { text: "생각중...", loading: true, status: "thinking" };
  }

  if (item.type === "command_execution") {
    return { text: "명령어 실행중...", loading: true, status: "command" };
  }

  if (item.type === "file_change") {
    return { text: "파일 변경중...", loading: true, status: "file" };
  }

  if (item.type === "todo_list") {
    return { text: "작업 순서 정리중...", loading: true, status: "todo" };
  }

  if (item.type === "mcp_tool_call") {
    return { text: "도구 호출중...", loading: true, status: "tool" };
  }

  if (item.type === "web_search") {
    return { text: "검색중...", loading: true, status: "search" };
  }

  if (item.type === "error") {
    return { text: "오류를 확인하는 중...", loading: true, status: "error" };
  }

  return undefined;
}

function readConfig(): ShimejiConfig {
  try {
    const configPath = join(process.cwd(), ConfigFileName);
    const rawConfig = readFileSync(configPath, "utf8");
    return JSON.parse(rawConfig) as ShimejiConfig;
  } catch (error) {
    console.warn(`Could not read ${ConfigFileName}; using local chat responder.`, error);
    return {};
  }
}

function createChatResponder(): ChatResponder {
  const config = readConfig();
  const provider = process.env.SHIMEJI_CHAT_PROVIDER ?? config.chatProvider ?? "local";

  if (provider === "codex") {
    return new CodexChatResponder(config);
  }

  return new LocalChatResponder();
}

let chatResponder = createChatResponder();

function isManagedChatResponder(responder: ChatResponder): responder is ManagedChatResponder {
  return "getThreadId" in responder && "getKnownThreadIds" in responder && "selectThread" in responder && "clearThread" in responder && "forgetThread" in responder;
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

export function getActiveCodexThreadId(): string | undefined {
  if (!isManagedChatResponder(chatResponder)) {
    return undefined;
  }

  return chatResponder.getThreadId();
}

export function getKnownCodexThreadIds(): readonly string[] {
  if (!isManagedChatResponder(chatResponder)) {
    return [];
  }

  return chatResponder.getKnownThreadIds();
}

export function selectCodexThread(threadId: string): void {
  if (!isManagedChatResponder(chatResponder)) {
    return;
  }

  chatResponder.selectThread(threadId);
}

export function clearCodexThread(): void {
  if (!isManagedChatResponder(chatResponder)) {
    return;
  }

  chatResponder.clearThread();
}

export function forgetCodexThread(threadId: string): void {
  if (!isManagedChatResponder(chatResponder)) {
    return;
  }

  chatResponder.forgetThread(threadId);
}

export function reloadChatResponder(): void {
  chatResponder = createChatResponder();
}

export { ConfigFileName };
export type { ShimejiConfig };
