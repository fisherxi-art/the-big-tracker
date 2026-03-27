/**
 * Fetch public http(s) pages and extract main article text (Mozilla Readability).
 * Used to augment paste-before-AI; original paste is still stored separately.
 */
import { Readability } from "@mozilla/readability";
import iconv from "iconv-lite";
import { JSDOM } from "jsdom";

function getFetchTimeoutMs() {
  const n = Number(process.env.URL_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 ? n : 28_000;
}

/** Decode HTML bytes; Chinese sites may use GB18030 while declaring UTF-8. */
function decodeHtmlBuffer(buf, contentType) {
  const ct = (contentType || "").toLowerCase();
  const fromHeader = /charset=([^;\s]+)/i
    .exec(ct)?.[1]
    ?.replace(/"/g, "")
    .trim()
    .toLowerCase() || "";
  const utf8Probe = buf.slice(0, Math.min(12000, buf.length)).toString("utf8");
  const metaM = utf8Probe.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'>\s/]+)/i);
  const fromMeta = (metaM?.[1] || "").toLowerCase();
  const label = fromHeader || fromMeta;
  if (/gbk|gb2312|gb18030|gb_?2312/.test(label)) {
    return iconv.decode(buf, "gb18030");
  }
  const asUtf8 = buf.toString("utf8");
  const replacement = (asUtf8.match(/\uFFFD/g) || []).length;
  if (buf.length > 800 && replacement > 6) {
    const asGb = iconv.decode(buf, "gb18030");
    const repGb = (asGb.match(/\uFFFD/g) || []).length;
    const cjkGb = (asGb.match(/[\u4e00-\u9fff]/g) || []).length;
    const cjkUtf = (asUtf8.match(/[\u4e00-\u9fff]/g) || []).length;
    if (repGb < replacement || cjkGb > cjkUtf + 10) {
      return asGb;
    }
  }
  return asUtf8;
}

const MAX_HTML_CHARS = 2_500_000;
const MAX_URLS = 3;
const MAX_TEXT_PER_URL = 80_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const URL_IN_TEXT =
  /https?:\/\/[^\s<>"'{}|\\^`[\]()]+/gi;

/** Last run of augmentPasteForModel (for GET /api/ai/debug-last-fetch). */
let lastFetchDebug = null;

/**
 * @returns {null | { at: string; rawPastePreview: string; fetchResults: object[]; extractedArticles: { url: string; title: string; text: string }[]; note?: string }}
 */
export function getLastFetchDebug() {
  return lastFetchDebug;
}

function trimTrailingPunct(s) {
  return s.replace(/[),.;:!?]+$/g, "");
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
export function extractHttpUrls(text, max = MAX_URLS) {
  if (!text || typeof text !== "string") return [];
  const seen = new Set();
  const out = [];
  let m;
  const re = new RegExp(URL_IN_TEXT.source, URL_IN_TEXT.flags);
  while ((m = re.exec(text)) !== null) {
    const u = trimTrailingPunct(m[0]);
    try {
      const normalized = new URL(u).href;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
        if (out.length >= max) break;
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Block SSRF to local/private hosts (best-effort).
 * @param {string} urlStr
 */
export function isUrlAllowedForFetch(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    ) {
      return false;
    }
    if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{ title: string; text: string }}
 */
export function extractArticleFromHtml(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const base = new Readability(doc).parse();
  let title = "";
  let text = "";

  function normalizeText(s) {
    return String(s ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function textFromReadabilityArticle(article) {
    if (!article) return "";
    let t = normalizeText(article.textContent);
    if (t.length >= 40) return t;
    const raw = article.content;
    if (typeof raw === "string" && raw.length > 100) {
      try {
        const innerDom = new JSDOM(`<div id="readability-root">${raw}</div>`, { url: pageUrl });
        const root = innerDom.window.document.getElementById("readability-root");
        const alt = normalizeText(root?.innerText || root?.textContent || "");
        if (alt.length > t.length) t = alt;
      } catch {
        /* ignore */
      }
    }
    return t;
  }

  if (base) {
    title = String(base.title || "").trim();
    text = textFromReadabilityArticle(base);
  }

  if (!text || text.length < 40) {
    const selectors = [
      "#artibody",
      "#article_content",
      "#article",
      "article",
      ".article-content",
      ".content",
      "#js_content",
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const candidate = normalizeText(el.innerText || el.textContent || "");
      if (candidate.length >= 40 && candidate.length > text.length) {
        text = candidate;
        if (!title) {
          const h = doc.querySelector("h1");
          if (h) title = normalizeText(h.textContent).slice(0, 220);
        }
        break;
      }
    }
  }

  if (!text || text.length < 40) {
    const body = doc.body;
    text = body
      ? normalizeText(body.innerText || body.textContent || "").replace(/\n{3,}/g, "\n\n")
      : "";
  }

  if (text.length > MAX_TEXT_PER_URL) {
    text = `${text.slice(0, MAX_TEXT_PER_URL)}\n\n[… truncated …]`;
  }
  return { title, text };
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ html: string; finalUrl: string }>}
 */
export async function fetchHtml(url, timeoutMs = getFetchTimeoutMs()) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let referer = url;
    try {
      referer = new URL(url).origin + "/";
    } catch {
      /* keep url */
    }
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: referer,
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "no-cache",
      },
    });
    const finalUrl = res.url || url;
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (!/html|xml|text\/plain/i.test(ct) && !/octet-stream/i.test(ct)) {
      /* still try text() for some servers */
    }
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    let html = decodeHtmlBuffer(buf, ct);
    if (html.length > MAX_HTML_CHARS) {
      html = html.slice(0, MAX_HTML_CHARS);
    }
    return { html, finalUrl };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Append fetched article text after the user's paste for the model only.
 * @param {string} raw
 * @returns {Promise<{ textForModel: string; fetchResults: object[] }>}
 */
export async function augmentPasteForModel(raw) {
  const rawStr = String(raw ?? "");
  const urls = extractHttpUrls(rawStr, MAX_URLS);
  if (urls.length === 0) {
    lastFetchDebug = {
      at: new Date().toISOString(),
      rawPastePreview: rawStr.slice(0, 4000),
      fetchResults: [],
      extractedArticles: [],
      note: "No http(s) URLs found in paste",
    };
    return { textForModel: rawStr, fetchResults: [], extractedArticles: [] };
  }

  const fetchResults = [];
  /** Successful extractions for server-side fallback if the model returns no rows. */
  const extractedArticles = [];
  const blocks = [];

  for (const url of urls) {
    if (!isUrlAllowedForFetch(url)) {
      fetchResults.push({ url, ok: false, error: "URL not allowed (local/private)" });
      blocks.push(`[Fetch skipped for ${url}: not allowed]`);
      continue;
    }
    try {
      const { html, finalUrl } = await fetchHtml(url);
      const { title, text } = extractArticleFromHtml(html, finalUrl);
      if (!text || text.length < 40) {
        fetchResults.push({
          url: finalUrl,
          ok: false,
          error: `No article text extracted (${text.length} chars from parser; HTML ${html.length} bytes). Site may block datacenter IPs, require login, or use an unsupported encoding.`,
        });
        blocks.push(
          `[Fetch for ${finalUrl}: could not extract readable text — paste article text manually if needed]`
        );
        continue;
      }
      fetchResults.push({
        url: finalUrl,
        ok: true,
        title: title || "",
        chars: text.length,
      });
      extractedArticles.push({ url: finalUrl, title: title || "", text });
      blocks.push(
        `--- Web page fetched for AI (${finalUrl}) ---\nTitle: ${title || "(no title)"}\n\n${text}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fetchResults.push({ url, ok: false, error: msg });
      blocks.push(`[Fetch failed for ${url}: ${msg}]`);
    }
  }

  const appendix =
    blocks.length > 0
      ? `\n\n---\nThe following was fetched from URL(s) in the paste (your original paste above is stored as-is).\n---\n\n${blocks.join("\n\n")}\n`
      : "";

  lastFetchDebug = {
    at: new Date().toISOString(),
    rawPastePreview: rawStr.slice(0, 4000),
    fetchResults: fetchResults.map((x) => ({ ...x })),
    extractedArticles: extractedArticles.map((a) => ({
      url: a.url,
      title: a.title,
      text: a.text,
    })),
  };

  return {
    textForModel: rawStr + appendix,
    fetchResults,
    extractedArticles,
  };
}
