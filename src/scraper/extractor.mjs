import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Extract images and text from a web page URL using Playwright.
 * Supports Naver Cafe iframe pages and general web pages.
 *
 * @param {string} url - The web page URL to extract from
 * @returns {Promise<{ meta: object, textBlocks: string[], imageUrls: string[] }>}
 */
export async function extractImagesFromUrl(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    // Naver Cafe: resolve iframe
    let frame = page.mainFrame();
    const isCafe = /cafe\.naver\.com/i.test(url);
    if (isCafe) {
      await page.waitForSelector("iframe#cafe_main", { timeout: 10_000 }).catch(() => {});
      const iframe = await page.$("iframe#cafe_main");
      const cafeFrame =
        (await iframe?.contentFrame()) ||
        page.frame({ name: "cafe_main" });
      if (cafeFrame) frame = cafeFrame;
    }

    const extracted = await frame.evaluate(() => {
      const titleSelectors = [
        ".title_text", ".ArticleTitle", ".article_title", ".se-title-text",
        "h1", "h2", "h3", "title",
      ];
      const authorSelectors = [
        ".nickname", ".writer_info .nickname", ".article_writer .nickname",
        ".member_info .nickname",
      ];
      const dateSelectors = [
        ".date", ".article_info .date", ".writer_info .date", ".se_publishDate",
      ];
      const contentSelectors = [
        ".se-main-container", ".ContentRenderer", ".article_viewer",
        "#tbody", "#main-area", "article", "main", "body",
      ];

      const readFirst = (selectors) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el?.textContent?.trim()) return el.textContent.trim();
        }
        return "";
      };

      const root = contentSelectors
        .map((sel) => document.querySelector(sel))
        .find((node) => node);

      if (!root) {
        return {
          meta: { title: readFirst(titleSelectors), author: readFirst(authorSelectors), date: readFirst(dateSelectors) },
          textBlocks: [],
          imageUrls: [],
        };
      }

      const textBlockTags = new Set([
        "P", "LI", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6",
        "TD", "TH", "SPAN", "DIV",
      ]);

      const textBlocks = [];
      const imageUrls = [];
      const seenImages = new Set();

      const pushText = (text) => {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (!normalized) return;
        const prev = textBlocks[textBlocks.length - 1];
        if (prev) {
          textBlocks[textBlocks.length - 1] += "\n" + normalized;
        } else {
          textBlocks.push(normalized);
        }
      };

      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      );

      while (walker.nextNode()) {
        const node = walker.currentNode;

        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node;
          if (el.tagName === "IMG") {
            const src = el.getAttribute("src") || el.getAttribute("data-src");
            if (src && !src.startsWith("data:") && !seenImages.has(src)) {
              seenImages.add(src);
              imageUrls.push(src);
            }
          }
          // Start new text block on block-level elements
          if (["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE"].includes(el.tagName)) {
            const last = textBlocks[textBlocks.length - 1];
            if (last && last.trim()) {
              textBlocks.push(""); // separator for new block
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

      return {
        meta: { title: readFirst(titleSelectors), author: readFirst(authorSelectors), date: readFirst(dateSelectors) },
        textBlocks: textBlocks.filter((t) => t.trim()),
        imageUrls,
      };
    });

    // Convert relative image URLs to absolute
    const absoluteImageUrls = extracted.imageUrls.map((src) => {
      try {
        return new URL(src, url).toString();
      } catch {
        return src;
      }
    });

    await context.close();

    return {
      meta: extracted.meta,
      textBlocks: extracted.textBlocks,
      imageUrls: absoluteImageUrls,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Download a page image using Playwright browser context.
 *
 * @param {string} imageUrl - URL of the image to download
 * @param {string} tempDir - Directory to save the downloaded image
 * @param {number} ordinal - Image index for filename
 * @returns {Promise<string>} Path to downloaded image file
 */
export async function downloadPageImage(imageUrl, tempDir, ordinal) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const resp = await context.request.get(imageUrl, { timeout: 60_000 });
    if (!resp.ok()) {
      throw new Error(`Image download failed (${resp.status()}): ${imageUrl}`);
    }
    const contentType = resp.headers()["content-type"] || "";
    const ext = detectExtFromType(contentType, imageUrl);
    const outPath = path.join(tempDir, `img-${String(ordinal).padStart(3, "0")}${ext}`);
    const buf = await resp.body();
    await fs.writeFile(outPath, buf);
    await context.close();
    return outPath;
  } finally {
    await browser.close();
  }
}

/**
 * Download multiple images in batch, reusing a single browser instance.
 *
 * @param {string[]} imageUrls - Array of image URLs
 * @param {string} tempDir - Directory to save downloaded images
 * @returns {Promise<Array<{ index: number, imageUrl: string, localPath: string | null, error: string | null }>>}
 */
export async function downloadPageImages(imageUrls, tempDir) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    const context = await browser.newContext();
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      try {
        const resp = await context.request.get(imageUrl, { timeout: 60_000 });
        if (!resp.ok()) {
          results.push({ index: i, imageUrl, localPath: null, error: `HTTP ${resp.status()}` });
          continue;
        }
        const contentType = resp.headers()["content-type"] || "";
        const ext = detectExtFromType(contentType, imageUrl);
        const outPath = path.join(tempDir, `img-${String(i).padStart(3, "0")}${ext}`);
        const buf = await resp.body();
        await fs.writeFile(outPath, buf);
        results.push({ index: i, imageUrl, localPath: outPath, error: null });
      } catch (err) {
        results.push({ index: i, imageUrl, localPath: null, error: err.message });
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return results;
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
