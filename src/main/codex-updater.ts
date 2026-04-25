import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ComejiDataDirectory } from "./paths.js";

type RegistryVersion = {
  readonly dist?: {
    readonly tarball?: unknown;
  };
};

type RegistryMetadata = {
  readonly "dist-tags"?: {
    readonly latest?: unknown;
  };
  readonly versions?: Record<string, RegistryVersion>;
};

const RegistryUrl = "https://registry.npmjs.org/@openai%2Fcodex";
const RuntimeDirectory = join(ComejiDataDirectory, "codex-runtime");
const RequestTimeoutMs = 8_000;
const VendorPrefix = "package/vendor/x86_64-pc-windows-msvc/";
const CodexRelativePath = join("codex", "codex.exe");

export async function resolveCodexCommandPath(fallbackCommandPath: string, shouldUpdate: boolean): Promise<string> {
  if (!shouldUpdate) {
    return fallbackCommandPath;
  }

  try {
    return await updateCodexCommandPath(fallbackCommandPath);
  } catch (error) {
    console.warn("Could not update Codex CLI; using bundled CLI.", error);
    return (await findCachedCodexCommandPath()) ?? fallbackCommandPath;
  }
}

async function updateCodexCommandPath(fallbackCommandPath: string): Promise<string> {
  const metadata = await fetchJson<RegistryMetadata>(RegistryUrl);
  const latestVersion = typeof metadata["dist-tags"]?.latest === "string" ? metadata["dist-tags"].latest : undefined;
  if (latestVersion === undefined) {
    throw new Error("Codex registry metadata did not include a latest version.");
  }

  const cachedCommandPath = await findCachedCodexCommandPath();
  if (cachedCommandPath !== undefined && compareVersions(getRuntimeVersion(dirname(dirname(cachedCommandPath))), latestVersion) >= 0) {
    return cachedCommandPath;
  }

  const bundledVersion = readCodexVersion(fallbackCommandPath);
  if (bundledVersion !== undefined && compareVersions(bundledVersion, latestVersion) >= 0) {
    return fallbackCommandPath;
  }

  const platformVersion = `${latestVersion}-win32-x64`;
  const tarball = metadata.versions?.[platformVersion]?.dist?.tarball;
  if (typeof tarball !== "string" || !tarball.startsWith("https://registry.npmjs.org/")) {
    throw new Error("Codex registry metadata did not include a trusted Windows x64 tarball.");
  }

  const targetDirectory = join(RuntimeDirectory, latestVersion);
  const temporaryDirectory = join(RuntimeDirectory, `${latestVersion}.download`);
  const archivePath = join(temporaryDirectory, "codex.tgz");

  await rm(temporaryDirectory, { force: true, recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  await downloadFile(tarball, archivePath);
  await extractCodexArchive(archivePath, temporaryDirectory);

  const downloadedCommandPath = join(temporaryDirectory, CodexRelativePath);
  const downloadedVersion = readCodexVersion(downloadedCommandPath);
  if (downloadedVersion !== latestVersion) {
    throw new Error(`Downloaded Codex CLI version mismatch: expected ${latestVersion}, got ${downloadedVersion ?? "unknown"}.`);
  }

  await rm(archivePath, { force: true });
  await writeFile(join(temporaryDirectory, "version.json"), `${JSON.stringify({ version: latestVersion }, null, 2)}\n`, "utf8");
  await rm(targetDirectory, { force: true, recursive: true });
  await rename(temporaryDirectory, targetDirectory);

  return join(targetDirectory, CodexRelativePath);
}

async function findCachedCodexCommandPath(): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(RuntimeDirectory);
  } catch {
    return undefined;
  }

  const versions = entries.filter((entry) => /^\d+\.\d+\.\d+/.test(entry)).sort(compareVersions).reverse();
  for (const version of versions) {
    const commandPath = join(RuntimeDirectory, version, CodexRelativePath);
    if (readCodexVersion(commandPath) === version) {
      return commandPath;
    }
  }

  return undefined;
}

async function extractCodexArchive(archivePath: string, targetDirectory: string): Promise<void> {
  const archive = gunzipSync(await readFile(archivePath));
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;

    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const typeFlag = readTarString(header, 156, 1);
    const data = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (!name.startsWith(VendorPrefix) || typeFlag === "5") {
      continue;
    }

    const relativePath = name.slice(VendorPrefix.length);
    if (relativePath.length === 0 || relativePath.includes("..") || relativePath.includes(":") || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
      continue;
    }

    const outputPath = join(targetDirectory, relativePath);
    if (basename(outputPath).length === 0 || !resolve(outputPath).startsWith(resolve(targetDirectory))) {
      continue;
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, data);
    if (outputPath.endsWith(".exe")) {
      await chmod(outputPath, 0o755);
    }
  }
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/u, "");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchBuffer(url);
  return JSON.parse(response.toString("utf8")) as T;
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetchBuffer(url);
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(destination);
    stream.once("error", reject);
    stream.once("finish", resolve);
    stream.end(response);
  });
}

async function fetchBuffer(url: string): Promise<Buffer> {
  if (!url.startsWith("https://registry.npmjs.org/")) {
    throw new Error("Refusing to download Codex CLI from an untrusted host.");
  }

  return await new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Codex registry request failed with HTTP ${response.statusCode ?? 0}.`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks)));
    });

    request.setTimeout(RequestTimeoutMs, () => {
      request.destroy(new Error("Codex registry request timed out."));
    });
    request.once("error", reject);
  });
}

function readCodexVersion(commandPath: string): string | undefined {
  try {
    const output = execFileSync(commandPath, ["--version"], {
      encoding: "utf8",
      timeout: RequestTimeoutMs,
      windowsHide: true,
    });
    const match = /codex-cli\s+(\d+\.\d+\.\d+)/u.exec(output);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function getRuntimeVersion(runtimeDirectory: string): string {
  return basename(runtimeDirectory);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}
