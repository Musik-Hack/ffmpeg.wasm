import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiSourcePath = resolve(repoRoot, "portable/ffmpeg-remux-api.js");
const workerSourcePath = resolve(repoRoot, "portable/ffmpeg-remux-worker.js");
const coreJsPath = resolve(repoRoot, "packages/core/dist/umd/ffmpeg-core.js");
const coreWasmPath = resolve(repoRoot, "packages/core/dist/umd/ffmpeg-core.wasm");
const outputDir = resolve(repoRoot, "dist/portable");
const outputApiPath = resolve(outputDir, "ffmpeg-remux-api.js");
const outputWasmPath = resolve(outputDir, "ffmpeg-core.wasm");

const readRequired = async (path, label) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found at ${path}. Build the single-thread core first with "make prd" or "make dev".`);
    }
    throw error;
  }
};

const copyRequired = async (from, to, label) => {
  try {
    await copyFile(from, to);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found at ${from}. Build the single-thread core first with "make prd" or "make dev".`);
    }
    throw error;
  }
};

const replaceOnce = (source, token, value, label) => {
  if (!source.includes(token)) throw new Error(`Missing ${label} placeholder: ${token}`);
  return source.replace(token, value);
};

const main = async () => {
  const [apiSource, workerSource, coreSource] = await Promise.all([
    readRequired(apiSourcePath, "Portable API source"),
    readRequired(workerSourcePath, "Portable worker source"),
    readRequired(coreJsPath, "ffmpeg-core.js"),
  ]);

  const workerBundle = replaceOnce(
    workerSource,
    "__FFMPEG_CORE_SOURCE__",
    JSON.stringify(coreSource),
    "core source"
  );
  const apiBundle = replaceOnce(
    apiSource,
    "__WORKER_SOURCE__",
    JSON.stringify(workerBundle),
    "worker source"
  );

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputApiPath, apiBundle, "utf8");
  await copyRequired(coreWasmPath, outputWasmPath, "ffmpeg-core.wasm");

  console.log(`Wrote ${outputApiPath}`);
  console.log(`Wrote ${outputWasmPath}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
