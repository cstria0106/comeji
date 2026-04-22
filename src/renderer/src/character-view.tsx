import { Brain, CircleAlert, FilePenLine, ListChecks, MessageCircle, Search, Terminal, Wrench } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CharacterState, PointerSample, SpeechMessage } from "../../shared/character-state";
import { createCharacterLayout, DefaultCharacterScale } from "../../shared/character-layout";
import type { AppearanceSettings } from "../../shared/shimeji-api";

export function CharacterView(): React.JSX.Element {
  const stageRef = useRef<HTMLElement>(null);
  const spriteRef = useRef<HTMLDivElement>(null);
  const debugRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyCharacterLayoutVars();

    const stage = stageRef.current;
    const sprite = spriteRef.current;
    const debug = debugRef.current;

    if (stage === null || sprite === null || debug === null) {
      return;
    }

    if (window.shimeji === undefined) {
      debug.textContent = "preload missing";
      debug.dataset.visible = "true";
      return;
    }

    void applyAppearanceSettings();

    const unbindCharacterState = bindCharacterState(sprite);
    const unbindPointerGestures = bindPointerGestures(stage);
    const unbindAppearanceSettings = window.shimeji.onAppearanceSettings((settings) => {
      void applyAppearanceSettings(settings);
    });

    return () => {
      unbindCharacterState();
      unbindPointerGestures();
      unbindAppearanceSettings();
    };
  }, []);

  return (
    <main ref={stageRef} className="stage" aria-label="Desktop mate test sprite">
      <SpeechBubble />
      <div ref={debugRef} className="debug" />
      <div ref={spriteRef} className="sprite" role="img" aria-label="Character" />
    </main>
  );
}

async function applyAppearanceSettings(settings?: AppearanceSettings): Promise<void> {
  const nextSettings = settings ?? (await window.shimeji.getAppearanceSettings());
  applyCharacterLayoutVars(nextSettings);
  document.documentElement.style.setProperty("--character-sprite-sheet-url", `url("${nextSettings.spriteSheetDataUrl}")`);
}

function applyCharacterLayoutVars(settings?: Pick<AppearanceSettings, "characterScale">): void {
  const layout = createCharacterLayout(settings?.characterScale ?? DefaultCharacterScale);
  document.documentElement.style.setProperty("--character-image-size", `${layout.imageSize}px`);
  document.documentElement.style.setProperty("--character-scale", `${layout.scale}`);
  document.documentElement.style.setProperty("--character-size", `${layout.displaySize}px`);
  document.documentElement.style.setProperty("--character-padding-top", `${layout.paddingTop}px`);
  document.documentElement.style.setProperty("--character-padding-right", `${layout.paddingRight}px`);
  document.documentElement.style.setProperty("--character-padding-bottom", `${layout.paddingBottom}px`);
  document.documentElement.style.setProperty("--character-padding-left", `${layout.paddingLeft}px`);
  document.documentElement.style.setProperty("--character-window-width", `${layout.windowWidth}px`);
  document.documentElement.style.setProperty("--character-window-height", `${layout.windowHeight}px`);
  document.documentElement.style.setProperty("--grab-origin-x", `${layout.grabImageX}px`);
  document.documentElement.style.setProperty("--grab-origin-y", `${layout.grabImageY}px`);
  document.documentElement.style.setProperty("--grab-origin-display-x", `${layout.grabDisplayX}px`);
  document.documentElement.style.setProperty("--grab-origin-display-y", `${layout.grabDisplayY}px`);
}

function bindCharacterState(spriteElement: HTMLDivElement): () => void {
  function applyState(state: CharacterState): void {
    spriteElement.dataset.motion = state.motion;
    spriteElement.dataset.facing = state.facing;
    spriteElement.style.setProperty("--sprite-rotation", `${state.rotation.toFixed(2)}deg`);
    document.documentElement.style.setProperty("--character-render-x", `${state.renderX}px`);
    document.documentElement.style.setProperty("--character-render-y", `${state.renderY}px`);
  }

  applyState({ facing: "right", motion: "walk", rotation: 0, renderX: 48, renderY: 112 });
  return window.shimeji.onCharacterState(applyState);
}

function SpeechBubble(): React.JSX.Element {
  const [message, setMessage] = useState<SpeechMessage>({ text: "", status: "message" });
  const [visible, setVisible] = useState(false);
  const [visibleText, setVisibleText] = useState("");
  const hideTimeoutRef = useRef<number | undefined>(undefined);
  const typingIntervalRef = useRef<number | undefined>(undefined);

  const stopTyping = useCallback(() => {
    if (typingIntervalRef.current !== undefined) {
      window.clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = undefined;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimeoutRef.current !== undefined) {
      window.clearTimeout(hideTimeoutRef.current);
    }

    hideTimeoutRef.current = window.setTimeout(() => {
      setVisible(false);
    }, 5000);
  }, []);

  useEffect(() => {
    if (window.shimeji === undefined) {
      return;
    }

    const unsubscribe = window.shimeji.onSpeech((nextMessage) => {
      if (hideTimeoutRef.current !== undefined) {
        window.clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = undefined;
      }

      setMessage(nextMessage);
      setVisible(true);

      if (nextMessage.loading === true) {
        stopTyping();
        setVisibleText(nextMessage.text);
      }
    });

    return () => {
      unsubscribe();
      stopTyping();
      if (hideTimeoutRef.current !== undefined) {
        window.clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [stopTyping]);

  useEffect(() => {
    if (message.loading === true) {
      return;
    }

    stopTyping();
    setVisibleText("");
    let nextLength = 0;

    typingIntervalRef.current = window.setInterval(() => {
      nextLength = Math.min(message.text.length, nextLength + 2);
      setVisibleText(message.text.slice(0, nextLength));

      if (nextLength >= message.text.length) {
        stopTyping();
        scheduleHide();
      }
    }, 28);

    return stopTyping;
  }, [message, scheduleHide, stopTyping]);

  const status = message.status ?? "message";
  const Icon = getSpeechIcon(status);

  return (
    <div className="speech" data-visible={visible ? "true" : "false"} data-loading={message.loading === true ? "true" : "false"} data-status={status} aria-live="polite">
      {message.loading === true ? <Icon className="speech-icon" aria-hidden="true" /> : null}
      <span className="speech-text">{visibleText}</span>
    </div>
  );
}

function getSpeechIcon(status: NonNullable<SpeechMessage["status"]>): React.ComponentType<{ readonly className?: string; readonly "aria-hidden"?: "true" }> {
  switch (status) {
    case "thinking":
      return Brain;
    case "command":
      return Terminal;
    case "file":
      return FilePenLine;
    case "todo":
      return ListChecks;
    case "tool":
      return Wrench;
    case "search":
      return Search;
    case "error":
      return CircleAlert;
    case "message":
      return MessageCircle;
  }
}

function bindPointerGestures(stage: HTMLElement): () => void {
  const dragThreshold = 6;
  let start: PointerSample | undefined;
  let latest: PointerSample | undefined;
  let maxDistance = 0;
  let isDragging = false;

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    stage.setPointerCapture(event.pointerId);

    const sample = toPointerSample(event);
    start = sample;
    latest = sample;
    maxDistance = 0;
    isDragging = false;
    window.shimeji.beginPointerCapture();
  }

  function handlePointerMove(event: PointerEvent): void {
    if (start === undefined) {
      return;
    }

    event.preventDefault();

    const sample = toPointerSample(event);
    latest = sample;
    maxDistance = Math.max(maxDistance, distance(start, sample));

    if (!isDragging && maxDistance >= dragThreshold) {
      isDragging = true;
      window.shimeji.beginDrag(sample);
    }

    if (isDragging) {
      window.shimeji.drag(sample);
    }
  }

  function handlePointerUp(event: PointerEvent): void {
    if (start === undefined || latest === undefined) {
      return;
    }

    event.preventDefault();

    const sample = toPointerSample(event);
    const duration = sample.time - start.time;
    const shouldOpenChat = !isDragging && maxDistance < dragThreshold && duration < 500;

    if (isDragging) {
      window.shimeji.endDrag(sample);
    }

    stage.releasePointerCapture(event.pointerId);
    start = undefined;
    latest = undefined;
    isDragging = false;
    window.shimeji.endPointerCapture();

    if (shouldOpenChat) {
      window.shimeji.openChat();
    }
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (start === undefined || latest === undefined) {
      return;
    }

    if (isDragging) {
      window.shimeji.endDrag(toPointerSample(event));
    }

    stage.releasePointerCapture(event.pointerId);
    start = undefined;
    latest = undefined;
    isDragging = false;
    window.shimeji.endPointerCapture();
  }

  stage.addEventListener("pointerdown", handlePointerDown);
  stage.addEventListener("pointermove", handlePointerMove);
  stage.addEventListener("pointerup", handlePointerUp);
  stage.addEventListener("pointercancel", handlePointerCancel);

  return () => {
    stage.removeEventListener("pointerdown", handlePointerDown);
    stage.removeEventListener("pointermove", handlePointerMove);
    stage.removeEventListener("pointerup", handlePointerUp);
    stage.removeEventListener("pointercancel", handlePointerCancel);
  };
}

function toPointerSample(event: MouseEvent | PointerEvent): PointerSample {
  return {
    screenX: event.screenX,
    screenY: event.screenY,
    offsetX: event.clientX,
    offsetY: event.clientY,
    time: performance.now(),
  };
}

function distance(first: PointerSample, second: PointerSample): number {
  return Math.hypot(second.screenX - first.screenX, second.screenY - first.screenY);
}
