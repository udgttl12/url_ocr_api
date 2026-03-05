import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeText, fileExists } from "../lib/utils.mjs";
import {
  DEEPSEEK_BATCH_SCRIPT_PATH,
  PROJECT_ROOT_DIR,
} from "../lib/config.mjs";
import { scoreText, cleanDeepSeekOutput, selectBestDeepSeekResult } from "./scoring.mjs";

const execFileAsync = promisify(execFile);

function resolveDeepSeekRunConfig(config, overrides = {}) {
  return {
    deepseekModelDir: overrides.deepseekModelDir ?? config.deepseekModelDir,
    deepseekDevice: overrides.deepseekDevice ?? config.deepseekDevice,
    deepseekDeviceMap: overrides.deepseekDeviceMap ?? config.deepseekDeviceMap,
    deepseek4bit: overrides.deepseek4bit ?? config.deepseek4bit,
    deepseekAttnImplementation: overrides.deepseekAttnImplementation ?? config.deepseekAttnImplementation,
    deepseekPrompt: overrides.deepseekPrompt ?? config.deepseekPrompt,
    deepseekBaseSize: overrides.deepseekBaseSize ?? config.deepseekBaseSize,
    deepseekImageSize: overrides.deepseekImageSize ?? config.deepseekImageSize,
    deepseekCropMode: overrides.deepseekCropMode ?? config.deepseekCropMode,
    deepseekMaxTokens: overrides.deepseekMaxTokens ?? config.deepseekMaxTokens,
    deepseekEnhance: overrides.deepseekEnhance ?? config.deepseekEnhance,
    deepseekTimeoutMs: overrides.deepseekTimeoutMs ?? config.deepseekTimeoutMs,
    deepseekPython: overrides.deepseekPython ?? config.deepseekPython,
  };
}

export async function resolveDeepSeekPythonBinary(configPython) {
  if (configPython) return configPython;
  const localVenvPython = path.join(PROJECT_ROOT_DIR, ".venv-deepseekocr2", "Scripts", "python.exe");
  if (await fileExists(localVenvPython)) return localVenvPython;
  return "python";
}

export async function killDeepSeekBatchProcesses() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -eq 'python.exe' -and $_.CommandLine -like '*deepseek_ocr2_batch.py*'",
    "} | ForEach-Object {",
    "  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
    "}",
  ].join("; ");

  try {
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-Command", script],
      { windowsHide: true, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
    );
  } catch {
    // Best-effort orphan cleanup.
  }
}

export async function ocrDeepSeekBatch(imagePaths, config, tempDir, overrides = {}) {
  if (!imagePaths.length) return [];
  if (!(await fileExists(DEEPSEEK_BATCH_SCRIPT_PATH))) {
    throw new Error(`deepseek batch script missing: ${DEEPSEEK_BATCH_SCRIPT_PATH}`);
  }
  const runConfig = resolveDeepSeekRunConfig(config, overrides);
  const device = String(runConfig.deepseekDevice || "").toLowerCase();
  if (!(device === "auto" || device === "cuda" || device.startsWith("cuda:"))) {
    throw new Error(`deepseek requires CUDA device, got: ${runConfig.deepseekDevice}`);
  }

  const pythonBin = await resolveDeepSeekPythonBinary(runConfig.deepseekPython);
  const outJsonPath = path.join(
    tempDir,
    `deepseek-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );

  const args = [
    DEEPSEEK_BATCH_SCRIPT_PATH,
    "--model-dir",
    runConfig.deepseekModelDir,
    "--output-json",
    outJsonPath,
    "--device",
    runConfig.deepseekDevice,
    "--device-map",
    runConfig.deepseekDeviceMap,
    "--load-in-4bit",
    String(Boolean(runConfig.deepseek4bit)),
    "--attn-implementation",
    runConfig.deepseekAttnImplementation,
    "--prompt",
    runConfig.deepseekPrompt,
    "--base-size",
    String(runConfig.deepseekBaseSize),
    "--image-size",
    String(runConfig.deepseekImageSize),
    "--crop-mode",
    String(Boolean(runConfig.deepseekCropMode)),
    "--max-new-tokens",
    String(runConfig.deepseekMaxTokens),
    "--enhance",
    String(Boolean(runConfig.deepseekEnhance)),
    "--images",
    ...imagePaths,
  ];

  try {
    await execFileAsync(pythonBin, args, {
      windowsHide: true,
      timeout: Math.max(30_000, runConfig.deepseekTimeoutMs || 900_000),
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        HF_MODULES_CACHE: process.env.HF_MODULES_CACHE || path.join(PROJECT_ROOT_DIR, ".hf_modules_cache"),
        PYTHONNOUSERSITE: "1",
      },
    });
  } catch (err) {
    throw new Error(`deepseek ocr process failed: ${err.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(await fs.readFile(outJsonPath, "utf8"));
  } catch (err) {
    throw new Error(`deepseek result parse failed: ${err.message}`);
  } finally {
    await fs.unlink(outJsonPath).catch(() => {});
  }

  if (!payload || payload.ok === false) {
    throw new Error(payload?.error || "deepseek result invalid");
  }

  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map((item) => ({
    image: item.image,
    text: cleanDeepSeekOutput(item.text || ""),
    error: item.error || "",
  }));
}

export async function ocrDeepSeekByMode(imagePaths, config, tempDir, warnings) {
  const candidatesByImage = new Map();

  try {
    const results = await ocrDeepSeekBatch(imagePaths, config, tempDir);
    for (const result of results) {
      const key = path.resolve(result.image);
      const candidate = { ...result, pass: "primary" };
      if (!candidatesByImage.has(key)) candidatesByImage.set(key, []);
      candidatesByImage.get(key).push(candidate);
    }
  } catch (err) {
    warnings.push(`DeepSeek OCR failed: ${err.message}`);
  }

  const merged = new Map();
  for (const [key, candidates] of candidatesByImage.entries()) {
    const selected = selectBestDeepSeekResult(candidates);
    if (selected) merged.set(key, selected);
  }
  return merged;
}
