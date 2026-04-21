import { nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { DefaultCharacterScale, createCharacterLayout, type CharacterLayout } from "../shared/character-layout.js";
import type {
  AppearanceSettings,
  AppearanceSettingsInput,
  SpriteSheetSettings,
  SpriteSheetUpdate,
  SpriteSheetUpload,
} from "../shared/shimeji-api.js";
import { readShimejiConfig, SpriteSheetsDirectory, writeShimejiConfig } from "./config.js";
import type { ShimejiConfig } from "./responder.js";

const DefaultSpriteSheetId = "default";
const DefaultSpriteSheetPath = join(process.cwd(), "src", "renderer", "src", "assets", "character.png");
const DefaultSpriteChromaKey = "#ff008e";
const SpriteSheetFrameCount = 4;
const DefaultChromaKeyThreshold = 8;
const MinChromaKeyThreshold = 0;
const MaxChromaKeyThreshold = 64;
const MinChromaKeySmoothness = 4;

export interface CharacterAabb {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

interface RgbaColor extends RgbColor {
  readonly alpha: number;
}

interface HsvColor {
  readonly hue: number;
  readonly saturation: number;
  readonly value: number;
}

interface SpriteSheetDefinition {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly chromaKey: string;
  readonly chromaThreshold: number;
  readonly isDefault: boolean;
}

export function calculateCharacterAabb(characterLayout: CharacterLayout): CharacterAabb {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const activeSpriteSheet = getActiveSpriteSheetDefinition(readShimejiConfig());
  const spriteSheetPath = activeSpriteSheet.path;
  let image = nativeImage.createFromPath(spriteSheetPath);
  let size = image.getSize();

  if ((image.isEmpty() || size.width === 0 || size.height === 0) && spriteSheetPath !== DefaultSpriteSheetPath) {
    image = nativeImage.createFromPath(DefaultSpriteSheetPath);
    size = image.getSize();
  }

  if (image.isEmpty() || size.width === 0 || size.height === 0) {
    console.warn(`Could not read character sprite sheet for AABB: ${spriteSheetPath}`);
    return {
      x: 0,
      y: 0,
      width: characterLayout.displaySize,
      height: characterLayout.displaySize,
    };
  }

  const chromaKey = parseHexColor(activeSpriteSheet.chromaKey);
  const frameWidth = Math.max(1, Math.floor(size.width / SpriteSheetFrameCount));
  const bitmap = image.toBitmap();

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const pixelOffset = (y * size.width + x) * 4;
      const blue = bitmap[pixelOffset];
      const green = bitmap[pixelOffset + 1];
      const red = bitmap[pixelOffset + 2];
      const alpha = bitmap[pixelOffset + 3];

      if (
        blue === undefined ||
        green === undefined ||
        red === undefined ||
        alpha === undefined ||
        alpha === 0
      ) {
        continue;
      }

      const mask = createChromaMask({ red, green, blue, alpha }, chromaKey, activeSpriteSheet.chromaThreshold);
      if (mask.alphaMultiplier === 0) {
        continue;
      }

      const frameX = x % frameWidth;
      minX = Math.min(minX, frameX);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, frameX);
      maxY = Math.max(maxY, y);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return {
      x: 0,
      y: 0,
      width: characterLayout.displaySize,
      height: characterLayout.displaySize,
    };
  }

  return {
    x: minX * characterLayout.scale,
    y: minY * characterLayout.scale,
    width: (maxX - minX + 1) * characterLayout.scale,
    height: (maxY - minY + 1) * characterLayout.scale,
  };
}

export function getAppearanceSettings(): AppearanceSettings {
  const config = readShimejiConfig();
  const spriteSheets = getSpriteSheetDefinitions(config);
  const activeSpriteSheetId = getActiveSpriteSheetId(config, spriteSheets);
  const activeSpriteSheet = getActiveSpriteSheetDefinition(config);

  return {
    characterScale: config.appearance?.characterScale ?? DefaultCharacterScale,
    activeSpriteSheetId,
    spriteSheets: spriteSheets.map((sheet) => toSpriteSheetSettings(sheet, activeSpriteSheetId)),
    spriteSheetDataUrl: createSpriteSheetDataUrl(activeSpriteSheet),
    rawSpriteSheetDataUrl: createRawSpriteSheetDataUrl(activeSpriteSheet),
  };
}

export function saveAppearanceSettings(settings: AppearanceSettingsInput): AppearanceSettings {
  const config = readShimejiConfig();
  const layout = createCharacterLayout(settings.characterScale);
  writeShimejiConfig({
    ...config,
    appearance: {
      ...config.appearance,
      characterScale: layout.scale,
    },
  });

  return getAppearanceSettings();
}

export async function uploadSpriteSheet(upload: SpriteSheetUpload): Promise<AppearanceSettings> {
  if (upload.bytes.length === 0) {
    throw new Error("Uploaded sprite sheet is empty.");
  }

  await mkdir(SpriteSheetsDirectory, { recursive: true });

  const displayFileName = getDisplayFileName(upload.fileName);
  const id = randomUUID();
  const spriteSheetPath = getUploadedSpriteSheetPath(id, displayFileName);
  await writeFile(spriteSheetPath, Buffer.from(upload.bytes));

  const config = readShimejiConfig();
  const existingSpriteSheets = config.appearance?.spriteSheets ?? [];
  writeShimejiConfig({
    ...config,
    appearance: {
      ...config.appearance,
      activeSpriteSheetId: id,
      spriteSheets: [
        ...existingSpriteSheets,
        {
          id,
          name: displayFileName,
          path: spriteSheetPath,
          chromaKey: DefaultSpriteChromaKey,
          chromaThreshold: DefaultChromaKeyThreshold,
        },
      ],
    },
  });

  return getAppearanceSettings();
}

export function selectSpriteSheet(id: string): AppearanceSettings {
  const config = readShimejiConfig();
  const spriteSheets = getSpriteSheetDefinitions(config);

  if (!spriteSheets.some((sheet) => sheet.id === id)) {
    throw new Error(`Sprite sheet not found: ${id}`);
  }

  writeShimejiConfig({
    ...config,
    appearance: {
      ...config.appearance,
      activeSpriteSheetId: id,
    },
  });

  return getAppearanceSettings();
}

export function updateSpriteSheet(update: SpriteSheetUpdate): AppearanceSettings {
  const config = readShimejiConfig();
  const chromaKey = normalizeHexColor(update.chromaKey);
  const chromaThreshold = normalizeChromaThreshold(update.chromaThreshold);

  if (update.id === DefaultSpriteSheetId) {
    writeShimejiConfig({
      ...config,
      appearance: {
        ...config.appearance,
        spriteChromaKey: chromaKey,
        spriteChromaThreshold: chromaThreshold,
      },
    });
    return getAppearanceSettings();
  }

  if (update.id === "legacy-custom" && config.appearance?.customSpriteSheetPath !== undefined) {
    writeShimejiConfig({
      ...config,
      appearance: {
        ...config.appearance,
        spriteChromaKey: chromaKey,
        spriteChromaThreshold: chromaThreshold,
      },
    });
    return getAppearanceSettings();
  }

  const spriteSheets = config.appearance?.spriteSheets ?? [];
  if (!spriteSheets.some((sheet) => sheet.id === update.id)) {
    throw new Error(`Sprite sheet not found: ${update.id}`);
  }

  writeShimejiConfig({
    ...config,
    appearance: {
      ...config.appearance,
      spriteSheets: spriteSheets.map((sheet) =>
        sheet.id === update.id ?
          {
            ...sheet,
            chromaKey,
            chromaThreshold,
          }
        : sheet,
      ),
    },
  });

  return getAppearanceSettings();
}

export async function deleteSpriteSheet(id: string): Promise<AppearanceSettings> {
  if (id === DefaultSpriteSheetId) {
    throw new Error("The default sprite sheet cannot be deleted.");
  }

  const config = readShimejiConfig();

  if (id === "legacy-custom" && config.appearance?.customSpriteSheetPath !== undefined) {
    await deleteManagedSpriteSheetFile(config.appearance.customSpriteSheetPath);
    const appearance = { ...config.appearance };
    delete appearance.customSpriteSheetPath;
    delete appearance.customSpriteSheetName;
    delete appearance.activeSpriteSheetId;
    writeShimejiConfig({
      ...config,
      appearance: {
        ...appearance,
        activeSpriteSheetId: DefaultSpriteSheetId,
      },
    });
    return getAppearanceSettings();
  }

  const spriteSheets = config.appearance?.spriteSheets ?? [];
  const spriteSheet = spriteSheets.find((sheet) => sheet.id === id);

  if (spriteSheet === undefined) {
    throw new Error(`Sprite sheet not found: ${id}`);
  }

  if (spriteSheet.path !== undefined) {
    await deleteManagedSpriteSheetFile(spriteSheet.path);
  }

  writeShimejiConfig({
    ...config,
    appearance: {
      ...config.appearance,
      activeSpriteSheetId: config.appearance?.activeSpriteSheetId === id ? DefaultSpriteSheetId : (config.appearance?.activeSpriteSheetId ?? DefaultSpriteSheetId),
      spriteSheets: spriteSheets.filter((sheet) => sheet.id !== id),
    },
  });

  return getAppearanceSettings();
}

function normalizeHexColor(color: string | undefined): string {
  const trimmed = color?.trim().replace(/^#/, "") ?? "";
  const expanded =
    /^[0-9a-fA-F]{3}$/.test(trimmed) ?
      trimmed
        .split("")
        .map((value) => `${value}${value}`)
        .join("")
    : trimmed;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    return DefaultSpriteChromaKey;
  }

  return `#${expanded.toLowerCase()}`;
}

function parseHexColor(color: string): RgbColor {
  const normalized = normalizeHexColor(color);
  return {
    red: Number.parseInt(normalized.slice(1, 3), 16),
    green: Number.parseInt(normalized.slice(3, 5), 16),
    blue: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function normalizeChromaThreshold(threshold: number | undefined): number {
  if (threshold === undefined || !Number.isFinite(threshold)) {
    return DefaultChromaKeyThreshold;
  }

  return Math.min(MaxChromaKeyThreshold, Math.max(MinChromaKeyThreshold, Math.round(threshold)));
}

function rgbToHsv(color: RgbColor): HsvColor {
  const red = color.red / 255;
  const green = color.green / 255;
  const blue = color.blue / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  if (delta === 0) {
    return {
      hue: 0,
      saturation: max === 0 ? 0 : delta / max,
      value: max,
    };
  }

  let hue: number;
  if (max === red) {
    hue = ((green - blue) / delta) % 6;
  } else if (max === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }

  return {
    hue: (hue * 60 + 360) % 360,
    saturation: max === 0 ? 0 : delta / max,
    value: max,
  };
}

function getHueDistance(first: number, second: number): number {
  const distance = Math.abs(first - second);
  return Math.min(distance, 360 - distance);
}

function getChromaDistance(pixel: RgbColor, chromaKey: RgbColor): number {
  const pixelHsv = rgbToHsv(pixel);
  const keyHsv = rgbToHsv(chromaKey);
  const hueDistance = getHueDistance(pixelHsv.hue, keyHsv.hue) / 180;
  const saturationDistance = Math.abs(pixelHsv.saturation - keyHsv.saturation);
  const valueDistance = Math.abs(pixelHsv.value - keyHsv.value);
  const rgbDistance =
    Math.hypot(pixel.red - chromaKey.red, pixel.green - chromaKey.green, pixel.blue - chromaKey.blue) /
    Math.hypot(255, 255, 255);

  return Math.min(255, (hueDistance * 0.52 + saturationDistance * 0.23 + valueDistance * 0.1 + rgbDistance * 0.15) * 255);
}

function createChromaMask(pixel: RgbaColor, chromaKey: RgbColor, threshold: number): { readonly alphaMultiplier: number } {
  const distance = getChromaDistance(pixel, chromaKey);
  const effectiveThreshold = Math.max(6, threshold * 1.35);

  if (distance <= effectiveThreshold) {
    return {
      alphaMultiplier: 0,
    };
  }

  const smoothness = Math.max(MinChromaKeySmoothness, effectiveThreshold * 1.35);
  const softEdgeEnd = effectiveThreshold + smoothness;

  if (distance >= softEdgeEnd) {
    return {
      alphaMultiplier: 1,
    };
  }

  const t = smoothStep((distance - effectiveThreshold) / smoothness);
  return {
    alphaMultiplier: t * t,
  };
}

function smoothStep(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function decontaminateChroma(value: number, chromaValue: number, alphaMultiplier: number): number {
  if (alphaMultiplier <= 0) {
    return value;
  }

  return Math.round(Math.min(255, Math.max(0, (value - chromaValue * (1 - alphaMultiplier)) / alphaMultiplier)));
}

function getSpriteSheetDefinitions(config: ShimejiConfig): SpriteSheetDefinition[] {
  const definitions: SpriteSheetDefinition[] = [
    {
      id: DefaultSpriteSheetId,
      name: "character.png",
      path: DefaultSpriteSheetPath,
      chromaKey: normalizeHexColor(config.appearance?.spriteChromaKey),
      chromaThreshold: normalizeChromaThreshold(config.appearance?.spriteChromaThreshold),
      isDefault: true,
    },
  ];

  for (const sheet of config.appearance?.spriteSheets ?? []) {
    if (
      sheet.id === undefined ||
      sheet.name === undefined ||
      sheet.path === undefined ||
      sheet.id.length === 0 ||
      sheet.name.length === 0 ||
      sheet.path.length === 0
    ) {
      continue;
    }

    definitions.push({
      id: sheet.id,
      name: sheet.name,
      path: sheet.path,
      chromaKey: normalizeHexColor(sheet.chromaKey),
      chromaThreshold: normalizeChromaThreshold(sheet.chromaThreshold),
      isDefault: false,
    });
  }

  if (config.appearance?.customSpriteSheetPath !== undefined && definitions.length === 1) {
    definitions.push({
      id: "legacy-custom",
      name: config.appearance.customSpriteSheetName ?? "custom-sprite-sheet.png",
      path: config.appearance.customSpriteSheetPath,
      chromaKey: normalizeHexColor(config.appearance.spriteChromaKey),
      chromaThreshold: normalizeChromaThreshold(config.appearance.spriteChromaThreshold),
      isDefault: false,
    });
  }

  return definitions;
}

function getActiveSpriteSheetId(config: ShimejiConfig, spriteSheets: readonly SpriteSheetDefinition[]): string {
  const configuredId = config.appearance?.activeSpriteSheetId;
  if (configuredId !== undefined && spriteSheets.some((sheet) => sheet.id === configuredId)) {
    return configuredId;
  }

  if (config.appearance?.customSpriteSheetPath !== undefined && spriteSheets.some((sheet) => sheet.id === "legacy-custom")) {
    return "legacy-custom";
  }

  return DefaultSpriteSheetId;
}

function getActiveSpriteSheetDefinition(config: ShimejiConfig): SpriteSheetDefinition {
  const spriteSheets = getSpriteSheetDefinitions(config);
  const activeId = getActiveSpriteSheetId(config, spriteSheets);
  return (
    spriteSheets.find((sheet) => sheet.id === activeId) ?? {
      id: DefaultSpriteSheetId,
      name: "character.png",
      path: DefaultSpriteSheetPath,
      chromaKey: DefaultSpriteChromaKey,
      chromaThreshold: DefaultChromaKeyThreshold,
      isDefault: true,
    }
  );
}

function createProcessedSpriteSheetImage(path: string, chromaKey: string, chromaThreshold: number): ReturnType<typeof nativeImage.createFromPath> {
  const image = nativeImage.createFromPath(path);
  const size = image.getSize();

  if (image.isEmpty() || size.width === 0 || size.height === 0) {
    return image;
  }

  const key = parseHexColor(chromaKey);
  const bitmap = Buffer.from(image.toBitmap());

  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];

    if (blue === undefined || green === undefined || red === undefined) {
      continue;
    }

    const alpha = bitmap[offset + 3] ?? 0;
    const mask = createChromaMask({ red, green, blue, alpha }, key, chromaThreshold);

    if (mask.alphaMultiplier === 0) {
      bitmap[offset + 3] = 0;
      continue;
    }

    if (mask.alphaMultiplier < 1) {
      bitmap[offset] = decontaminateChroma(blue, key.blue, mask.alphaMultiplier);
      bitmap[offset + 1] = decontaminateChroma(green, key.green, mask.alphaMultiplier);
      bitmap[offset + 2] = decontaminateChroma(red, key.red, mask.alphaMultiplier);
      bitmap[offset + 3] = Math.round(alpha * mask.alphaMultiplier);
    }
  }

  return nativeImage.createFromBitmap(bitmap, size);
}

function createSpriteSheetDataUrl(spriteSheet: SpriteSheetDefinition): string {
  const image = createProcessedSpriteSheetImage(spriteSheet.path, spriteSheet.chromaKey, spriteSheet.chromaThreshold);
  const size = image.getSize();

  if (image.isEmpty() || size.width === 0 || size.height === 0) {
    if (spriteSheet.path !== DefaultSpriteSheetPath) {
      return createSpriteSheetDataUrl({
        id: DefaultSpriteSheetId,
        name: "character.png",
        path: DefaultSpriteSheetPath,
        chromaKey: DefaultSpriteChromaKey,
        chromaThreshold: DefaultChromaKeyThreshold,
        isDefault: true,
      });
    }

    return "";
  }

  return image.toDataURL();
}

function createRawSpriteSheetDataUrl(spriteSheet: SpriteSheetDefinition): string {
  const image = nativeImage.createFromPath(spriteSheet.path);
  const size = image.getSize();

  if (image.isEmpty() || size.width === 0 || size.height === 0) {
    if (spriteSheet.path !== DefaultSpriteSheetPath) {
      return createRawSpriteSheetDataUrl({
        id: DefaultSpriteSheetId,
        name: "character.png",
        path: DefaultSpriteSheetPath,
        chromaKey: DefaultSpriteChromaKey,
        chromaThreshold: DefaultChromaKeyThreshold,
        isDefault: true,
      });
    }

    return "";
  }

  return image.toDataURL();
}

function createSpriteSheetPreviewDataUrl(spriteSheet: SpriteSheetDefinition): string {
  const image = createProcessedSpriteSheetImage(spriteSheet.path, spriteSheet.chromaKey, spriteSheet.chromaThreshold);
  const size = image.getSize();

  if (image.isEmpty() || size.width === 0 || size.height === 0) {
    return "";
  }

  const previewWidth = Math.min(256, size.width);
  return image.resize({ width: previewWidth }).toDataURL();
}

function getUploadedSpriteSheetPath(id: string, fileName: string): string {
  const extension = normalizeSpriteSheetExtension(extname(fileName));
  return join(SpriteSheetsDirectory, `${id}${extension}`);
}

function normalizeSpriteSheetExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg" || normalized === ".webp") {
    return normalized;
  }

  return ".png";
}

function getDisplayFileName(fileName: string): string {
  const normalized = fileName.trim().replaceAll("\\", "/");
  const displayName = normalized.split("/").filter((part) => part.length > 0).at(-1);
  return displayName ?? "custom-sprite-sheet.png";
}

function toSpriteSheetSettings(sheet: SpriteSheetDefinition, activeSpriteSheetId: string): SpriteSheetSettings {
  return {
    id: sheet.id,
    name: sheet.name,
    chromaKey: sheet.chromaKey,
    chromaThreshold: sheet.chromaThreshold,
    previewDataUrl: createSpriteSheetPreviewDataUrl(sheet),
    isDefault: sheet.isDefault,
    isActive: sheet.id === activeSpriteSheetId,
  };
}

async function deleteManagedSpriteSheetFile(path: string): Promise<void> {
  const root = resolve(SpriteSheetsDirectory);
  const target = resolve(path);
  const pathFromRoot = relative(root, target);

  if (pathFromRoot.startsWith("..") || pathFromRoot === "" || pathFromRoot.includes(":")) {
    return;
  }

  try {
    await unlink(target);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}
