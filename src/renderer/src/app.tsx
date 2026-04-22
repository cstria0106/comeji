import * as Tabs from "@radix-ui/react-tabs";
import {
  Bot,
  CheckCircle2,
  Upload,
  MessageSquareText,
  RefreshCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { twMerge } from "tailwind-merge";
import {
  CharacterScaleStep,
  DefaultCharacterScale,
  MaxCharacterScale,
  MinCharacterScale,
} from "../../shared/character-layout";
import type { AppearanceSettings, CodexSessionMessage, CodexSessionSummary, PromptSettings, SpriteSheetSettings } from "../../shared/shimeji-api";
import { CharacterView } from "./character-view";
import { ChatView } from "./chat-view";
import { Button, ModeTooltip, SectionCard, SessionDetail, SessionList, SettingsTab, StatusBox, modeButtonClass } from "./settings-ui";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
const SessionAutoRefreshMs = 15_000;

if (app === null) {
  throw new Error("Missing app root");
}

type Mode = "character" | "chat" | "settings";

function getMode(): Mode {
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "settings" || mode === "chat" ? mode : "character";
}

function App(): React.JSX.Element {
  const mode = getMode();

  if (mode === "settings") {
    return <SettingsView />;
  }

  if (mode === "chat") {
    return <ChatView />;
  }

  return <CharacterView />;
}

createRoot(app).render(<App />);

function SettingsView(): React.JSX.Element {
  const [statusText, setStatusText] = useState("아직 확인하지 않았어요.");
  const [sessions, setSessions] = useState<readonly CodexSessionSummary[]>([]);
  const [messages, setMessages] = useState<readonly CodexSessionMessage[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>();
  const [codexMode, setCodexMode] = useState<PromptSettings["mode"]>("character");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [userInstructions, setUserInstructions] = useState("");
  const [scale, setScale] = useState(DefaultCharacterScale);
  const [spriteSheets, setSpriteSheets] = useState<readonly SpriteSheetSettings[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [busyAction, setBusyAction] = useState<string | undefined>(window.shimeji === undefined ? "preload" : undefined);
  const scalePercent = useMemo(() => `${Math.round(scale * 100)}%`, [scale]);

  const loadSessions = useCallback(async (showLoading = true): Promise<void> => {
    if (window.shimeji === undefined) {
      return;
    }

    if (showLoading) {
      setLoadingSessions(true);
    }
    try {
      setSessions(await window.shimeji.listCodexSessions());
    } catch (error) {
      if (showLoading) {
        setStatusText("세션을 불러오지 못했어요.");
      }
      console.error(error);
    } finally {
      if (showLoading) {
        setLoadingSessions(false);
      }
    }
  }, []);

  function applyAppearanceSettings(settings: AppearanceSettings): void {
    setScale(settings.characterScale);
    setSpriteSheets(settings.spriteSheets);
  }

  useEffect(() => {
    if (window.shimeji === undefined) {
      setStatusText("preload missing");
      return;
    }

    void window.shimeji.getPromptSettings().then((settings) => {
      setCodexMode(settings.mode);
      setWorkingDirectory(settings.workingDirectory);
      setUserInstructions(settings.userInstructions);
    });

    void window.shimeji.getAppearanceSettings().then((settings) => {
      applyAppearanceSettings(settings);
    });

    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (window.shimeji === undefined) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadSessions(false);
    }, SessionAutoRefreshMs);

    return () => window.clearInterval(intervalId);
  }, [loadSessions]);

  async function checkStatus(): Promise<void> {
    if (window.shimeji === undefined) {
      return;
    }

    setBusyAction("status");
    setStatusText("확인하고 있어요.");
    try {
      const status = await window.shimeji.getCodexLoginStatus();
      setStatusText(status.ok ? `로그인됨: ${status.text}` : `확인 실패: ${status.text}`);
    } finally {
      setBusyAction(undefined);
    }
  }

  async function createNewSession(): Promise<void> {
    if (window.shimeji === undefined) {
      return;
    }

    setBusyAction("new-session");
    setStatusText("새 세션으로 바꾸고 있어요.");
    try {
      await window.shimeji.clearCodexSession();
      setMessages([]);
      setSelectedSessionId(undefined);
      setStatusText("새 세션으로 시작할게요.");
      await loadSessions();
    } finally {
      setBusyAction(undefined);
    }
  }

  async function saveCodexSettings(): Promise<void> {
    if (window.shimeji === undefined) {
      return;
    }

    setBusyAction("prompt");
    setStatusText("Codex 설정을 저장하고 있어요.");
    try {
      await window.shimeji.savePromptSettings({
        mode: codexMode,
        workingDirectory,
        userInstructions,
      });
      setStatusText("Codex 설정을 저장했어요. 다음 대화부터 적용돼요.");
      await loadSessions();
    } finally {
      setBusyAction(undefined);
    }
  }

  async function saveAppearance(): Promise<void> {
    if (window.shimeji === undefined) {
      return;
    }

    setBusyAction("appearance");
    setStatusText("외형 설정을 저장하고 있어요.");
    try {
      const settings = await window.shimeji.saveAppearanceSettings({ characterScale: scale });
      applyAppearanceSettings(settings);
      setStatusText("외형 설정을 저장했어요.");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function uploadSpriteSheet(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    if (window.shimeji === undefined) {
      return;
    }

    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (file === undefined) {
      return;
    }

    setBusyAction("sprite-upload");
    setStatusText("스프라이트 시트를 업로드하고 있어요.");
    try {
      const settings = await window.shimeji.uploadSpriteSheet({
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      applyAppearanceSettings(settings);
      setStatusText("스프라이트 시트를 저장했어요.");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function selectSpriteSheet(id: string): Promise<void> {
    if (window.shimeji === undefined) {
      return;
    }

    setBusyAction(`sprite-select-${id}`);
    setStatusText("스프라이트를 바꾸고 있어요.");
    try {
      applyAppearanceSettings(await window.shimeji.selectSpriteSheet(id));
      setStatusText("스프라이트를 적용했어요.");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function deleteSpriteSheet(id: string): Promise<void> {
    if (window.shimeji === undefined || !window.confirm("이 스프라이트 시트를 삭제할까요?")) {
      return;
    }

    setBusyAction(`sprite-delete-${id}`);
    setStatusText("스프라이트를 삭제하고 있어요.");
    try {
      applyAppearanceSettings(await window.shimeji.deleteSpriteSheet(id));
      setStatusText("스프라이트를 삭제했어요.");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    if (window.shimeji === undefined) {
      return;
    }

    setBusyAction(sessionId);
    setStatusText("세션을 선택하고 있어요.");
    setSelectedSessionId(sessionId);
    setMessages([]);
    try {
      await window.shimeji.selectCodexSession(sessionId);
      const detail = await window.shimeji.getCodexSessionDetail(sessionId);
      setMessages(detail.messages);
      setStatusText("세션을 선택하고 내용을 불러왔어요.");
      await loadSessions();
    } finally {
      setBusyAction(undefined);
    }
  }

  async function archiveSession(sessionId: string): Promise<void> {
    if (window.shimeji === undefined || !window.confirm("이 Codex 세션을 보관할까요?")) {
      return;
    }

    setBusyAction(sessionId);
    setStatusText("세션을 보관하고 있어요.");
    try {
      await window.shimeji.archiveCodexSession(sessionId);
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(undefined);
        setMessages([]);
      }
      setStatusText("세션을 보관했어요.");
      await loadSessions();
    } finally {
      setBusyAction(undefined);
    }
  }

  const controlsDisabled = busyAction !== undefined;

  return (
    <main className="min-h-full bg-slate-50 text-slate-950">
      <div className="mx-auto flex h-full max-w-5xl flex-col gap-5 px-6 py-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">설정</h1>
            <p className="mt-1 text-sm text-slate-500">Codex 연결과 캐릭터 동작을 관리해요.</p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm">
            <Sparkles className="size-3.5 text-amber-500" />
            Shimeji
          </div>
        </header>

        <Tabs.Root defaultValue="codex" className="flex min-h-0 flex-1 flex-col gap-4">
          <Tabs.List className="grid h-10 grid-cols-3 rounded-md bg-slate-200/70 p-1 text-sm font-medium text-slate-600">
            <SettingsTab value="codex" icon={<Bot className="size-4" />} label="Codex" />
            <SettingsTab value="character" icon={<MessageSquareText className="size-4" />} label="캐릭터" />
            <SettingsTab value="appearance" icon={<Sparkles className="size-4" />} label="외형" />
          </Tabs.List>

          <Tabs.Content value="codex" className="min-h-0 flex-1">
            <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4">
              <SectionCard
                title="Codex"
                className="h-auto"
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" disabled={controlsDisabled} onClick={() => void checkStatus()}>
                      <CheckCircle2 className="size-4" />
                      상태 확인
                    </Button>
                    <Button type="button" variant="secondary" disabled={controlsDisabled} onClick={() => void loadSessions()}>
                      <RefreshCcw className="size-4" />
                      새로고침
                    </Button>
                    <Button type="button" disabled={controlsDisabled} onClick={() => void createNewSession()}>
                      새 세션
                    </Button>
                  </div>
                }
              >
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
                  <div>
                    <label className="text-sm font-medium text-slate-700">모드</label>
                    <div className="mt-2 grid grid-cols-2 rounded-md bg-slate-100 p-1">
                      <span className="group relative block">
                        <button
                          type="button"
                          className={modeButtonClass(codexMode === "character")}
                          disabled={controlsDisabled}
                          aria-describedby="character-mode-tooltip"
                          onClick={() => setCodexMode("character")}
                        >
                          캐릭터
                        </button>
                        <ModeTooltip id="character-mode-tooltip" text="read-only로 짧게 대화해요." />
                      </span>
                      <span className="group relative block">
                        <button
                          type="button"
                          className={modeButtonClass(codexMode === "agent")}
                          disabled={controlsDisabled}
                          aria-describedby="agent-mode-tooltip"
                          onClick={() => setCodexMode("agent")}
                        >
                          에이전트
                        </button>
                        <ModeTooltip id="agent-mode-tooltip" text="workspace-write로 워크스페이스 안에서 작업해요." />
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-700" htmlFor="codex-workspace">
                      워크스페이스
                    </label>
                    <div className="mt-2 flex gap-2">
                      <input
                        id="codex-workspace"
                        className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200"
                        value={workingDirectory}
                        disabled={controlsDisabled}
                        onChange={(event) => setWorkingDirectory(event.currentTarget.value)}
                      />
                      <Button type="button" disabled={controlsDisabled} onClick={() => void saveCodexSettings()}>
                        저장
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="mt-4">
                  <StatusBox text={statusText} />
                </div>
              </SectionCard>

              <section className="grid min-h-0 grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] gap-4">
                <SectionCard title="세션 목록" className="min-h-0">
                  <SessionList
                    sessions={sessions}
                    selectedSessionId={selectedSessionId}
                    loading={loadingSessions}
                    busyAction={busyAction}
                    onSelect={(sessionId) => void selectSession(sessionId)}
                    onDelete={(sessionId) => void archiveSession(sessionId)}
                  />
                </SectionCard>
                <SectionCard title="세션 내용" className="min-h-0">
                  <SessionDetail messages={messages} selectedSessionId={selectedSessionId} />
                </SectionCard>
              </section>
            </div>
          </Tabs.Content>

          <Tabs.Content value="character" className="min-h-0 flex-1">
            <SectionCard title="사용자 추가 지침">
              <textarea
                className="min-h-56 w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-900 shadow-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200"
                spellCheck={false}
                value={userInstructions}
                disabled={controlsDisabled}
                onChange={(event) => setUserInstructions(event.currentTarget.value)}
              />
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-sm text-slate-500">캐릭터 모드와 에이전트 모드 모두 이 추가 지침을 함께 사용해요.</p>
                <Button type="button" disabled={controlsDisabled} onClick={() => void saveCodexSettings()}>
                  지침 저장
                </Button>
              </div>
            </SectionCard>
          </Tabs.Content>

          <Tabs.Content value="appearance" className="min-h-0 flex-1">
            <SectionCard
              title="외형"
              action={<span className="rounded-md bg-slate-100 px-2.5 py-1 text-sm font-semibold text-slate-700">{scalePercent}</span>}
            >
              <div className="space-y-6">
                <div>
                  <label className="text-sm font-medium text-slate-700" htmlFor="character-scale">
                    캐릭터 크기
                  </label>
                  <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                    <span className="text-xs text-slate-500">작게</span>
                    <input
                      id="character-scale"
                      className="settings-scale-input"
                      type="range"
                      min={MinCharacterScale}
                      max={MaxCharacterScale}
                      step={CharacterScaleStep}
                      value={scale}
                      disabled={controlsDisabled}
                      onChange={(event) => setScale(Number(event.currentTarget.value))}
                    />
                    <span className="text-xs text-slate-500">크게</span>
                  </div>
                </div>

                <div className="min-h-0">
                  <div className="min-h-0">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <span className="text-sm font-medium text-slate-700">스프라이트 시트</span>
                      </div>
                      <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50">
                        <Upload className="size-4" />
                        업로드
                        <input
                          className="sr-only"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={controlsDisabled}
                          onChange={(event) => void uploadSpriteSheet(event)}
                        />
                      </label>
                    </div>
                    <div className="mt-3 grid max-h-72 gap-2 overflow-auto pr-1">
                      {spriteSheets.map((sheet) => (
                        <article
                          key={sheet.id}
                          className={twMerge(
                            "grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-slate-200 bg-white p-2 transition",
                            sheet.isActive && "border-slate-400 bg-slate-50",
                          )}
                        >
                          <div className="flex h-14 items-center justify-center rounded-md border border-slate-200 bg-[linear-gradient(45deg,#f1f5f9_25%,transparent_25%),linear-gradient(-45deg,#f1f5f9_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f1f5f9_75%),linear-gradient(-45deg,transparent_75%,#f1f5f9_75%)] bg-[length:12px_12px] bg-[position:0_0,0_6px,6px_-6px,-6px_0]">
                            {sheet.previewDataUrl.length > 0 ? <img className="max-h-12 max-w-20 object-contain" src={sheet.previewDataUrl} alt="" /> : null}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <strong className="truncate text-sm font-semibold text-slate-950">{sheet.name}</strong>
                              {sheet.isActive ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">사용 중</span> : null}
                            </div>
                            <p className="mt-1 text-xs text-slate-500">{sheet.isDefault ? "기본 스프라이트" : "업로드한 스프라이트"}</p>
                          </div>
                          <div className="flex shrink-0 gap-1.5">
                            <Button
                              type="button"
                              variant="secondary"
                              className="h-8 px-2 text-xs"
                              disabled={controlsDisabled || sheet.isActive}
                              onClick={() => void selectSpriteSheet(sheet.id)}
                            >
                              선택
                            </Button>
                            <Button
                              type="button"
                              variant="danger"
                              className="h-8 px-2"
                              aria-label="스프라이트 삭제"
                              disabled={controlsDisabled || sheet.isDefault}
                              onClick={() => void deleteSpriteSheet(sheet.id)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <Button type="button" disabled={controlsDisabled} onClick={() => void saveAppearance()}>
                  외형 저장
                </Button>
              </div>
            </SectionCard>
          </Tabs.Content>

        </Tabs.Root>
      </div>
    </main>
  );
}
