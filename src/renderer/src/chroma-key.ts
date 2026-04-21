import GLChromaKey from "gl-chromakey";
import type { AppearanceSettings, SpriteSheetSettings } from "../../shared/shimeji-api";

const ProcessedSpriteSheetCache = new Map<string, string>();

export async function getCachedChromaKeyedSpriteSheet(settings: AppearanceSettings): Promise<string> {
  const activeSpriteSheet = settings.spriteSheets.find((sheet) => sheet.id === settings.activeSpriteSheetId);

  if (activeSpriteSheet === undefined || settings.rawSpriteSheetDataUrl.length === 0) {
    return settings.spriteSheetDataUrl;
  }

  const cacheKey = createCacheKey(settings, activeSpriteSheet);
  const cached = ProcessedSpriteSheetCache.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  try {
    const processed = await processWithGlChromaKey(settings.rawSpriteSheetDataUrl, activeSpriteSheet);
    ProcessedSpriteSheetCache.set(cacheKey, processed);
    return processed;
  } catch (error) {
    console.warn("Could not process sprite sheet with gl-chromakey; using CPU fallback.", error);
    ProcessedSpriteSheetCache.set(cacheKey, settings.spriteSheetDataUrl);
    return settings.spriteSheetDataUrl;
  }
}

function createCacheKey(settings: AppearanceSettings, spriteSheet: SpriteSheetSettings): string {
  return [
    settings.activeSpriteSheetId,
    settings.rawSpriteSheetDataUrl.length,
    spriteSheet.chromaKey,
    spriteSheet.chromaThreshold,
  ].join(":");
}

async function processWithGlChromaKey(dataUrl: string, spriteSheet: SpriteSheetSettings): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const chroma = new GLChromaKey(image, canvas);
  try {
    chroma
      .key({
        color: parseHexColor(spriteSheet.chromaKey),
        tolerance: thresholdToTolerance(spriteSheet.chromaThreshold),
        smoothness: 0.45,
        spill: 0.5,
      })
      .render();
    return canvas.toDataURL("image/png");
  } finally {
    chroma.unload();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return awaitableImage(src);
}

function awaitableImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load sprite sheet image."));
    image.src = src;
  });
}

function parseHexColor(color: string): [number, number, number] {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#ff008e";
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function thresholdToTolerance(threshold: number): number {
  return Math.min(1, Math.max(0, threshold / 64));
}
