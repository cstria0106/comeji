import { app } from "electron";
import { dirname, join } from "node:path";

const DataDirectoryName = ".comeji";
const PortableExecutableDirectory = "PORTABLE_EXECUTABLE_DIR";

export const ConfigFileName = "comeji.config.json";

export function getApplicationBaseDirectory(): string {
  if (!app.isPackaged) {
    return process.cwd();
  }

  const portableExecutableDirectory = process.env[PortableExecutableDirectory];
  if (portableExecutableDirectory !== undefined && portableExecutableDirectory.length > 0) {
    return portableExecutableDirectory;
  }

  return dirname(process.execPath);
}

export function getBundledAppPath(...segments: readonly string[]): string {
  return join(app.getAppPath(), ...segments);
}

export const ComejiDataDirectory = join(getApplicationBaseDirectory(), DataDirectoryName);
export const ComejiConfigPath = join(ComejiDataDirectory, ConfigFileName);
export const SpriteSheetsDirectory = join(ComejiDataDirectory, "sprites");
export const DevServerFilePath = join(ComejiDataDirectory, "dev-server.json");
