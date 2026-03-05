import { sanitizeText, normalizeChatContent } from "../lib/utils.mjs";
import { scoreText } from "./scoring.mjs";

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

/**
 * Polish OCR text using a local SLM (e.g., Ollama Gemma).
 *
 * @param {string} rawText - OCR output text
 * @param {object} config - SLM config { slmHost, slmModel, slmKey, slmTimeoutMs }
 * @returns {Promise<{ text: string, applied: boolean, reason: string }>}
 */
export async function polishTextWithSLM(rawText, config = {}) {
  const input = sanitizeText(rawText);
  if (!input) return { text: "", applied: false, reason: "empty_input" };

  const endpoint = normalizeSlmEndpoint(config.slmHost);
  const isLmstudioSimpleChat = endpoint.includes("/api/v1/chat");
  const isOpenAIChat = endpoint.includes("/chat/completions");

  const systemPrompt = [
    "역할: 너는 OCR 교정 전문가다.",
    "문장의 의미를 바꾸지 말고, 최대한 원문 형태를 유지하면서 명백한 OCR 오류만 수정하라.",
    "",
    "절차:",
    "1. 먼저 텍스트의 주제/도메인을 파악하라.",
    "2. 해당 도메인의 전문 용어를 기준으로, 유사한 글자로 오인식된 단어를 교정하라.",
    "",
    "목표:",
    "- 원문과의 편집 거리(Edit Distance)를 최소화하라.",
    "- 새로운 문장을 추가하거나 삭제하지 마라.",
    "- 문장 구조를 재구성하지 마라.",
    "- 단어를 임의로 교체하지 마라.",
    "- 추론하지 마라.",
    "- 문맥 보정은 오직 명백한 OCR 오류일 때만 수행하라.",
    "- 명백한 맞춤법 오류(예: 트랜드→트렌드)도 함께 수정하라.",
    "",
    "출력 규칙:",
    "- 수정된 전체 텍스트만 출력",
    "- 설명 금지",
    "- 수정이 없으면 원문 그대로 출력",
  ].join("\n");

  const prompt = [systemPrompt, "", "원문:", input].join("\n");

  const callSlm = async (timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      if (config.slmKey) headers.authorization = `Bearer ${config.slmKey}`;

      let body;
      if (isLmstudioSimpleChat) {
        body = { model: config.slmModel, system_prompt: systemPrompt, input: prompt };
      } else if (isOpenAIChat) {
        body = {
          model: config.slmModel,
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
        };
      } else {
        body = { model: config.slmModel, prompt, stream: false, options: { temperature: 0.1 } };
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
    };
  } catch (err) {
    return {
      text: input,
      applied: false,
      reason: `slm_error:${err.message}`,
    };
  }
}
