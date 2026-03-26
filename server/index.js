import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { openDb, researchRepo, meetingsRepo } from "./db.js";

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
const db = openDb(dbPath);
const research = researchRepo(db);
const meetings = meetingsRepo(db);

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
- If the content fits neither, set "research" to [] and "meeting" to null.
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
  });
});

/** Read-only: current AI system prompts (no OpenRouter call). For UI debugging. */
app.get("/api/ai/debug-prompts", (_, res) => {
  res.json({
    parsePasteSystemPrompt: PARSE_PASTE_SYSTEM_PROMPT,
    parseResearchSystemPrompt: PARSE_RESEARCH_SYSTEM_PROMPT,
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
    const text = await callOpenRouter(
      [
        { role: "system", content: PARSE_PASTE_SYSTEM_PROMPT },
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
    const rawList = normalizeResearchArray(
      parsed?.researchItems ?? parsed?.research
    );
    const shaped = rawList
      .map((item) => normalizeResearchNoteShape(item))
      .filter(Boolean);
    const research = attachOriginalPasteToResearchNotes(shaped, raw);
    const meeting = parsed?.meeting ?? null;
    if (research.length === 0 && meeting === null) {
      return res.status(422).json({
        error:
          "Could not identify research or meeting content in this paste. Try a clearer broker note or invite.",
      });
    }
    const out = { research, meeting };
    if (debugPrompts) {
      out._debug = {
        parsePasteSystemPrompt: PARSE_PASTE_SYSTEM_PROMPT,
        userMessageChars: raw.length,
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
