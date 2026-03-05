import { Router } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { upload } from "./middleware.mjs";
import { createJob, getJob, updateJob } from "./jobs.mjs";
import { buildOcrConfig } from "../lib/config.mjs";
import { runOcrPipeline } from "../ocr/pipeline.mjs";
import { extractImagesFromUrl, downloadPageImages } from "../scraper/extractor.mjs";
import { polishTextWithSLM } from "../ocr/slm.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(PROJECT_ROOT, "out");

const router = Router();

// GET /api/health
router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// GET /api/ocr/engines
router.get("/ocr/engines", (_req, res) => {
  res.json({
    engines: [
      { name: "deepseek", description: "DeepSeek OCR2 (CUDA required)" },
    ],
  });
});

/**
 * Download an image from a URL to a temp file.
 */
async function downloadImageFromUrl(imageUrl) {
  const tempPath = path.join(
    os.tmpdir(),
    `ocr-download-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(new URL(imageUrl).pathname) || ".png"}`,
  );

  return new Promise((resolve, reject) => {
    const mod = imageUrl.startsWith("https") ? https : http;
    mod.get(imageUrl, { timeout: 60_000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Follow redirect
        downloadImageFromUrl(response.headers.location).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${response.statusCode}`));
        return;
      }
      const ws = createWriteStream(tempPath);
      pipeline(response, ws).then(() => resolve(tempPath)).catch(reject);
    }).on("error", reject);
  });
}

/**
 * Resolve image path from request (file upload or imageUrl).
 * Returns { imagePath, shouldCleanup }
 */
async function resolveImagePath(req) {
  if (req.file) {
    return { imagePath: req.file.path, shouldCleanup: true };
  }

  const imageUrl = req.body?.imageUrl;
  if (imageUrl) {
    try {
      new URL(imageUrl);
    } catch {
      throw new Error("Invalid imageUrl format");
    }
    const tempPath = await downloadImageFromUrl(imageUrl);
    return { imagePath: tempPath, shouldCleanup: true };
  }

  throw new Error("No image provided. Upload a file (field: image) or provide imageUrl in body.");
}

/**
 * Run OCR and clean up temp files.
 */
async function executeOcr(imagePath, config, shouldCleanup) {
  try {
    return await runOcrPipeline(imagePath, config);
  } finally {
    if (shouldCleanup) {
      await fs.unlink(imagePath).catch(() => {});
    }
  }
}

// POST /api/ocr
router.post("/ocr", upload.single("image"), async (req, res, next) => {
  try {
    const { imagePath, shouldCleanup } = await resolveImagePath(req);
    const config = buildOcrConfig(req.body || {});
    const isAsync = req.query.async === "true";

    if (isAsync) {
      const job = createJob();
      updateJob(job.jobId, { status: "processing" });

      // Fire and forget
      executeOcr(imagePath, config, shouldCleanup)
        .then((result) => {
          updateJob(job.jobId, { status: "completed", result });
        })
        .catch((err) => {
          updateJob(job.jobId, { status: "failed", error: err.message });
        });

      return res.status(202).json({
        jobId: job.jobId,
        status: "pending",
        pollUrl: `/api/ocr/jobs/${job.jobId}`,
      });
    }

    // Sync mode
    const result = await executeOcr(imagePath, config, shouldCleanup);
    res.json({ status: "completed", result });
  } catch (err) {
    next(err);
  }
});

// POST /api/ocr/extract
router.post("/ocr/extract", async (req, res, next) => {
  try {
    const { url, engine, ocrMode, scale, parts, slm, slmModel, slmHost, slmKey } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid url format" });
    }

    const config = buildOcrConfig({ engine, ocrMode, scale, parts });
    const slmConfig = slm ? {
      slmHost: slmHost || "http://127.0.0.1:11434",
      slmModel: slmModel || "gemma3:12b",
      slmKey: slmKey || "",
      slmTimeoutMs: 300_000,
    } : null;
    const isAsync = req.query.async === "true";

    if (isAsync) {
      const job = createJob();
      updateJob(job.jobId, { status: "processing" });
      runExtractPipeline(url, config, slmConfig)
        .then((result) => updateJob(job.jobId, { status: "completed", result }))
        .catch((err) => updateJob(job.jobId, { status: "failed", error: err.message }));
      return res.status(202).json({
        jobId: job.jobId,
        status: "pending",
        pollUrl: `/api/ocr/jobs/${job.jobId}`,
      });
    }

    const result = await runExtractPipeline(url, config, slmConfig);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Slugify a string for safe folder/file names.
 */
function slugify(input) {
  const base = (input || "article").trim().toLowerCase();
  const slug = base
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[^a-z0-9\uac00-\ud7a3\s\-_]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `article-${Date.now()}`;
}

/**
 * Save extract results to out/ folder (markdown + images + manifest.json).
 */
async function saveExtractResult(url, meta, pageText, images, fullText, downloads) {
  const slugSource = meta.title || new URL(url).pathname.split("/").filter(Boolean).pop();
  const slug = slugify(slugSource);
  const outDir = path.join(OUT_DIR, slug);
  const assetsDir = path.join(outDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  // Copy downloaded images to assets/
  for (const dl of downloads) {
    if (!dl.localPath) continue;
    const dest = path.join(assetsDir, path.basename(dl.localPath));
    await fs.copyFile(dl.localPath, dest).catch(() => {});
  }

  // Build markdown
  const lines = [];
  if (meta.title) lines.push(`# ${meta.title}\n`);
  if (meta.author || meta.date) lines.push(`> ${[meta.author, meta.date].filter(Boolean).join(" | ")}\n`);
  lines.push(`**URL:** ${url}\n`);
  if (pageText) lines.push(`## 페이지 텍스트\n\n${pageText}\n`);
  if (images.length) {
    lines.push(`## OCR 결과\n`);
    for (const img of images) {
      lines.push(`### 이미지 ${img.index}`);
      lines.push(`![image](${img.imageUrl})\n`);
      if (img.ocr?.text) {
        lines.push(`**엔진:** ${img.ocr.selectedEngine} (score: ${img.ocr.score})\n`);
        lines.push("```\n" + img.ocr.text + "\n```\n");
      } else if (img.error) {
        lines.push(`> 오류: ${img.error}\n`);
      }
    }
  }
  lines.push(`## 전체 텍스트\n\n${fullText}\n`);

  const markdown = lines.join("\n");
  const mdPath = path.join(outDir, `${slug}.md`);
  await fs.writeFile(mdPath, markdown, "utf8");

  // fulltext.txt for easy access
  await fs.writeFile(path.join(outDir, "fulltext.txt"), fullText, "utf8");

  // manifest.json
  const manifest = {
    url,
    meta,
    engine: images[0]?.ocr?.selectedEngine || "unknown",
    imageCount: images.length,
    createdAt: new Date().toISOString(),
    files: {
      markdown: `${slug}.md`,
      fulltext: "fulltext.txt",
    },
  };
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return { outDir, mdPath };
}

/**
 * Full extraction pipeline: open page → extract images → download → OCR each → SLM 후보정 → save to out/.
 */
async function runExtractPipeline(url, config, slmConfig = null) {
  const { meta, textBlocks, imageUrls } = await extractImagesFromUrl(url);
  const pageText = textBlocks.join("\n\n");

  if (imageUrls.length === 0) {
    const result = { status: "completed", url, meta, pageText, images: [], fullText: pageText };
    const { outDir } = await saveExtractResult(url, meta, pageText, [], pageText, []);
    result.outDir = outDir;
    return result;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-extract-"));
  try {
    const downloads = await downloadPageImages(imageUrls, tempDir);
    const images = [];

    for (const dl of downloads) {
      if (!dl.localPath) {
        images.push({ index: dl.index, imageUrl: dl.imageUrl, ocr: null, error: dl.error });
        continue;
      }
      try {
        const ocrResult = await runOcrPipeline(dl.localPath, config);
        images.push({
          index: dl.index,
          imageUrl: dl.imageUrl,
          ocr: {
            selectedEngine: ocrResult.selectedEngine,
            text: ocrResult.text,
            score: ocrResult.score,
          },
        });
      } catch (err) {
        images.push({ index: dl.index, imageUrl: dl.imageUrl, ocr: null, error: err.message });
      }
    }

    // SLM 후보정
    let slmInfo = null;
    if (slmConfig) {
      slmInfo = [];
      for (const img of images) {
        if (!img.ocr?.text) continue;
        const result = await polishTextWithSLM(img.ocr.text, slmConfig);
        slmInfo.push({ index: img.index, applied: result.applied, reason: result.reason });
        if (result.applied) {
          img.ocr.textBeforeSlm = img.ocr.text;
          img.ocr.text = result.text;
          img.ocr.slmApplied = true;
        }
      }
    }

    const ocrTexts = images
      .filter((img) => img.ocr?.text)
      .map((img) => img.ocr.text);
    const fullText = [pageText, ...ocrTexts].filter(Boolean).join("\n\n");

    const { outDir } = await saveExtractResult(url, meta, pageText, images, fullText, downloads);

    return {
      status: "completed",
      url,
      meta,
      pageText,
      images,
      fullText,
      outDir,
      ...(slmInfo ? { slm: slmInfo } : {}),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// GET /api/ocr/jobs/:jobId
router.get("/ocr/jobs/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

// GET /api/results - 저장된 결과 목록
router.get("/results", async (_req, res, next) => {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const entries = await fs.readdir(OUT_DIR, { withFileTypes: true });
    const results = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(OUT_DIR, entry.name, "manifest.json");
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        results.push({
          name: entry.name,
          ...manifest,
          files: {
            ...manifest.files,
            markdownUrl: `/out/${encodeURIComponent(entry.name)}/${manifest.files.markdown}`,
            fulltextUrl: `/out/${encodeURIComponent(entry.name)}/${manifest.files.fulltext}`,
            manifestUrl: `/out/${encodeURIComponent(entry.name)}/manifest.json`,
          },
        });
      } catch {
        // manifest 없는 폴더는 건너뜀
      }
    }

    results.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json({ count: results.length, results });
  } catch (err) {
    next(err);
  }
});

// GET /api/results/:name - 특정 결과의 fulltext 반환
router.get("/results/:name", async (req, res, next) => {
  try {
    const name = req.params.name;
    const fulltextPath = path.join(OUT_DIR, name, "fulltext.txt");
    const text = await fs.readFile(fulltextPath, "utf8");
    res.type("text/plain; charset=utf-8").send(text);
  } catch {
    res.status(404).json({ error: "Result not found" });
  }
});

// DELETE /api/results/:name - 특정 결과 삭제
router.delete("/results/:name", async (req, res, next) => {
  try {
    const name = req.params.name;
    const targetDir = path.join(OUT_DIR, name);
    await fs.rm(targetDir, { recursive: true, force: true });
    res.json({ status: "deleted", name });
  } catch (err) {
    next(err);
  }
});

export default router;
