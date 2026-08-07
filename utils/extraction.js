const cheerio = require("cheerio");
const { MAX_TEXT_LENGTH } = require("./validate");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const EXTRACT_INSTRUCTION = `You are a meticulous, experienced data entry operator with years of back-office experience. Read the provided material carefully and convert it into clean tabular data exactly as a professional operator would: consistent formatting, correct field separation, no dropped rows. Infer sensible column headers from the content (e.g. Name, Date, Amount, Description) rather than dumping raw text. Normalize dates and currency formats where the source is clearly one format. If a value is ambiguous, missing, or unreadable, use an empty string rather than guessing or inventing data.

For EVERY row, also give an honest confidence score from 0-100 for how certain you are that row was read correctly - 95+ for clearly printed/typed text you're certain about, 60-80 for readable but slightly ambiguous content, below 50 for blurry, handwritten, or genuinely uncertain fields. Be honest and calibrated, not falsely confident - the point of this score is to tell a human reviewer exactly which rows need a second look, so it needs to be trustworthy, not reassuring.

Respond with ONLY raw JSON, no markdown fences, no commentary, in this exact shape:
{"columns": ["Col1","Col2"], "rows": [{"Col1":"value","Col2":"value"}], "confidence": [95, 60, ...]}
The confidence array must have exactly one number per row, in the same order as the rows array.`;

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Safety net: if the model's confidence array is missing or mismatched in length, don't let
// a malformed AI response break the client - pad/trim it so it always lines up with rows.
function normalizeConfidence(parsed) {
  const rowCount = Array.isArray(parsed.rows) ? parsed.rows.length : 0;
  if (!Array.isArray(parsed.confidence)) {
    parsed.confidence = new Array(rowCount).fill(null);
    return parsed;
  }
  if (parsed.confidence.length < rowCount) {
    parsed.confidence = [...parsed.confidence, ...new Array(rowCount - parsed.confidence.length).fill(null)];
  } else if (parsed.confidence.length > rowCount) {
    parsed.confidence = parsed.confidence.slice(0, rowCount);
  }
  parsed.confidence = parsed.confidence.map((c) => (typeof c === "number" && c >= 0 && c <= 100 ? Math.round(c) : null));
  return parsed;
}

async function callGemini(parts) {
  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2 } }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no usable content");
  const parsed = extractJson(text);
  return normalizeConfidence(parsed);
}

// Strips a fetched HTML page down to readable text a model can reason about.
function htmlToReadableText($) {
  $("script, style, noscript, svg, nav, footer, header, iframe").remove();
  const title = $("title").text().trim();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  return `${title}\n\n${bodyText}`.slice(0, MAX_TEXT_LENGTH);
}

/**
 * Fetches a URL server-side, reads its content, and extracts structured data.
 * Used by both the manual /api/extract/url route and scheduled recurring extraction.
 * Throws on failure - caller decides how to surface that (HTTP response vs. a skipped schedule run).
 */
async function extractFromUrl(url) {
  const pageRes = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; DataOperatorBot/1.0)" },
    redirect: "follow",
  });
  if (!pageRes.ok) {
    throw new Error(`Could not fetch that page (status ${pageRes.status})`);
  }
  const contentType = pageRes.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error(`That URL isn't a readable web page (content-type: ${contentType})`);
  }

  const html = await pageRes.text();
  const $ = cheerio.load(html);
  const readableText = htmlToReadableText($);

  if (!readableText.trim()) {
    throw new Error("Could not extract readable content from that page");
  }

  return callGemini([
    { text: `${EXTRACT_INSTRUCTION}\n\nExtract the relevant tabular data from this web page's content:\n\n${readableText}` },
  ]);
}

module.exports = { EXTRACT_INSTRUCTION, callGemini, extractFromUrl, extractJson };
