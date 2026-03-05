import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileExists } from "../lib/utils.mjs";
import { scoreText } from "./scoring.mjs";
import { ocrDeepSeekByMode } from "./engines.mjs";

/**
 * Run the OCR pipeline on a single image file (DeepSeek only).
 * @param {string} imagePath - Absolute path to the input image
 * @param {object} config - OCR configuration from buildOcrConfig()
 * @returns {Promise<object>} OCR result
 */
export async function runOcrPipeline(imagePath, config) {
  const t0 = Date.now();
  const warnings = [];

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-api-"));

  try {
    if (config.deepseekModelDir && !(await fileExists(config.deepseekModelDir))) {
      warnings.push(`DeepSeek model dir not found: ${config.deepseekModelDir}`);
    }

    const tOcr = Date.now();
    const dsMap = await ocrDeepSeekByMode([imagePath], config, tempDir, warnings);
    const dsResult = dsMap.get(path.resolve(imagePath));
    const ocrMs = Date.now() - tOcr;

    const text = dsResult?.text || "";
    const score = scoreText(text);

    return {
      selectedEngine: "deepseek",
      text,
      score: Math.round(score * 100) / 100,
      candidates: [{ engine: "deepseek", text, score: Math.round(score * 100) / 100 }],
      warnings,
      timings: {
        ocrMs,
        totalMs: Date.now() - t0,
      },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
