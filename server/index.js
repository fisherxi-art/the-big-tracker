import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { dirname, extname, join } from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import { openDb, researchRepo, meetingsRepo, expensesRepo } from "./db.js";
import { augmentPasteForModel, extractHttpUrls, getLastFetchDebug } from "./urlExtract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
/** Local .env wins over User/System env (e.g. Windows OPENROUTER_MODEL) so edits to .env apply. */
dotenv.config({ path: join(root, ".env"), override: true });
const distIndex = join(root, "dist", "index.html");
if (process.env.NODE_ENV === "production" && !existsSync(distIndex)) {
  console.error("Production mode requires a build. Run: npm run build");
  process.exit(1);
}
const isProd = process.env.NODE_ENV === "production";

const DATA_DIR = process.env.DATA_DIR
  ? join(root, process.env.DATA_DIR.replace(/^\.\//, ""))
  : join(root, "data");

function resolveDbPath() {
  const raw = process.env.DATABASE_PATH;
  if (!raw) return join(DATA_DIR, "app.db");
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return join(root, raw.replace(/^\.\//, ""));
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen3.5-flash-02-23";
/**
 * Vision / OCR only. Must accept image_url on OpenRouter (see openrouter.ai/models, filter: image).
 * Default: Qwen 3.5 9B — if OCR fails, try another vision id in OPENROUTER_VISION_MODEL.
 */
const DEFAULT_VISION_MODEL =
  process.env.OPENROUTER_VISION_MODEL || "qwen/qwen3.5-9b";

/** OpenRouter web search plugin (Exa). Off by default; set OPENROUTER_WEB_SEARCH=1 to enable. */
function openRouterWebPlugins() {
  const on = /^(1|true|on|yes)$/i.test(String(process.env.OPENROUTER_WEB_SEARCH ?? ""));
  if (!on) return undefined;
  const max = Number(process.env.OPENROUTER_WEB_MAX_RESULTS);
  const maxResults = Number.isFinite(max) && max > 0 ? max : 5;
  return [{ id: "web", max_results: maxResults }];
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = resolveDbPath();
ensureDataDir();
const receiptUploadDir = join(DATA_DIR, "receipt-uploads");
if (!existsSync(receiptUploadDir)) mkdirSync(receiptUploadDir, { recursive: true });
const db = openDb(dbPath);
const research = researchRepo(db);
const meetings = meetingsRepo(db);
const expenses = expensesRepo(db);

const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, receiptUploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}${extname(file.originalname)}`),
  }),
});

async function fetchOpenRouterChatCompletion(body) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    const err = new Error("OPENROUTER_API_KEY is not set");
    err.status = 503;
    throw err;
  }
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_URL || "http://localhost:3000",
      "X-Title": "TheBigTracker",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || res.statusText;
    const err = new Error(msg || "OpenRouter request failed");
    err.status = res.status;
    throw err;
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    const err = new Error("Empty model response");
    err.status = 502;
    throw err;
  }
  return text;
}

async function callOpenRouter(messages, jsonObject = false) {
  const plugins = openRouterWebPlugins();
  const body = {
    model: DEFAULT_MODEL,
    messages,
    ...(plugins ? { plugins } : {}),
  };
  if (jsonObject) body.response_format = { type: "json_object" };
  return fetchOpenRouterChatCompletion(body);
}

/** Multimodal user message (text + image) — no web plugin. */
async function callOpenRouterVision(userContentParts) {
  const body = {
    model: DEFAULT_VISION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You transcribe images for a finance research app. Output ONLY the visible text. Preserve the original language and writing system (do not translate). Keep line breaks where helpful. If there is no legible text, reply exactly: (no text found). Do not describe the image or add commentary.",
      },
      { role: "user", content: userContentParts },
    ],
  };
  return fetchOpenRouterChatCompletion(body);
}

const RECEIPT_EXTRACT_SYSTEM = `You are an expense receipt analyzer. Extract information from the receipt image.
Return ONLY a valid JSON object with these keys:
- date (string, YYYY-MM-DD format)
- amount (number)
- currency (string, e.g. HKD)
- merchant (string, shop name)
- description (string, what was bought)
- category (string, choose from: Groceries, Dining, Transport, Utilities, Shopping, Other)`;

/** Receipt image → structured expense fields (vision model + JSON object). */
async function callOpenRouterReceiptParse(dataUrl) {
  const body = {
    model: DEFAULT_VISION_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: RECEIPT_EXTRACT_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract data from this receipt." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };
  return fetchOpenRouterChatCompletion(body);
}

/** Parse JSON from model output; strips markdown code fences if present. */
function parseModelJson(text) {
  let s = String(text).trim();
  const fenced = s.match(/^```(?:json)?\s*\r?\n([\s\S]*)\r?\n```\s*$/);
  if (fenced) s = fenced[1].trim();
  return JSON.parse(s);
}

/** Normalize API / model output: array, single object (legacy), or null. */
function normalizeResearchArray(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((x) => x && typeof x === "object" && !Array.isArray(x));
  }
  if (typeof value === "object") return [value];
  return [];
}

/**
 * One research note from the model: camelCase + arrays; accept snake_case.
 * Does not include rawText — the server fills that from the user's original paste (saves tokens).
 */
function normalizeResearchNoteShape(obj) {
  if (!obj || typeof obj !== "object") return null;
  const kp = obj.keyPoints ?? obj.key_points;
  const tagsRaw = obj.tags ?? obj.Tags;
  const keyPoints = Array.isArray(kp) ? kp.map((x) => String(x)) : [];
  const tags = Array.isArray(tagsRaw) ? tagsRaw.map((x) => String(x)) : [];
  return {
    date: String(obj.date ?? ""),
    category: obj.category === "industry" ? "industry" : "company",
    company: String(obj.company ?? ""),
    ticker: String(obj.ticker ?? ""),
    theme: String(obj.theme ?? ""),
    source: String(obj.source ?? ""),
    rating: String(obj.rating ?? ""),
    title: String(obj.title ?? obj.headline ?? ""),
    keyPoints,
    tags,
  };
}

function attachOriginalPasteToResearchNotes(notes, originalPaste) {
  const t = String(originalPaste ?? "").trim();
  return notes.map((n) => ({ ...n, rawText: t }));
}

/** Keep model excerpt in sourceContent; append full original paste for audit. */
function attachOriginalPasteToMeeting(meeting, originalPaste) {
  if (!meeting || typeof meeting !== "object") return meeting;
  const t = String(originalPaste ?? "").trim();
  if (!t) return meeting;
  const prev = String(meeting.sourceContent ?? "").trim();
  const merged = prev
    ? `${prev}\n\n---\nOriginal paste\n---\n${t}`
    : `---\nOriginal paste\n---\n${t}`;
  return { ...meeting, sourceContent: merged };
}

function urlFetchEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.URL_FETCH ?? "1"));
}

/** When the model returns no rows but we extracted article text from a URL, create one industry note. */
function buildFallbackResearchFromArticle(article) {
  const url = String(article?.url ?? "");
  const title = String(article?.title ?? "").trim();
  const text = String(article?.text ?? "").trim();
  const hostname = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const paras = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 15);
  let keyPoints = paras.slice(0, 8);
  if (keyPoints.length < 2) {
    const sentences = text
      .split(/(?<=[.!?。！？])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15);
    keyPoints = sentences.slice(0, 8);
  }
  if (keyPoints.length === 0) {
    keyPoints = [text.slice(0, 500) + (text.length > 500 ? "…" : "")];
  }
  const displayTitle = title || (hostname ? `${hostname} — article` : "Web article");
  return normalizeResearchNoteShape({
    date: new Date().toISOString().slice(0, 10),
    category: "industry",
    company: "",
    ticker: "",
    theme: "",
    source: hostname || url.slice(0, 120),
    rating: "",
    title: displayTitle.slice(0, 220),
    keyPoints: keyPoints.map((x) => x.slice(0, 900)),
    tags: hostname ? [hostname] : ["web"],
  });
}

/** System prompt for POST /api/ai/parse-paste (echoed in API when debugPrompts is true). */
const PARSE_PASTE_SYSTEM_PROMPT = `You classify pasted text for an equity research tracker. The same paste may contain MULTIPLE distinct company/industry research notes (e.g. a digest, several broker blurbs), AND/OR a meeting/calendar invite — extract each piece separately.

Do NOT include full original text in your JSON — the app stores the user's paste separately. Never output a "rawText" field.

Return ONLY valid JSON with exactly this shape:
{
  "research": [] OR [
    {
      "date": "YYYY-MM-DD or best estimate",
      "category": "company" or "industry",
      "company": "string or empty",
      "ticker": "string or empty",
      "theme": "string for industry theme or empty",
      "source": "broker/source or empty",
      "rating": "rating/view or empty",
      "title": "short one-line display title — REQUIRED if company and theme are both empty (e.g. \\"MSFT — AI capex\\")",
      "keyPoints": ["bullet", "..."],
      "tags": ["ticker", "sector", "broker-or-theme"]
    }
  ],
  "meeting": null OR {
    "date": "YYYY-MM-DD or range string",
    "time": "time or TBD",
    "location": "city/venue/online",
    "nature": "NDR|Result Call|Investor Meeting|Company Visit|Corporate Day|Analyst Luncheon|Business Update Call|Other",
    "eventName": "title",
    "invitingParty": "bank/organizer",
    "keyTopics": "short summary",
    "rsvpStatus": "Pending|Confirmed|Declined|Tentative",
    "notes": "logistics, links, phone",
    "sourceType": "text|image|email",
    "sourceContent": "excerpt or cleaned invite text"
  }
}

Rules:
- Use camelCase keys ("keyPoints", "tags", "title"). Do NOT use snake_case.
- Each research object SHOULD include a useful "title" when company/ticker/theme are insufficient for a card headline.
- SHOULD include non-empty "tags" when you can infer ticker/theme/broker.
- Use one object in "research" per distinct research note.
- If the paste is clearly equity research only: set "research" to a non-empty array and "meeting" to null.
- If it is clearly a meeting invite / corporate access only: set "meeting" to an object and "research" to [].
- If BOTH appear, fill "research" (one or more) AND "meeting".
- WEB / NEWS / ANALYSIS ARTICLES: If the user message includes fetched web page text (sections like "Web page fetched for AI" or "Fetched from URL") or is clearly a news article, blog, 公众号 piece, or general market commentary, you MUST return at least ONE research object. Use category "industry" when no single listed company dominates; set "title" to the headline or a one-line topic; "source" to the publication/site or domain; "keyPoints" to 3–8 bullets summarizing substance (figures, views, events). Do NOT return empty research for successful article content.
- ONLY if the text is truly empty, garbled, or neither finance-related nor a readable article, set "research" to [] and "meeting" to null.
- Never invent tickers; use empty string if unknown.
- Language: Write every extracted string (titles, keyPoints, tags, company/theme/source where applicable, and all meeting fields) in the SAME language as the source paste. If the paste mixes languages, use the dominant one. Do not translate into English unless the source is already English.`;

const PARSE_RESEARCH_SYSTEM_PROMPT = `You extract equity research metadata from text. Return ONLY valid JSON with this shape:
{
  "date": "YYYY-MM-DD or best estimate",
  "category": "company" or "industry",
  "company": "string or empty",
  "ticker": "string or empty",
  "theme": "string for industry theme or empty",
  "source": "broker/source name or empty",
  "rating": "rating/view if any or empty",
  "title": "one-line display title if company+ticker are unclear",
  "keyPoints": ["bullet", "..."],
  "tags": ["short", "tags"]
}
Do NOT include full pasted text in JSON — the app stores the user's original message separately. Never output "rawText".
Use company+ticker for company notes; for sector pieces use category industry and fill theme.
Write all extracted strings in the same language as the source text; do not translate unless the source is English.`;

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    dataDir: DATA_DIR,
    database: dbPath,
    openRouterModel: DEFAULT_MODEL,
    openRouterVisionModel: DEFAULT_VISION_MODEL,
    openRouterWebSearch: Boolean(openRouterWebPlugins()),
    urlFetch: urlFetchEnabled(),
  });
});

/** Read-only: current AI system prompts (no OpenRouter call). For UI debugging. */
app.get("/api/ai/debug-prompts", (_, res) => {
  res.json({
    parsePasteSystemPrompt: PARSE_PASTE_SYSTEM_PROMPT,
    parseResearchSystemPrompt: PARSE_RESEARCH_SYSTEM_PROMPT,
  });
});

/** Last URL fetch + extracted text from the most recent parse-paste (in-memory; server restart clears). */
app.get("/api/ai/debug-last-fetch", (_, res) => {
  const d = getLastFetchDebug();
  if (!d) {
    return res.json({
      ok: true,
      empty: true,
      message:
        "No URL fetch has run yet this session. Paste a link and tap Identify & save, or refresh after a run.",
    });
  }
  const MAX_TEXT = 150_000;
  const articles = (d.extractedArticles || []).map((a) => {
    const full = String(a.text ?? "");
    const truncated = full.length > MAX_TEXT;
    return {
      url: a.url,
      title: a.title || "",
      chars: full.length,
      text: truncated
        ? `${full.slice(0, MAX_TEXT)}\n\n[… truncated in this JSON response only …]`
        : full,
      textTruncated: truncated,
    };
  });
  res.json({
    ok: true,
    empty: false,
    at: d.at,
    note: d.note,
    rawPastePreview: d.rawPastePreview,
    fetchResults: d.fetchResults,
    articles,
  });
});

/** GET: probe that this route is deployed (POST does the work). */
app.get("/api/ai/extract-image-text", (_, res) => {
  res.json({
    ok: true,
    hint: "POST JSON { mimeType, base64 } here to OCR an image (vision model).",
  });
});

/** Extract text from a pasted image (vision model). Body: { mimeType, base64 } */
app.post("/api/ai/extract-image-text", async (req, res) => {
  try {
    const mimeType = String(req.body?.mimeType || "image/png").slice(0, 120);
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(mimeType)) {
      return res.status(400).json({ error: "Unsupported image type (use PNG, JPEG, GIF, or WebP)" });
    }
    const b64 = req.body?.base64;
    if (typeof b64 !== "string" || !b64.trim()) {
      return res.status(400).json({ error: "base64 required" });
    }
    const trimmed = b64.replace(/\s/g, "");
    if (trimmed.length > 14 * 1024 * 1024) {
      return res.status(400).json({ error: "Image payload too large (max ~10MB)" });
    }
    const dataUrl = `data:${mimeType};base64,${trimmed}`;
    const text = await callOpenRouterVision([
      {
        type: "text",
        text: "Transcribe all readable text. Keep the same language as in the image; do not translate.",
      },
      { type: "image_url", image_url: { url: dataUrl } },
    ]);
    res.json({ text: String(text).trim() });
  } catch (e) {
    const msg = e.message || String(e);
    const upstream = Number(e.status) || 500;
    // OpenRouter uses 404 when the model has no image endpoint — use 502 so clients don't treat it as "missing /api route"
    const noVision =
      upstream === 404 ||
      /no endpoints found|support image input|does not support multimodal/i.test(msg);
    const status = noVision ? 502 : upstream >= 400 && upstream < 600 ? upstream : 500;
    const extra =
      noVision && status === 502
        ? " Set OPENROUTER_VISION_MODEL to a vision-capable id from https://openrouter.ai/models (filter: image). Many MiniMax ids are text-only on OpenRouter."
        : "";
    res.status(status).json({ error: msg + extra });
  }
});

app.get("/api/research", (_, res) => {
  try {
    res.json(research.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/research", (req, res) => {
  try {
    const body = req.body || {};
    const kp = body.keyPoints ?? body.key_points;
    const tg = body.tags ?? body.Tags;
    const row = research.insert({
      date: body.date || new Date().toISOString().slice(0, 10),
      category: body.category === "industry" ? "industry" : "company",
      company: body.company || "",
      ticker: body.ticker || "",
      theme: body.theme || "",
      source: body.source || "",
      rating: body.rating || "",
      title: body.title ?? "",
      keyPoints: Array.isArray(kp) ? kp : [],
      rawText: body.rawText ?? body.raw_text ?? "",
      tags: Array.isArray(tg) ? tg : [],
      sourceImage: body.sourceImage ?? body.source_image ?? "",
    });
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/research/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const row = research.update(id, body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/research/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const ok = research.delete(id);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/meetings", (_, res) => {
  try {
    res.json(meetings.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/meetings", (req, res) => {
  try {
    const body = req.body || {};
    const row = meetings.insert({
      date: body.date || "",
      time: body.time || "",
      location: body.location || "",
      nature: body.nature || "",
      eventName: body.eventName || "",
      invitingParty: body.invitingParty || "",
      keyTopics: body.keyTopics || "",
      rsvpStatus: body.rsvpStatus || "Pending",
      notes: body.notes || "",
      sourceType: body.sourceType || "",
      sourceContent: body.sourceContent ?? "",
      sourceImage: body.sourceImage ?? body.source_image ?? "",
    });
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/meetings/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const row = meetings.update(id, body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/meetings/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const ok = meetings.delete(id);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/upload", receiptUpload.single("receipt"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    const mimeType = String(req.file.mimetype || "image/jpeg").slice(0, 120);
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(mimeType)) {
      try {
        unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      return res.status(400).json({ error: "Unsupported image type (use PNG, JPEG, GIF, or WebP)" });
    }
    const b64 = readFileSync(req.file.path).toString("base64");
    const dataUrl = `data:${mimeType};base64,${b64}`;
    const content = await callOpenRouterReceiptParse(dataUrl);
    let parsedData;
    try {
      parsedData = parseModelJson(content);
    } catch {
      parsedData = {};
    }
    const filename = req.file.filename;
    res.json({
      image_path: `/uploads/${filename}`,
      extracted: parsedData,
    });
  } catch (e) {
    if (req.file?.path) {
      try {
        unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
    }
    const msg = e.message || String(e);
    const upstream = Number(e.status) || 500;
    const noVision =
      upstream === 404 ||
      /no endpoints found|support image input|does not support multimodal/i.test(msg);
    const status = noVision ? 502 : upstream >= 400 && upstream < 600 ? upstream : 500;
    const extra =
      noVision && status === 502
        ? " Set OPENROUTER_VISION_MODEL to a vision-capable id from https://openrouter.ai/models (filter: image)."
        : "";
    res.status(status).json({ error: msg + extra });
  }
});

app.post("/api/save", (req, res) => {
  try {
    const body = req.body || {};
    const { date, amount, currency, merchant, description, category, note, image_path } = body;
    if (!String(date ?? "").trim()) {
      return res.status(400).json({ error: "date required" });
    }
    const out = expenses.insert({
      expense_date: date,
      amount,
      currency,
      merchant,
      description,
      category,
      note,
      image_path,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/stats", (_, res) => {
  try {
    res.json(expenses.stats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ai/parse-research", async (req, res) => {
  try {
    const raw = (req.body && req.body.rawText) || "";
    if (!raw.trim()) return res.status(400).json({ error: "rawText required" });
    const debugPrompts = Boolean(req.body?.debugPrompts);
    const text = await callOpenRouter(
      [
        { role: "system", content: PARSE_RESEARCH_SYSTEM_PROMPT },
        { role: "user", content: raw.slice(0, 120000) },
      ],
      true
    );
    let parsed;
    try {
      parsed = parseModelJson(text);
    } catch {
      return res.status(502).json({ error: "Model did not return JSON", raw: text });
    }
    const shaped = normalizeResearchNoteShape(parsed);
    const base = shaped ?? {
      date: "",
      category: "company",
      company: "",
      ticker: "",
      theme: "",
      source: "",
      rating: "",
      title: "",
      keyPoints: [],
      tags: [],
    };
    const out = { ...base, rawText: String(raw).trim() };
    if (debugPrompts) {
      out._debug = {
        parseResearchSystemPrompt: PARSE_RESEARCH_SYSTEM_PROMPT,
        userMessageChars: raw.length,
      };
    }
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/ai/parse-paste", async (req, res) => {
  try {
    const raw = (req.body && req.body.rawText) || "";
    if (!raw.trim()) return res.status(400).json({ error: "rawText required" });
    const debugPrompts = Boolean(req.body?.debugPrompts);
    const { textForModel, fetchResults, extractedArticles } = urlFetchEnabled()
      ? await augmentPasteForModel(raw)
      : { textForModel: raw, fetchResults: [], extractedArticles: [] };

    const urlsDetected = extractHttpUrls(raw).length;
    const fetchSummary = {
      urlFetchEnabled: urlFetchEnabled(),
      urlsDetected,
      articlesExtracted: extractedArticles.length,
      extractedTotalChars: extractedArticles.reduce((s, a) => s + (a.text?.length || 0), 0),
      perUrl: fetchResults.map((r) => ({
        url: r.url,
        ok: r.ok,
        chars: r.chars,
        error: r.error,
        title: r.title,
      })),
    };

    const text = await callOpenRouter(
      [
        { role: "system", content: PARSE_PASTE_SYSTEM_PROMPT },
        { role: "user", content: textForModel.slice(0, 120000) },
      ],
      true
    );
    let parsed;
    try {
      parsed = parseModelJson(text);
    } catch {
      return res.status(502).json({ error: "Model did not return JSON", raw: text });
    }
    const rawList = normalizeResearchArray(
      parsed?.researchItems ?? parsed?.research
    );
    const shaped = rawList
      .map((item) => normalizeResearchNoteShape(item))
      .filter(Boolean);
    let research = attachOriginalPasteToResearchNotes(shaped, raw);
    let meeting = parsed?.meeting ?? null;
    if (meeting && typeof meeting === "object") {
      meeting = attachOriginalPasteToMeeting(meeting, raw);
    }
    let fallbackFromUrl = false;
    if (research.length === 0 && meeting === null && extractedArticles.length > 0) {
      const fb = buildFallbackResearchFromArticle(extractedArticles[0]);
      research = attachOriginalPasteToResearchNotes([fb], raw);
      fallbackFromUrl = true;
    }
    if (research.length === 0 && meeting === null) {
      let errMsg =
        "Could not identify research or meeting content in this paste. Try a clearer broker note or invite.";
      if (urlsDetected > 0) {
        if (!fetchSummary.urlFetchEnabled) {
          errMsg +=
            " Links were found but URL fetch is off on the server (set URL_FETCH=1 or remove URL_FETCH=0).";
        } else if (fetchSummary.articlesExtracted === 0) {
          errMsg += ` ${urlsDetected} link(s) found but no article text was extracted (blocked site, login wall, or encoding). Use “Show last URL fetch (debug)”.`;
        }
      }
      return res.status(422).json({
        error: errMsg,
        fetchSummary: { ...fetchSummary, fallbackFromUrl },
      });
    }
    const out = { research, meeting, fetchSummary: { ...fetchSummary, fallbackFromUrl } };
    if (debugPrompts) {
      out._debug = {
        parsePasteSystemPrompt: PARSE_PASTE_SYSTEM_PROMPT,
        userMessageChars: raw.length,
        modelInputChars: textForModel.length,
        urlFetch: fetchResults,
        fallbackFromUrl,
      };
    }
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/ai/parse-meeting", async (req, res) => {
  try {
    const raw = (req.body && req.body.rawText) || "";
    if (!raw.trim()) return res.status(400).json({ error: "rawText required" });
    const system = `You extract investor meeting / corporate access events from text. Return ONLY valid JSON:
{
  "date": "YYYY-MM-DD or range as string",
  "time": "time string or TBD",
  "location": "city/venue/online",
  "nature": "NDR|Result Call|Investor Meeting|Company Visit|Corporate Day|Analyst Luncheon|Business Update Call|Other",
  "eventName": "title",
  "invitingParty": "bank/organizer",
  "keyTopics": "short summary",
  "rsvpStatus": "Pending|Confirmed|Declined|Tentative",
  "notes": "logistics, links, phone",
  "sourceType": "text|image|email",
  "sourceContent": "original or cleaned excerpt"
}
Write all string values in the same language as the source text; do not translate unless the source is English.`;
    const t = await callOpenRouter(
      [
        { role: "system", content: system },
        { role: "user", content: raw.slice(0, 120000) },
      ],
      true
    );
    let parsed;
    try {
      parsed = parseModelJson(t);
    } catch {
      return res.status(502).json({ error: "Model did not return JSON", raw: t });
    }
    res.json(parsed);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

const port = Number(process.env.PORT) || 3000;

/** Unmatched /api requests → JSON (avoid Vite returning HTML 404 for POST /api). */
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({
      error: `No API handler for ${req.method} ${req.originalUrl}. Check server route registration.`,
    });
  }
  next();
});

/** Only redirect bare `/household`; `app.get("/household")` would also match `/household/` with strict routing off and loop 302. */
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const pathOnly = req.originalUrl.split(/[?#]/)[0];
  if (pathOnly === "/household") {
    return res.redirect(302, "/household/");
  }
  next();
});
app.use("/household", express.static(join(root, "ReceiptTracker/public")));
app.use("/uploads", express.static(receiptUploadDir));

if (isProd) {
  app.use(express.static(join(root, "dist")));
  app.get("*", (_, res) => {
    res.sendFile(distIndex);
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: join(root, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });
  // Do not pass /api to Vite — it can answer with 404 before Express routes match in some setups.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    if (req.path.startsWith("/household")) return next();
    if (req.path.startsWith("/uploads")) return next();
    return vite.middlewares(req, res, next);
  });
}

const server = app.listen(port, () => {
  console.log(
    isProd
      ? `TheBigTracker http://localhost:${port} (production)`
      : `TheBigTracker dev http://localhost:${port}`
  );
  console.log(`SQLite: ${dbPath}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${port} is already in use (another TheBigTracker or terminal is using it).\n` +
        `  • Stop the other process (Ctrl+C in that terminal), or\n` +
        `  • Run: npm run kill-dev-ports\n` +
        `  • Or use a different port: set PORT=3001 (Windows: set PORT=3001&& npm run dev)\n`
    );
    process.exit(1);
  }
  throw err;
});
