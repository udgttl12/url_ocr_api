import fs from "node:fs/promises";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function ensureNumber(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function mapWithConcurrency(items, limit, worker) {
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

export function sanitizeText(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function mimeFromExt(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

export async function imagePathToDataUrl(imagePath) {
  const mime = mimeFromExt(imagePath);
  const data = await fs.readFile(imagePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

export function normalizeChatContent(content) {
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

export function normalizeLmstudioBase(baseUrl) {
  const clean = (baseUrl || "").replace(/\/$/, "");
  if (!clean) return "http://127.0.0.1:1234/v1";
  if (clean.endsWith("/v1")) return clean;
  return `${clean}/v1`;
}
