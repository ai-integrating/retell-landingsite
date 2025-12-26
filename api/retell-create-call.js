const axios = require("axios");

// --- 1. CORE UTILITIES ---
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const decodeHtml = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

function pick(obj, keys, fallback = "Not provided") {
  for (const k of keys) {
    let val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") {
      if (typeof val === "object" && val.output) return val.output;
      return val;
    }
  }
  return fallback;
}

function cleanValue(text) {
  const t = String(text || "").trim();
  if (
    !t ||
    t === "[]" ||
    t === "No data" ||
    t === "/" ||
    t === "null" ||
    t.toLowerCase() === "not provided"
  )
    return "Not provided";
  return t.replace(/\[\]/g, "Not provided");
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x).trim()).filter(Boolean)));
}

// --- 2. URL & SCRAPER LOGIC ---
function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function normalizeWebsite(raw) {
  if (!raw || raw === "Not provided") return "Not provided";
  if (typeof raw === "object" && raw.output) raw = raw.output;
  raw = String(raw).trim();
  const extracted = extractFirstUrl(raw);
  if (extracted) return extracted;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  return raw.startsWith("http") ? raw : "Not provided";
}

function looksLikeCode(text) {
  const t = (text || "").slice(0, 1200).toLowerCase();
  const codeHits = [
    "@keyframes",
    "view-transition",
    "webkit",
    "transform:",
    "opacity:",
    "{",
    "}",
    "::",
    "function(",
    "window.",
    "document.",
  ];
  return codeHits.filter((k) => t.includes(k)).length >= 2;
}

async function getWebsiteContext(url) {
  if (!url || url === "Not provided") return null;

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    let text = String(response.data || "")
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gim, "")
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gim, "")
      .replace(/<header[^>]*>([\s\S]*?)<\/header>/gim, "")
      .replace(/<nav[^>]*>([\s\S]*?)<\/nav>/gim, "")
      .replace(/<footer[^>]*>([\s\S]*?)<\/footer>/gim, "")
      .replace(/<form[^>]*>([\s\S]*?)<\/form>/gim, "")
      .replace(/<[^>]*>?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();

    text = decodeHtml(text);
    if (text.length >= 200 && !looksLikeCode(text)) return text.substring(0, 2000);
  } catch (e) {
    /* fall through */
  }

  try {
    const proxyUrl = `https://r.jina.ai/${url.replace(/^https?:\/\//, "https://")}`;
    const r = await axios.get(proxyUrl, { timeout: 9000 });
    const txt = decodeHtml(String(r.data || "")).replace(/\s+/g, " ").trim();
    if (txt.length >= 200 && !looksLikeCode(txt)) return txt.substring(0, 2000);
  } catch (e) {
    return null;
  }

  return null;
}

// --- 3. SMART FACT EXTRACTION ---
function extractIncludingAreas(text) {
  const m = text.match(
    /including\s+([A-Za-z,\s]+?)(?:and\s+surrounding|surrounding|area|towns|cities|\.)/i
  );
  if (!m || !m[1]) return [];
  return uniq(m[1].split(",").map((s) => s.trim()).filter((s) => s.length >= 3)).slice(
    0,
    10
  );
}

function extractCommaPlaceLists(text) {
  const m = text.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+
