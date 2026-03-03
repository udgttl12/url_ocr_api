#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import sharp from "sharp";
import { createWorker } from "tesseract.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WINRT_SCRIPT_PATH = path.join(__dirname, "scripts", "winrt-ocr.ps1");
const DEEPSEEK_BATCH_SCRIPT_PATH = path.join(__dirname, "scripts", "deepseek_ocr2_batch.py");
const DEFAULT_QWEN_VL_MODEL_FILE = path.join(
  __dirname,
  "models",
  "Qwen3-VL-4B-Instruct-Q6_K.gguf",
);
const DEFAULT_DEEPSEEK_MODEL_DIR = path.join(__dirname, "models", "deepseek-ocr-2");
const DEEPSEEK_HIGH_PROMPT =
  "<image>\n<|grounding|>Convert the document to markdown. Preserve Korean words exactly. Do not paraphrase.";
const DEEPSEEK_OCR_MODES = {
  fast: {
    scale: 4,
    deepseek4bit: true,
    deepseekMaxTokens: 900,
    deepseekBaseSize: 1024,
    deepseekImageSize: 768,
    deepseekCropMode: true,
    deepseekAttnImplementation: "eager",
  },
  normal: {
    scale: 4,
    deepseek4bit: false,
    deepseekMaxTokens: 1200,
    deepseekBaseSize: 1024,
    deepseekImageSize: 768,
    deepseekCropMode: true,
    deepseekAttnImplementation: "eager",
  },
  high: {
    scale: 5,
    deepseek4bit: false,
    deepseekMaxTokens: 1600,
    deepseekBaseSize: 1024,
    deepseekImageSize: 768,
    deepseekCropMode: true,
    deepseekAttnImplementation: "eager",
  },
};

function nowIso() {
  return new Date().toISOString();
}

function ensureNumber(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasCliOption(name) {
  const flag = `--${name}`;
  return process.argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

async function mapWithConcurrency(items, limit, worker) {
  const maxWorkers = Math.max(1, Math.floor(limit || 1));
  if (!items.length) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(maxWorkers, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= items.length) return;
        results[current] = await worker(items[current], current);
      }
    }),
  );

  return results;
}

async function killDeepSeekBatchProcesses() {
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

function slugify(input) {
  const base = (input || "article").trim().toLowerCase();
  const slug = base
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[^a-z0-9\uac00-\ud7a3\s-_]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `article-${Date.now()}`;
}

function sanitizeText(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveEngineSet(engine) {
  if (engine === "tesseract") return new Set(["tesseract"]);
  if (engine === "winrt") return new Set(["winrt"]);
  if (engine === "qwenvl") return new Set(["qwenvl"]);
  if (engine === "deepseek") return new Set(["deepseek"]);
  if (engine === "all") return new Set(["tesseract", "winrt", "qwenvl", "deepseek"]);
  return new Set(["tesseract", "winrt"]);
}

async function resolveDeepSeekPythonBinary(configPython) {
  if (configPython) return configPython;
  const localVenvPython = path.join(__dirname, ".venv-deepseekocr2", "Scripts", "python.exe");
  if (await fileExists(localVenvPython)) return localVenvPython;
  return "python";
}

async function ensureDirs(outDir) {
  const dirs = {
    root: outDir,
    assets: path.join(outDir, "assets"),
    original: path.join(outDir, "assets", "original"),
    preprocessed: path.join(outDir, "assets", "preprocessed"),
    ocr: path.join(outDir, "assets", "ocr"),
  };
  await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));
  return dirs;
}

async function fetchArticle(url, page) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});

  await page.waitForSelector("iframe#cafe_main", { timeout: 10_000 }).catch(() => {});
  const iframe = await page.$("iframe#cafe_main");
  const frame =
    (await iframe?.contentFrame()) ||
    page.frame({ name: "cafe_main" }) ||
    page.mainFrame();

  const extracted = await frame.evaluate(() => {
    const titleSelectors = [
      ".title_text",
      ".ArticleTitle",
      ".article_title",
      ".se-title-text",
      "h3",
      "h2",
    ];
    const authorSelectors = [
      ".nickname",
      ".writer_info .nickname",
      ".article_writer .nickname",
      ".member_info .nickname",
    ];
    const dateSelectors = [
      ".date",
      ".article_info .date",
      ".writer_info .date",
      ".se_publishDate",
    ];
    const contentSelectors = [
      ".se-main-container",
      ".ContentRenderer",
      ".article_viewer",
      "#tbody",
      "#main-area",
      "body",
    ];

    const readFirst = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      return "";
    };

    const root = contentSelectors
      .map((selector) => document.querySelector(selector))
      .find((node) => node);

    if (!root) {
      return {
        meta: {
          title: readFirst(titleSelectors),
          author: readFirst(authorSelectors),
          date: readFirst(dateSelectors),
        },
        blocks: [],
      };
    }

    const textBlockTags = new Set([
      "P",
      "LI",
      "BLOCKQUOTE",
      "PRE",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "TD",
      "TH",
      "SPAN",
      "DIV",
    ]);

    const blocks = [];
    const pushText = (text) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!normalized) return;
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "text") {
        prev.text += `\n${normalized}`;
      } else {
        blocks.push({ type: "text", text: normalized });
      }
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        if (el.tagName === "IMG") {
          const src = el.getAttribute("src") || el.getAttribute("data-src");
          if (src && !src.startsWith("data:")) {
            blocks.push({ type: "image", url: src });
          }
        }
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (!parent) continue;
        const tag = parent.tagName;
        if (!textBlockTags.has(tag)) continue;
        if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(tag)) continue;

        const text = node.textContent?.trim() || "";
        if (text.length < 2) continue;
        pushText(text);
      }
    }

    const deduped = [];
    const seenImages = new Set();
    for (const block of blocks) {
      if (block.type === "image") {
        if (seenImages.has(block.url)) continue;
        seenImages.add(block.url);
        deduped.push(block);
      } else {
        deduped.push(block);
      }
    }

    return {
      meta: {
        title: readFirst(titleSelectors),
        author: readFirst(authorSelectors),
        date: readFirst(dateSelectors),
      },
      blocks: deduped,
    };
  });

  const withAbsUrl = extracted.blocks.map((block, idx) => {
    if (block.type !== "image") return { ...block, index: idx };
    try {
      return { ...block, index: idx, url: new URL(block.url, url).toString() };
    } catch {
      return { ...block, index: idx };
    }
  });

  return {
    meta: extracted.meta,
    blocks: withAbsUrl,
  };
}

function classifyBlocks(blocks) {
  const textBlocks = [];
  const imageBlocks = [];
  for (const block of blocks) {
    if (block.type === "text") textBlocks.push(block);
    if (block.type === "image") imageBlocks.push(block);
  }
  return { textBlocks, imageBlocks };
}

function detectExtFromType(contentType, fallbackUrl) {
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("gif")) return ".gif";
  try {
    const ext = path.extname(new URL(fallbackUrl).pathname);
    return ext || ".jpg";
  } catch {
    return ".jpg";
  }
}

async function downloadImage(context, imageUrl, outPathBase, ordinal) {
  const resp = await context.request.get(imageUrl, { timeout: 60_000 });
  if (!resp.ok()) {
    throw new Error(`image download failed(${resp.status()}): ${imageUrl}`);
  }
  const contentType = resp.headers()["content-type"] || "";
  const ext = detectExtFromType(contentType, imageUrl);
  const outPath = `${outPathBase}-${String(ordinal).padStart(3, "0")}${ext}`;
  const buf = await resp.body();
  await fs.writeFile(outPath, buf);
  return outPath;
}

async function preprocessImage(inputPath, outputPath, { scale = 4, threshold = false } = {}) {
  const metadata = await sharp(inputPath).metadata();
  const sourceWidth = metadata.width || 0;
  let image = sharp(inputPath).rotate();
  if (sourceWidth > 0) {
    image = image.resize({
      width: Math.round(sourceWidth * scale),
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: false,
    });
  }
  image = image.grayscale().normalize().sharpen({ sigma: 0.7, m1: 0.8, m2: 1.2 });

  if (threshold) image = image.threshold(170);

  await image.png({ compressionLevel: 9 }).toFile(outputPath);
  return outputPath;
}

async function splitImage(inputPath, outputPrefix, { parts = 4, overlap = 0.08 } = {}) {
  const metadata = await sharp(inputPath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (width <= 0 || height <= 0) {
    throw new Error(`invalid image dimension: ${inputPath}`);
  }

  const chunk = Math.ceil(height / parts);
  const overlapPx = Math.floor(chunk * overlap);
  const outputs = [];

  for (let i = 0; i < parts; i++) {
    const start = Math.max(0, i * chunk - (i === 0 ? 0 : overlapPx));
    const end = Math.min(height, (i + 1) * chunk + (i === parts - 1 ? 0 : overlapPx));
    const h = Math.max(1, end - start);
    const outPath = `${outputPrefix}-part${String(i + 1).padStart(2, "0")}.png`;
    await sharp(inputPath).extract({ left: 0, top: start, width, height: h }).toFile(outPath);
    outputs.push(outPath);
  }

  return outputs;
}

class TesseractEngine {
  constructor() {
    this.worker = null;
  }

  async init() {
    if (this.worker) return;
    this.worker = await createWorker("kor+eng");
  }

  async ocr(imagePath) {
    if (!this.worker) await this.init();
    const result = await this.worker.recognize(imagePath);
    return sanitizeText(result?.data?.text || "");
  }

  async close() {
    if (!this.worker) return;
    await this.worker.terminate();
    this.worker = null;
  }
}

async function ocrWinRT(imagePath) {
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINRT_SCRIPT_PATH, "-ImagePath", imagePath],
      {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return sanitizeText(stdout || "");
  } catch (err) {
    throw new Error(`winrt ocr failed: ${err.message}`);
  }
}

function cleanDeepSeekOutput(rawText) {
  let text = (rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/<\|ref\|>.*?<\|\/ref\|><\|det\|>.*?<\|\/det\|>\s*/gs, "");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    let current = lines[i];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (/^[A-Za-z0-9\uac00-\ud7a3]{1,2}$/.test(next) && /[A-Za-z0-9\uac00-\ud7a3]$/.test(current)) {
        current += next;
        i += 1;
      } else {
        break;
      }
    }
    merged.push(current);
  }

  let cleaned = sanitizeText(merged.join("\n"));
  const replacements = [
    [/입수용신/g, "임수용신"],
    [/추워지는/g, "추위지는"],
    [/추억지는/g, "추위지는"],
    [/조금하고/g, "조급하고"],
    [/는높이/g, "눈높이"],
    [/감목/g, "갑목"],
    [/방향/g, "방합"],
    [/대함/g, "대합"],
    [/생\s*기/g, "생김"],
    [/생김는/g, "생기는"],
    [/건목격/g, "건록격"],
    [/검재/g, "겹재"],
    [/나타 조직/g, "나라 조직"],
    [/비접은/g, "비겁운"],
    [/잘 한다/g, "잘한다"],
  ];
  for (const [pattern, value] of replacements) {
    cleaned = cleaned.replace(pattern, value);
  }
  const paragraphized = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n");
  return sanitizeText(paragraphized);
}

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
    deepseekTimeoutMs: overrides.deepseekTimeoutMs ?? config.deepseekTimeoutMs,
    deepseekPython: overrides.deepseekPython ?? config.deepseekPython,
  };
}

function selectBestDeepSeekResult(candidates, { preferCoverage = false } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const normalized = candidates.map((candidate) => {
    const text = sanitizeText(candidate?.text || "");
    return {
      ...candidate,
      text,
      _len: text.length,
      _score: scoreText(text),
    };
  });
  const withText = normalized.filter((candidate) => candidate._len > 0);
  if (!withText.length) return normalized[0];

  let shortlist = withText;
  if (preferCoverage) {
    const bestScore = withText.reduce((best, candidate) => Math.max(best, candidate._score), Number.NEGATIVE_INFINITY);
    // Keep candidates near the best quality first; prevents runaway long garbage outputs.
    const qualityFiltered = withText.filter((candidate) => candidate._score >= bestScore - 3);
    if (qualityFiltered.length) shortlist = qualityFiltered;

    const maxLen = shortlist.reduce((best, candidate) => Math.max(best, candidate._len), 0);
    if (maxLen >= 200) {
      // Among quality-preserving candidates, prefer those close to full coverage.
      const minLen = Math.floor(maxLen * 0.9);
      const nearFull = shortlist.filter((candidate) => candidate._len >= minLen);
      if (nearFull.length) shortlist = nearFull;
    }
  }

  shortlist.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return b._len - a._len;
  });
  const selected = shortlist[0];
  const { _len, _score, ...rest } = selected;
  return rest;
}

async function ocrDeepSeekByMode(imagePaths, config, tempDir, warnings) {
  const passPlans = [
    {
      label: "primary",
      overrides:
        config.ocrMode === "high"
          ? {
              deepseekPrompt: DEEPSEEK_HIGH_PROMPT,
              deepseekCropMode: true,
              deepseekBaseSize: Math.max(config.deepseekBaseSize, 1024),
              deepseekMaxTokens: Math.max(config.deepseekMaxTokens, 1600),
              deepseek4bit: false,
            }
          : {},
    },
  ];
  if (config.ocrMode === "high" && config.deepseekHighMultipass) {
    passPlans.push(
      {
        label: "high-crop-false",
        overrides: {
          deepseekPrompt: DEEPSEEK_HIGH_PROMPT,
          deepseekCropMode: false,
          deepseekBaseSize: Math.max(config.deepseekBaseSize, 1024),
          deepseekMaxTokens: Math.max(config.deepseekMaxTokens, 1600),
          deepseek4bit: false,
        },
      },
      {
        label: "high-crop-true",
        overrides: {
          deepseekPrompt: DEEPSEEK_HIGH_PROMPT,
          deepseekCropMode: true,
          deepseekBaseSize: Math.max(config.deepseekBaseSize, 1024),
          deepseekMaxTokens: Math.max(config.deepseekMaxTokens, 1600),
          deepseek4bit: false,
        },
      },
    );
  }

  const runPass = async (pass) => {
    try {
      const results = await ocrDeepSeekBatch(imagePaths, config, tempDir, pass.overrides);
      return { pass, results, error: null };
    } catch (err) {
      return { pass, results: [], error: err };
    }
  };

  const runOutcomes = async (parallelLimit) => {
    if (parallelLimit <= 1 || passPlans.length <= 1) {
      const outputs = [];
      for (const pass of passPlans) {
        outputs.push(await runPass(pass));
      }
      return outputs;
    }
    return mapWithConcurrency(passPlans, parallelLimit, runPass);
  };

  const candidatesByImage = new Map();
  const passParallel = Math.max(1, Math.floor(config.deepseekParallel || 1));
  let preferredParallel = Math.min(passParallel, passPlans.length);
  if (preferredParallel > 1 && (config.ocrMode === "high" || !config.deepseek4bit)) {
    const reason =
      config.ocrMode === "high"
        ? "high mode forces non-4bit DeepSeek for quality, so parallel can exceed VRAM/pagefile limits"
        : "--deepseek-4bit is false";
    warnings.push(
      `DeepSeek parallel is disabled because ${reason}.`,
    );
    preferredParallel = 1;
  }
  let outcomes = await runOutcomes(preferredParallel);

  const applyOutcomes = (rows, { silent = false } = {}) => {
    for (const row of rows) {
      if (row.error) {
        if (!silent) warnings.push(`DeepSeek OCR ${row.pass.label} pass failed: ${row.error.message}`);
        continue;
      }
      for (const result of row.results) {
        const key = path.resolve(result.image);
        const candidate = { ...result, pass: row.pass.label };
        if (!candidatesByImage.has(key)) candidatesByImage.set(key, []);
        candidatesByImage.get(key).push(candidate);
      }
    }
  };
  applyOutcomes(outcomes);

  const hasAnyCandidate = [...candidatesByImage.values()].some((items) => items.length > 0);
  if (!hasAnyCandidate && preferredParallel > 1 && passPlans.length > 1) {
    warnings.push("DeepSeek OCR parallel pass run produced no result; retrying sequentially.");
    await killDeepSeekBatchProcesses();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    outcomes = await runOutcomes(1);
    applyOutcomes(outcomes);
  }
  const hasCandidateAfterRetry = [...candidatesByImage.values()].some((items) => items.length > 0);
  if (!hasCandidateAfterRetry && passParallel > 1) {
    await killDeepSeekBatchProcesses();
  }

  const preferCoverage = config.ocrMode === "high";
  const merged = new Map();
  for (const [key, candidates] of candidatesByImage.entries()) {
    const selected = selectBestDeepSeekResult(candidates, { preferCoverage });
    if (selected) merged.set(key, selected);
  }
  return merged;
}

async function ocrDeepSeekBatch(imagePaths, config, tempDir, overrides = {}) {
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
        HF_MODULES_CACHE: process.env.HF_MODULES_CACHE || path.join(__dirname, ".hf_modules_cache"),
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

function mimeFromExt(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

async function imagePathToDataUrl(imagePath) {
  const mime = mimeFromExt(imagePath);
  const data = await fs.readFile(imagePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

function normalizeChatContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.value || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return content.text || content.value || "";
  }
  return "";
}

function normalizeLmstudioBase(baseUrl) {
  const clean = (baseUrl || "").replace(/\/$/, "");
  if (!clean) return "http://127.0.0.1:1234/v1";
  if (clean.endsWith("/v1")) return clean;
  return `${clean}/v1`;
}

function normalizeSlmEndpoint(slmHost) {
  const clean = (slmHost || "").replace(/\/$/, "");
  if (!clean) return "http://127.0.0.1:11434/api/generate";
  if (clean.endsWith("/api/generate")) return clean;
  if (clean.endsWith("/api/v1/chat")) return clean;
  if (clean.endsWith("/chat/completions")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/chat/completions`;
  if (clean.includes("/api/v1/chat")) return clean;
  if (clean.includes("/chat/completions")) return clean;
  return `${clean}/api/generate`;
}

function extractSlmText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.response === "string") return payload.response;

  if (Array.isArray(payload.output)) {
    const content = payload.output
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        if (typeof item.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (content) return content;
  }

  const chatContent = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? "";
  return normalizeChatContent(chatContent);
}

async function ocrQwenVLBatch(imagePaths, config) {
  if (!imagePaths.length) return [];
  const base = normalizeLmstudioBase(config.lmstudioHost);
  const endpoint = `${base}/chat/completions`;
  const headers = { "content-type": "application/json" };
  const apiKey = config.lmstudioKey || process.env.LMSTUDIO_API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const timeoutMs = Math.max(5_000, config.lmstudioTimeoutMs || 120_000);
  const results = [];

  for (const imagePath of imagePaths) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const dataUrl = await imagePathToDataUrl(imagePath);
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: config.lmstudioModel,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You extract OCR text from an image. Return plain text only, no markdown, no explanation.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Extract all visible text exactly as read. Keep line breaks where reasonable. Output plain text only.",
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: Math.max(256, config.lmstudioMaxTokens || 1200),
        }),
      });

      if (!response.ok) {
        throw new Error(`http ${response.status}`);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? "";
      const text = sanitizeText(normalizeChatContent(content));
      results.push({ image: imagePath, text, error: "" });
    } catch (err) {
      results.push({ image: imagePath, text: "", error: `qwen vl failed: ${err.message}` });
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

async function polishTextWithSLM(rawText, config) {
  const input = sanitizeText(rawText);
  if (!input) return { text: "", applied: false, reason: "empty_input" };

  const endpoint = normalizeSlmEndpoint(config.slmHost);
  const isLmstudioSimpleChat = endpoint.includes("/api/v1/chat");
  const isOpenAIChat = endpoint.includes("/chat/completions");

  const prompt = [
    "You are fixing OCR output for Korean text.",
    "Rules:",
    "1) Keep original meaning and order.",
    "2) Fix spacing, punctuation and obvious OCR mistakes only.",
    "3) Do not summarize. Do not add new content.",
    "4) Return plain text only.",
    "",
    "OCR INPUT:",
    input,
  ].join("\n");

  const callSlm = async (timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      if (config.slmKey) headers.authorization = `Bearer ${config.slmKey}`;

      let body;
      if (isLmstudioSimpleChat) {
        body = {
          model: config.slmModel,
          system_prompt: "You fix OCR output. Return plain text only.",
          input: prompt,
        };
      } else if (isOpenAIChat) {
        body = {
          model: config.slmModel,
          temperature: 0.1,
          messages: [
            { role: "system", content: "You fix OCR output. Return plain text only." },
            { role: "user", content: prompt },
          ],
        };
      } else {
        body = {
          model: config.slmModel,
          prompt,
          stream: false,
          options: { temperature: 0.1 },
        };
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const timeoutMs = Math.max(5_000, config.slmTimeoutMs || 120_000);
    let response = await callSlm(timeoutMs);
    if (!response.ok && response.status >= 500) {
      response = await callSlm(timeoutMs);
    }
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }

    const payload = await response.json();
    const text = extractSlmText(payload);
    const polished = sanitizeText(text || "");
    if (!polished) {
      return { text: input, applied: false, reason: "empty_output" };
    }

    const originalScore = scoreText(input);
    const polishedScore = scoreText(polished);
    const keepPolished = polishedScore >= originalScore * 0.95 && polished.length >= Math.floor(input.length * 0.6);

    return {
      text: keepPolished ? polished : input,
      applied: keepPolished,
      reason: keepPolished ? "score_ok" : "score_drop",
      originalScore,
      polishedScore,
    };
  } catch (err) {
    return {
      text: input,
      applied: false,
      reason: `slm_error:${err.message}`,
    };
  }
}

function scoreText(text) {
  const total = text.length || 1;
  const hangul = (text.match(/[\uac00-\ud7a3]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const number = (text.match(/[0-9]/g) || []).length;
  const replacement = (text.match(/�/g) || []).length;
  const symbol = (text.match(/[~`!@#$%^&*()_=+\[\]{}|\\;:"'<>,/?]/g) || []).length;

  const useful = (hangul + latin + number) / total;
  const noise = (replacement + symbol) / total;
  const density = Math.min(total / 400, 1);

  return useful * 100 + density * 8 - noise * 80;
}

function selectBestText(textByEngine) {
  const candidates = [];
  for (const [engine, rawText] of Object.entries(textByEngine)) {
    const text = sanitizeText(rawText);
    if (!text) continue;
    candidates.push({ engine, text, score: scoreText(text) });
  }

  if (!candidates.length) {
    return { engine: "none", text: "", score: 0, candidates: [] };
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    engine: candidates[0].engine,
    text: candidates[0].text,
    score: candidates[0].score,
    candidates,
  };
}

function composeMarkdown(meta, blocks, ocrByIndex) {
  const lines = [];

  lines.push(`# ${meta.title || "제목 없음"}`);
  lines.push("");
  lines.push(`- 작성자: ${meta.author || "알 수 없음"}`);
  lines.push(`- 작성일: ${meta.date || "알 수 없음"}`);
  lines.push(`- 아카이브 시각: ${nowIso()}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const block of blocks) {
    if (block.type === "text") {
      const text = sanitizeText(block.text);
      if (text) {
        lines.push(text);
        lines.push("");
      }
      continue;
    }

    if (block.type === "image") {
      const ocr = ocrByIndex.get(block.index);
      const imageRel = ocr?.relativeOriginalPath || "";
      lines.push(`![image-${block.index}](${imageRel})`);
      lines.push("");
      if (ocr?.text) {
        lines.push("```text");
        lines.push(ocr.text);
        lines.push("```");
      } else {
        lines.push("```text");
        lines.push("[OCR 결과 없음]");
        lines.push("```");
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim() + "\n";
}

async function archiveArticle(config) {
  const startedAt = nowIso();
  const manifest = {
    version: "v1",
    startedAt,
    finishedAt: null,
    input: config,
    meta: {},
    stats: {
      blockCount: 0,
      textCount: 0,
      imageCount: 0,
      ocrSucceeded: 0,
      ocrFailed: 0,
      slmApplied: 0,
    },
    files: {
      markdown: null,
      originalImages: [],
      preprocessedImages: [],
      ocrTexts: [],
    },
    errors: [],
    warnings: [],
    ocrDecisions: [],
  };

  const dirs = await ensureDirs(config.outDir);
  const engineSet = resolveEngineSet(config.engine);
  let browser;
  let context;
  let shouldCloseContext = true;
  const tess = new TesseractEngine();

  try {
    if (config.cdp) {
      browser = await chromium.connectOverCDP(config.cdp);
      const existing = browser.contexts()[0];
      if (existing) {
        context = existing;
        shouldCloseContext = false;
      } else {
        context = await browser.newContext();
      }
    } else {
      browser = await chromium.launch({ headless: config.headless });
      context = await browser.newContext();
    }

    const page = await context.newPage();
    let article = await fetchArticle(config.url, page);
    if (!article.blocks.length) {
      manifest.warnings.push("No blocks extracted on first attempt; retrying once.");
      await page.waitForTimeout(1500);
      article = await fetchArticle(config.url, page);
    }
    manifest.meta = article.meta;

    const { textBlocks, imageBlocks } = classifyBlocks(article.blocks);
    if (engineSet.has("qwenvl") && !(await fileExists(config.lmstudioModelFile))) {
      manifest.warnings.push(`Qwen VL model file not found: ${config.lmstudioModelFile}`);
    }
    if (engineSet.has("deepseek") && !(await fileExists(config.deepseekModelDir))) {
      manifest.warnings.push(`DeepSeek OCR model dir not found: ${config.deepseekModelDir}`);
    }
    manifest.stats.blockCount = article.blocks.length;
    manifest.stats.textCount = textBlocks.length;
    manifest.stats.imageCount = imageBlocks.length;

    const ocrByIndex = new Map();
    const baseOriginalPrefix = path.join(dirs.original, "img");
    const preparedImages = [];

    for (let i = 0; i < imageBlocks.length; i++) {
      const imageBlock = imageBlocks[i];
      try {
        const originalPath = await downloadImage(context, imageBlock.url, baseOriginalPrefix, i + 1);
        manifest.files.originalImages.push(path.relative(dirs.root, originalPath));

        const prePath = path.join(dirs.preprocessed, `img-${String(i + 1).padStart(3, "0")}.png`);
        await preprocessImage(originalPath, prePath, {
          scale: config.scale,
          threshold: config.threshold,
        });
        manifest.files.preprocessedImages.push(path.relative(dirs.root, prePath));

        const needsSplit = engineSet.has("tesseract") || engineSet.has("winrt") || engineSet.has("qwenvl");
        const splits = needsSplit
          ? await splitImage(prePath, path.join(dirs.preprocessed, `img-${String(i + 1).padStart(3, "0")}`), {
              parts: config.parts,
              overlap: config.overlap,
            })
          : [];

        preparedImages.push({
          ordinal: i + 1,
          imageBlock,
          originalPath,
          prePath,
          splits,
        });
      } catch (err) {
        manifest.stats.ocrFailed += 1;
        manifest.errors.push({
          blockIndex: imageBlock.index,
          stage: "image_pipeline",
          message: err.message,
        });
      }
    }

    const deepseekByImagePath = new Map();
    if (engineSet.has("deepseek") && preparedImages.length) {
      const merged = await ocrDeepSeekByMode(
        preparedImages.map((item) => item.prePath),
        config,
        dirs.ocr,
        manifest.warnings,
      );
      for (const [imagePath, result] of merged.entries()) {
        deepseekByImagePath.set(path.resolve(imagePath), result);
      }
    }

    for (const item of preparedImages) {
      const { ordinal, imageBlock, originalPath, prePath, splits } = item;
      try {
        let tessTexts = [];
        let winrtTexts = [];
        let qwenvlTexts = [];
        let deepseekTexts = [];

        if (engineSet.has("tesseract")) {
          await tess.init();
          for (const splitPath of splits) {
            tessTexts.push(await tess.ocr(splitPath));
          }
        }

        if (engineSet.has("winrt")) {
          for (const splitPath of splits) {
            try {
              winrtTexts.push(await ocrWinRT(splitPath));
            } catch (err) {
              manifest.warnings.push(`WinRT OCR unavailable for ${splitPath}: ${err.message}`);
              winrtTexts = [];
              break;
            }
          }
        }

        if (engineSet.has("qwenvl")) {
          const qwenResults = await ocrQwenVLBatch(splits, config);
          qwenvlTexts = qwenResults
            .map((result) => {
              if (result.error) {
                manifest.warnings.push(`QwenVL OCR warning for ${result.image}: ${result.error}`);
              }
              return result.text || "";
            })
            .filter(Boolean);
        }

        if (engineSet.has("deepseek")) {
          const deepseekResult = deepseekByImagePath.get(path.resolve(prePath));
          if (!deepseekResult) {
            manifest.warnings.push(`DeepSeek OCR warning for ${prePath}: result missing`);
          } else if (deepseekResult.error) {
            manifest.warnings.push(`DeepSeek OCR warning for ${deepseekResult.image}: ${deepseekResult.error}`);
          } else if (deepseekResult.text) {
            deepseekTexts.push(deepseekResult.text);
          }
        }

        const tJoined = sanitizeText(tessTexts.join("\n"));
        const wJoined = sanitizeText(winrtTexts.join("\n"));
        const qJoined = sanitizeText(qwenvlTexts.join("\n"));
        const dJoined = sanitizeText(deepseekTexts.join("\n"));

        const selected = selectBestText({
          tesseract: tJoined,
          winrt: wJoined,
          qwenvl: qJoined,
          deepseek: dJoined,
        });

        if (tJoined) {
          const tPath = path.join(dirs.ocr, `img-${String(ordinal).padStart(3, "0")}-tesseract.txt`);
          await fs.writeFile(tPath, tJoined + "\n", "utf8");
          manifest.files.ocrTexts.push(path.relative(dirs.root, tPath));
        }
        if (wJoined) {
          const wPath = path.join(dirs.ocr, `img-${String(ordinal).padStart(3, "0")}-winrt.txt`);
          await fs.writeFile(wPath, wJoined + "\n", "utf8");
          manifest.files.ocrTexts.push(path.relative(dirs.root, wPath));
        }
        if (qJoined) {
          const qPath = path.join(dirs.ocr, `img-${String(ordinal).padStart(3, "0")}-qwenvl.txt`);
          await fs.writeFile(qPath, qJoined + "\n", "utf8");
          manifest.files.ocrTexts.push(path.relative(dirs.root, qPath));
        }
        if (dJoined) {
          const dPath = path.join(dirs.ocr, `img-${String(ordinal).padStart(3, "0")}-deepseek.txt`);
          await fs.writeFile(dPath, dJoined + "\n", "utf8");
          manifest.files.ocrTexts.push(path.relative(dirs.root, dPath));
        }

        let finalText = selected.text;
        let slmInfo = { enabled: Boolean(config.slm), applied: false, reason: "disabled" };
        if (config.slm && selected.text) {
          const polished = await polishTextWithSLM(selected.text, config);
          finalText = polished.text;
          if (polished.reason?.startsWith("slm_error:")) {
            manifest.warnings.push(`SLM polish skipped for block ${imageBlock.index}: ${polished.reason}`);
          }
          slmInfo = {
            enabled: true,
            applied: polished.applied,
            reason: polished.reason,
            originalScore: polished.originalScore,
            polishedScore: polished.polishedScore,
            model: config.slmModel,
          };
          if (polished.applied) manifest.stats.slmApplied += 1;
        }

        if (finalText) {
          manifest.stats.ocrSucceeded += 1;
        } else {
          manifest.stats.ocrFailed += 1;
        }

        manifest.ocrDecisions.push({
          blockIndex: imageBlock.index,
          selectedEngine: selected.engine,
          selectedScore: selected.score,
          candidates: selected.candidates,
          slm: slmInfo,
        });

        ocrByIndex.set(imageBlock.index, {
          text: finalText,
          relativeOriginalPath: path.relative(dirs.root, originalPath).replace(/\\/g, "/"),
        });
      } catch (err) {
        manifest.stats.ocrFailed += 1;
        manifest.errors.push({
          blockIndex: imageBlock.index,
          stage: "ocr_pipeline",
          message: err.message,
        });
      }
    }

    const slugSource = article.meta.title || new URL(config.url).pathname.split("/").filter(Boolean).pop();
    const slug = slugify(slugSource);
    const markdown = composeMarkdown(article.meta, article.blocks, ocrByIndex);
    const mdPath = path.join(dirs.root, `${slug}.md`);
    await fs.writeFile(mdPath, markdown, "utf8");

    manifest.files.markdown = path.relative(dirs.root, mdPath);
    manifest.finishedAt = nowIso();

    const manifestPath = path.join(dirs.root, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return { manifest, mdPath, manifestPath };
  } catch (err) {
    manifest.errors.push({ stage: "fatal", message: err.message });
    manifest.finishedAt = nowIso();

    const manifestPath = path.join(config.outDir, "manifest.json");
    await fs.mkdir(config.outDir, { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    throw err;
  } finally {
    await tess.close().catch(() => {});
    if (context && shouldCloseContext) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

function printUsage() {
  const script = path.basename(__filename);
  console.log(`Usage:\n  node ${script} --url <url> --out <directory> [--engine tesseract|winrt|qwenvl|deepseek|both|all] [--ocr-mode fast|normal|high] [--scale 4] [--parts 4] [--overlap 0.08] [--threshold true|false] [--lmstudio-host http://127.0.0.1:1234/v1] [--lmstudio-model qwen3-vl-4b-instruct] [--lmstudio-model-file ./models/Qwen3-VL-4B-Instruct-Q6_K.gguf] [--lmstudio-timeout 120000] [--lmstudio-max-tokens 1200] [--lmstudio-key <key>] [--deepseek-python .venv-deepseekocr2/Scripts/python.exe] [--deepseek-model-dir ./models/deepseek-ocr-2] [--deepseek-timeout 1800000] [--deepseek-max-tokens 1200] [--deepseek-parallel 1] [--deepseek-high-multipass true|false] [--deepseek-prompt \"<image>\\n<|grounding|>Convert the document to markdown.\"] [--slm true|false] [--slm-model llama-3.1-korean-8b-instruct] [--slm-host http://127.0.0.1:11434] [--slm-key <key>] [--slm-timeout 120000] [--cdp http://127.0.0.1:9222] [--headless true|false]\n  note: engine=all runs tesseract+winrt+qwenvl+deepseek.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      out: { type: "string" },
      engine: { type: "string", default: "qwenvl" },
      "ocr-mode": { type: "string", default: "normal" },
      scale: { type: "string", default: "4" },
      parts: { type: "string", default: "4" },
      overlap: { type: "string", default: "0.08" },
      threshold: { type: "string", default: "false" },
      "lmstudio-host": { type: "string", default: "http://127.0.0.1:1234/v1" },
      "lmstudio-model": { type: "string", default: "qwen3-vl-4b-instruct" },
      "lmstudio-model-file": { type: "string" },
      "lmstudio-timeout": { type: "string", default: "120000" },
      "lmstudio-max-tokens": { type: "string", default: "1200" },
      "lmstudio-key": { type: "string" },
      "deepseek-python": { type: "string" },
      "deepseek-model-dir": { type: "string" },
      "deepseek-timeout": { type: "string", default: "1800000" },
      "deepseek-max-tokens": { type: "string", default: "1200" },
      "deepseek-parallel": { type: "string", default: "1" },
      "deepseek-high-multipass": { type: "string", default: "false" },
      "deepseek-prompt": { type: "string", default: "<image>\n<|grounding|>Convert the document to markdown." },
      "deepseek-device": { type: "string", default: "cuda" },
      "deepseek-device-map": { type: "string", default: "auto" },
      "deepseek-4bit": { type: "string", default: "false" },
      "deepseek-attn": { type: "string", default: "eager" },
      "deepseek-base-size": { type: "string", default: "1024" },
      "deepseek-image-size": { type: "string", default: "768" },
      "deepseek-crop": { type: "string", default: "true" },
      slm: { type: "string", default: "false" },
      "slm-model": { type: "string", default: "llama-3.1-korean-8b-instruct" },
      "slm-host": { type: "string", default: "http://127.0.0.1:11434" },
      "slm-key": { type: "string" },
      "slm-timeout": { type: "string", default: "120000" },
      cdp: { type: "string" },
      headless: { type: "string", default: "true" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help || !values.url || !values.out) {
    printUsage();
    process.exit(values.help ? 0 : 1);
  }

  const engine = ["tesseract", "winrt", "qwenvl", "deepseek", "both", "all"].includes(values.engine)
    ? values.engine
    : "qwenvl";
  const requestedMode = String(values["ocr-mode"] || "normal").toLowerCase();
  const ocrMode = requestedMode === "quality" ? "normal" : requestedMode;
  const resolvedMode = ["fast", "normal", "high"].includes(ocrMode) ? ocrMode : "normal";
  const modeDefaults = DEEPSEEK_OCR_MODES[resolvedMode];

  const config = {
    url: values.url,
    outDir: path.resolve(values.out),
    engine,
    ocrMode: resolvedMode,
    scale: Math.max(1, ensureNumber(values.scale, 4)),
    parts: Math.max(1, Math.floor(ensureNumber(values.parts, 4))),
    overlap: Math.min(0.45, Math.max(0, ensureNumber(values.overlap, 0.08))),
    threshold: String(values.threshold).toLowerCase() === "true",
    lmstudioHost: values["lmstudio-host"] || "http://127.0.0.1:1234/v1",
    lmstudioModel: values["lmstudio-model"] || "qwen3-vl-4b-instruct",
    lmstudioModelFile: path.resolve(values["lmstudio-model-file"] || DEFAULT_QWEN_VL_MODEL_FILE),
    lmstudioTimeoutMs: Math.max(5_000, ensureNumber(values["lmstudio-timeout"], 120_000)),
    lmstudioMaxTokens: Math.max(128, Math.floor(ensureNumber(values["lmstudio-max-tokens"], 1200))),
    lmstudioKey: values["lmstudio-key"],
    deepseekPython: values["deepseek-python"],
    deepseekModelDir: path.resolve(values["deepseek-model-dir"] || DEFAULT_DEEPSEEK_MODEL_DIR),
    deepseekTimeoutMs: Math.max(30_000, ensureNumber(values["deepseek-timeout"], 900_000)),
    deepseekMaxTokens: Math.max(64, Math.floor(ensureNumber(values["deepseek-max-tokens"], 900))),
    deepseekParallel: Math.max(1, Math.floor(ensureNumber(values["deepseek-parallel"], 1))),
    deepseekHighMultipass: String(values["deepseek-high-multipass"]).toLowerCase() === "true",
    deepseekPrompt: values["deepseek-prompt"] || "<image>\n<|grounding|>Convert the document to markdown.",
    deepseekDevice: values["deepseek-device"] || "cuda",
    deepseekDeviceMap: values["deepseek-device-map"] || "cuda:0",
    deepseek4bit: String(values["deepseek-4bit"]).toLowerCase() !== "false",
    deepseekAttnImplementation: values["deepseek-attn"] || "eager",
    deepseekBaseSize: Math.max(256, Math.floor(ensureNumber(values["deepseek-base-size"], 1024))),
    deepseekImageSize: Math.max(256, Math.floor(ensureNumber(values["deepseek-image-size"], 768))),
    deepseekCropMode: String(values["deepseek-crop"]).toLowerCase() !== "false",
    slm: String(values.slm).toLowerCase() === "true",
    slmModel: values["slm-model"] || "llama-3.1-korean-8b-instruct",
    slmHost: values["slm-host"] || "http://127.0.0.1:11434",
    slmKey: values["slm-key"],
    slmTimeoutMs: Math.max(5_000, ensureNumber(values["slm-timeout"], 120_000)),
    cdp: values.cdp,
    headless: String(values.headless).toLowerCase() !== "false",
  };

  if (!hasCliOption("scale")) {
    config.scale = modeDefaults.scale;
  }
  if (!hasCliOption("deepseek-4bit")) {
    config.deepseek4bit = modeDefaults.deepseek4bit;
  }
  if (!hasCliOption("deepseek-max-tokens")) {
    config.deepseekMaxTokens = modeDefaults.deepseekMaxTokens;
  }
  if (!hasCliOption("deepseek-base-size")) {
    config.deepseekBaseSize = modeDefaults.deepseekBaseSize;
  }
  if (!hasCliOption("deepseek-image-size")) {
    config.deepseekImageSize = modeDefaults.deepseekImageSize;
  }
  if (!hasCliOption("deepseek-crop")) {
    config.deepseekCropMode = modeDefaults.deepseekCropMode;
  }
  if (!hasCliOption("deepseek-attn")) {
    config.deepseekAttnImplementation = modeDefaults.deepseekAttnImplementation;
  }

  const result = await archiveArticle(config);
  console.log(`Saved markdown: ${result.mdPath}`);
  console.log(`Saved manifest: ${result.manifestPath}`);
  console.log(`Text blocks: ${result.manifest.stats.textCount}, image blocks: ${result.manifest.stats.imageCount}`);
  console.log(`OCR success: ${result.manifest.stats.ocrSucceeded}, OCR failed: ${result.manifest.stats.ocrFailed}`);
}

main().catch((err) => {
  console.error("Archive failed:", err.message);
  process.exit(1);
});
