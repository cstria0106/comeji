import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ComejiConfig } from "./responder.js";
import { ComejiConfigPath, ComejiDataDirectory } from "./paths.js";
export { DevServerFilePath, ComejiDataDirectory, SpriteSheetsDirectory } from "./paths.js";

export function readComejiConfig(): ComejiConfig {
  try {
    return JSON.parse(readFileSync(ComejiConfigPath, "utf8")) as ComejiConfig;
  } catch (error) {
    console.warn("Could not read Comeji config.", error);
    return {};
  }
}

export function writeComejiConfig(config: ComejiConfig): void {
  mkdirSync(ComejiDataDirectory, { recursive: true });
  writeFileSync(ComejiConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
