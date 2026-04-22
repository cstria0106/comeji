import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ShimejiConfig } from "./responder.js";
import { ShimejiConfigPath, ShimejiDataDirectory } from "./paths.js";
export { DevServerFilePath, ShimejiDataDirectory, SpriteSheetsDirectory } from "./paths.js";

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
