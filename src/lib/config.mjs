import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNumber } from "./utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export const DEEPSEEK_BATCH_SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "deepseek_ocr2_batch.py");
export const DEFAULT_DEEPSEEK_MODEL_DIR = path.join(PROJECT_ROOT, "models", "deepseek-ocr-2");
export const PROJECT_ROOT_DIR = PROJECT_ROOT;

export const DEEPSEEK_DEFAULTS = {
  deepseek4bit: false,
  deepseekMaxTokens: 1200,
  deepseekBaseSize: 1024,
  deepseekImageSize: 768,
  deepseekCropMode: true,
  deepseekAttnImplementation: "eager",
  deepseekEnhance: false,
};

export function resolveEngineSet() {
  return new Set(["deepseek"]);
}

export function buildOcrConfig(body = {}) {
  return {
    engine: "deepseek",
    ocrMode: "normal",

    // DeepSeek options
    deepseekModelDir: body.deepseekModelDir || DEFAULT_DEEPSEEK_MODEL_DIR,
    deepseekDevice: body.deepseekDevice || "auto",
    deepseekDeviceMap: body.deepseekDeviceMap || "auto",
    deepseek4bit: body.deepseek4bit ?? DEEPSEEK_DEFAULTS.deepseek4bit,
    deepseekAttnImplementation: body.deepseekAttnImplementation || DEEPSEEK_DEFAULTS.deepseekAttnImplementation,
    deepseekPrompt: body.deepseekPrompt || "<image>Extract all text from this image.",
    deepseekBaseSize: ensureNumber(body.deepseekBaseSize, DEEPSEEK_DEFAULTS.deepseekBaseSize),
    deepseekImageSize: ensureNumber(body.deepseekImageSize, DEEPSEEK_DEFAULTS.deepseekImageSize),
    deepseekCropMode: body.deepseekCropMode ?? DEEPSEEK_DEFAULTS.deepseekCropMode,
    deepseekMaxTokens: ensureNumber(body.deepseekMaxTokens, DEEPSEEK_DEFAULTS.deepseekMaxTokens),
    deepseekEnhance: body.deepseekEnhance ?? DEEPSEEK_DEFAULTS.deepseekEnhance,
    deepseekTimeoutMs: ensureNumber(body.deepseekTimeoutMs, 900_000),
    deepseekPython: body.deepseekPython || null,
  };
}
