import { app } from "electron";
import { dirname, join } from "node:path";

const DataDirectoryName = ".shimeji";
const PortableExecutableDirectory = "PORTABLE_EXECUTABLE_DIR";

export const ConfigFileName = "shimeji.config.json";

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

export const ShimejiDataDirectory = join(getApplicationBaseDirectory(), DataDirectoryName);
export const ShimejiConfigPath = join(ShimejiDataDirectory, ConfigFileName);
export const SpriteSheetsDirectory = join(ShimejiDataDirectory, "sprites");
export const DevServerFilePath = join(ShimejiDataDirectory, "dev-server.json");
