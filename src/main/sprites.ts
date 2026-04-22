import { nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { DefaultCharacterScale, createCharacterLayout, type CharacterLayout } from "../shared/character-layout.js";
import type {
  AppearanceSettings,
  AppearanceSettingsInput,
  SpriteSheetSettings,
  SpriteSheetUpload,
} from "../shared/shimeji-api.js";
import { readShimejiConfig, SpriteSheetsDirectory, writeShimejiConfig } from "./config.js";
import { getBundledAppPath } from "./paths.js";
import type { ShimejiConfig } from "./responder.js";

const DefaultSpriteSheetId = "default";
const DefaultSpriteSheetPath = getBundledAppPath("src", "renderer", "src", "assets", "character.png");
const SpriteSheetFrameCount = 6;

export interface CharacterAabb {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SpriteSheetDefinition {
  readonly id: string;
  readonly name: string;
  readonly path: string;
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

  const frameWidth = Math.max(1, Math.floor(size.width / SpriteSheetFrameCount));
  const bitmap = image.toBitmap();

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const pixelOffset = (y * size.width + x) * 4;
      const alpha = bitmap[pixelOffset + 3];

      if (alpha === undefined || alpha === 0) {
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

function getSpriteSheetDefinitions(config: ShimejiConfig): SpriteSheetDefinition[] {
  const definitions: SpriteSheetDefinition[] = [
    {
      id: DefaultSpriteSheetId,
      name: "character.png",
      path: DefaultSpriteSheetPath,
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
      isDefault: false,
    });
  }

  if (config.appearance?.customSpriteSheetPath !== undefined && definitions.length === 1) {
    definitions.push({
      id: "legacy-custom",
      name: config.appearance.customSpriteSheetName ?? "custom-sprite-sheet.png",
      path: config.appearance.customSpriteSheetPath,
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
      isDefault: true,
    }
  );
}

function createSpriteSheetDataUrl(spriteSheet: SpriteSheetDefinition): string {
  const image = nativeImage.createFromPath(spriteSheet.path);
  const size = image.getSize();

  if (image.isEmpty() || size.width === 0 || size.height === 0) {
    if (spriteSheet.path !== DefaultSpriteSheetPath) {
      return createSpriteSheetDataUrl({
        id: DefaultSpriteSheetId,
        name: "character.png",
        path: DefaultSpriteSheetPath,
        isDefault: true,
      });
    }

    return "";
  }

  return image.toDataURL();
}

function createSpriteSheetPreviewDataUrl(spriteSheet: SpriteSheetDefinition): string {
  const image = nativeImage.createFromPath(spriteSheet.path);
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
