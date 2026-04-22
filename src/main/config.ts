import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigFileName, type ShimejiConfig } from "./responder.js";

export const ShimejiDataDirectory = join(process.cwd(), ".shimeji");
export const ShimejiConfigPath = join(ShimejiDataDirectory, ConfigFileName);
export const SpriteSheetsDirectory = join(ShimejiDataDirectory, "sprites");
export const DevServerFilePath = join(ShimejiDataDirectory, "dev-server.json");

export function readShimejiConfig(): ShimejiConfig {
  try {
    return JSON.parse(readFileSync(ShimejiConfigPath, "utf8")) as ShimejiConfig;
  } catch (error) {
    console.warn("Could not read Shimeji config.", error);
    return {};
  }
}

export function writeShimejiConfig(config: ShimejiConfig): void {
  mkdirSync(ShimejiDataDirectory, { recursive: true });
  writeFileSync(ShimejiConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
