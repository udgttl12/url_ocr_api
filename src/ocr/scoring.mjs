import { sanitizeText } from "../lib/utils.mjs";

export function scoreText(text) {
  const total = text.length || 1;
  const hangul = (text.match(/[\uac00-\ud7a3]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const number = (text.match(/[0-9]/g) || []).length;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const symbol = (text.match(/[~`!@#$%^&*()_=+\[\]{}|\\;:"'<>,/?]/g) || []).length;

  const useful = (hangul + latin + number) / total;
  const noise = (replacement + symbol) / total;
  const density = Math.min(total / 400, 1);

  return useful * 100 + density * 8 - noise * 80;
}

export function selectBestText(textByEngine) {
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

export function cleanDeepSeekOutput(rawText) {
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

export function selectBestDeepSeekResult(candidates) {
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

  withText.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return b._len - a._len;
  });
  const selected = withText[0];
  const { _len, _score, ...rest } = selected;
  return rest;
}
