import { cp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(scriptsDirectory);
const pnpmDirectory = join(projectDirectory, "node_modules", ".pnpm");
const pnpmEntries = await readdir(pnpmDirectory, { withFileTypes: true });
const win32X64CodexEntry = pnpmEntries
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("@openai+codex@") && entry.name.endsWith("-win32-x64"))
  .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }))
  .at(0);

if (win32X64CodexEntry === undefined) {
  throw new Error("Could not find the installed @openai/codex win32-x64 package.");
}

const platformVendorDirectory = join(pnpmDirectory, win32X64CodexEntry.name, "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc");
const preparedCodexDirectory = join(projectDirectory, "build", "codex");

await rm(preparedCodexDirectory, { force: true, recursive: true });
await cp(platformVendorDirectory, preparedCodexDirectory, { recursive: true });

console.log(`Prepared Codex CLI from ${platformVendorDirectory}`);
