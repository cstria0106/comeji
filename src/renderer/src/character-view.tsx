import { Brain, CircleAlert, FilePenLine, ListChecks, MessageCircle, Search, Terminal, Wrench } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CharacterState, PointerSample, SpeechMessage } from "../../shared/character-state";
import { createCharacterLayout, DefaultCharacterScale } from "../../shared/character-layout";
import type { AppearanceSettings } from "../../shared/comeji-api";

export function CharacterView(): React.JSX.Element {
  const stageRef = useRef<HTMLElement>(null);
  const spriteRef = useRef<HTMLCanvasElement>(null);
  const debugRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyCharacterLayoutVars();

    const stage = stageRef.current;
    const sprite = spriteRef.current;
    const debug = debugRef.current;

    if (stage === null || sprite === null || debug === null) {
      return;
    }

    if (window.comeji === undefined) {
      debug.textContent = "preload missing";
      debug.dataset.visible = "true";
      return;
    }

    const spriteRenderer = createSpriteRenderer(sprite);

    void applyAppearanceSettings(undefined, spriteRenderer);

    const unbindCharacterState = bindCharacterState(sprite, spriteRenderer);
    const unbindPointerGestures = bindPointerGestures(stage);
    const unbindAppearanceSettings = window.comeji.onAppearanceSettings((settings) => {
      void applyAppearanceSettings(settings, spriteRenderer);
    });

    return () => {
      unbindCharacterState();
      unbindPointerGestures();
      unbindAppearanceSettings();
      spriteRenderer.dispose();
    };
  }, []);

  return (
    <main ref={stageRef} className="stage" aria-label="Desktop mate test sprite">
      <SpeechBubble />
      <div ref={debugRef} className="debug" />
      <canvas ref={spriteRef} className="sprite" role="img" aria-label="Character" />
    </main>
  );
}

async function applyAppearanceSettings(settings?: AppearanceSettings, spriteRenderer?: SpriteRenderer): Promise<void> {
  const nextSettings = settings ?? (await window.comeji.getAppearanceSettings());
  applyCharacterLayoutVars(nextSettings);
  document.documentElement.style.setProperty("--character-sprite-sheet-url", `url("${nextSettings.spriteSheetDataUrl}")`);
  spriteRenderer?.setAppearance(nextSettings);
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

interface SpriteRenderer {
  readonly setAppearance: (settings: AppearanceSettings) => void;
  readonly setState: (state: CharacterState) => void;
  readonly dispose: () => void;
}

function createSpriteRenderer(canvas: HTMLCanvasElement): SpriteRenderer {
  let image: HTMLImageElement | undefined;
  let imageLoadId = 0;
  let latestSettings: AppearanceSettings | undefined;
  let latestState: CharacterState = { facing: "right", motion: "walk", rotation: 0, renderX: 48, renderY: 112 };

  function setAppearance(settings: AppearanceSettings): void {
    latestSettings = settings;
    const loadId = imageLoadId + 1;
    imageLoadId = loadId;
    const nextImage = new Image();

    nextImage.onload = () => {
      if (imageLoadId !== loadId) {
        return;
      }

      image = nextImage;
      draw();
    };

    nextImage.src = settings.spriteSheetDataUrl;
    draw();
  }

  function setState(state: CharacterState): void {
    latestState = state;
    canvas.dataset.motion = state.motion;
    canvas.dataset.facing = state.facing;
    canvas.style.setProperty("--sprite-rotation", `${state.rotation.toFixed(2)}deg`);
    draw();
  }

  function draw(): void {
    const layout = createCharacterLayout(latestSettings?.characterScale ?? DefaultCharacterScale);
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const canvasSize = Math.max(1, Math.round(layout.displaySize * pixelRatio));

    if (canvas.width !== canvasSize || canvas.height !== canvasSize) {
      canvas.width = canvasSize;
      canvas.height = canvasSize;
    }

    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);

    if (image === undefined || !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) {
      return;
    }

    const frameCount = 6;
    const sourceWidth = image.naturalWidth / frameCount;
    const sourceHeight = image.naturalHeight;
    const frameIndex = getSpriteFrameIndex(latestState.motion);

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sourceWidth * frameIndex, 0, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  }

  return {
    setAppearance,
    setState,
    dispose() {
      imageLoadId += 1;
    },
  };
}

function getSpriteFrameIndex(motion: CharacterState["motion"]): number {
  switch (motion) {
    case "idle":
    case "talk":
      return 0;
    case "walk":
      return 1;
    case "think":
      return 2;
    case "drag":
      return 3;
    case "throw":
      return 5;
  }
}

function bindCharacterState(spriteElement: HTMLCanvasElement, spriteRenderer: SpriteRenderer): () => void {
  function applyState(state: CharacterState): void {
    spriteRenderer.setState(state);
    document.documentElement.style.setProperty("--character-render-x", `${state.renderX}px`);
    document.documentElement.style.setProperty("--character-render-y", `${state.renderY}px`);
  }

  applyState({ facing: "right", motion: "walk", rotation: 0, renderX: 48, renderY: 112 });
  return window.comeji.onCharacterState(applyState);
}

function SpeechBubble(): React.JSX.Element {
  const speechRef = useRef<HTMLDivElement>(null);
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

  const reportSpeechHeight = useCallback(() => {
    const speech = speechRef.current;
    if (speech === null || window.comeji === undefined) {
      return;
    }

    window.comeji.reportSpeechBubbleHeight(speech.dataset.visible === "true" ? speech.scrollHeight : 0);
  }, []);

  useEffect(() => {
    if (window.comeji === undefined) {
      return;
    }

    const unsubscribe = window.comeji.onSpeech((nextMessage) => {
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

  useEffect(() => {
    const speech = speechRef.current;
    if (speech === null) {
      return;
    }

    const observer = new ResizeObserver(reportSpeechHeight);
    observer.observe(speech);
    reportSpeechHeight();

    return () => observer.disconnect();
  }, [reportSpeechHeight]);

  useEffect(() => {
    reportSpeechHeight();
  }, [message, visible, visibleText, reportSpeechHeight]);

  const status = message.status ?? "message";
  const Icon = getSpeechIcon(status);

  return (
    <div ref={speechRef} className="speech" data-visible={visible ? "true" : "false"} data-loading={message.loading === true ? "true" : "false"} data-status={status} aria-live="polite">
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
    window.comeji.beginPointerCapture();
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
      window.comeji.beginDrag(sample);
    }

    if (isDragging) {
      window.comeji.drag(sample);
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
      window.comeji.endDrag(sample);
    }

    stage.releasePointerCapture(event.pointerId);
    start = undefined;
    latest = undefined;
    isDragging = false;
    window.comeji.endPointerCapture();

    if (shouldOpenChat) {
      window.comeji.openChat();
    }
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (start === undefined || latest === undefined) {
      return;
    }

    if (isDragging) {
      window.comeji.endDrag(toPointerSample(event));
    }

    stage.releasePointerCapture(event.pointerId);
    start = undefined;
    latest = undefined;
    isDragging = false;
    window.comeji.endPointerCapture();
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
