export type Research = {
  id: number;
  date: string;
  category: "company" | "industry";
  company: string;
  ticker: string;
  theme: string;
  source: string;
  rating: string;
  /** Short headline from AI or left empty; UI falls back to company/ticker/theme/first line. */
  title: string;
  keyPoints: string[];
  rawText: string;
  tags: string[];
  /** Data URL or JSON array of data URLs from pasted images */
  sourceImage: string;
};

export type AiJob = {
  id: number;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  result: {
    createdResearchIds?: number[];
    createdMeetingId?: number | null;
    fetchSummary?: {
      urlFetchEnabled: boolean;
      urlsDetected: number;
      articlesExtracted: number;
      extractedTotalChars: number;
      perUrl: { url?: string; ok?: boolean; chars?: number; error?: string; title?: string }[];
      fallbackFromUrl?: boolean;
    };
    debug?: {
      parsePasteSystemPrompt?: string;
      userMessageChars?: number;
      modelInputChars?: number;
    };
    extracted?: Record<string, unknown>;
    image_path?: string;
  } | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type Meeting = {
  id: number;
  date: string;
  time: string;
  location: string;
  nature: string;
  eventName: string;
  invitingParty: string;
  keyTopics: string;
  rsvpStatus: string;
  notes: string;
  sourceType: string;
  sourceContent: string;
  sourceImage: string;
};

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const raw = await res.text();
  let data: unknown = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const fromJson =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error?: unknown }).error ?? "")
        : "";
    const trimmed = raw.trim();
    const isHtml = trimmed.startsWith("<");
    const snippet = !isHtml && trimmed ? trimmed.slice(0, 280) : "";
    /** HTTP/2 often has empty statusText; never rely on it alone. */
    const statusLine = res.statusText?.trim() || `HTTP ${res.status}`;
    let message = fromJson || snippet || statusLine;
    if (isHtml && !fromJson) {
      message = `${statusLine} — server returned an error page instead of JSON (often timeout, 502, or cold start). Retry; check Render logs and OpenRouter.`;
    } else if (!message.trim()) {
      message = `HTTP ${res.status}`;
    }

    if (res.status === 404) {
      const isUpstream =
        /openrouter|endpoint|image input|model/i.test(message) &&
        !/api is not on this origin/i.test(message);
      if (isUpstream) {
        throw new Error(message || `HTTP ${res.status}`);
      }
      throw new Error(
        `${message} — HTTP 404 on ${path}. This usually means the API is not on this origin (e.g. run \`npm run dev\` so one Node process serves both UI and /api; do not use \`vite\` alone). On production, redeploy the server after adding /api/ai/parse-paste.`
      );
    }
    throw new Error(message);
  }
  return data as T;
}

function coerceResearchDraft(x: object): Omit<Research, "id"> {
  const o = x as Record<string, unknown>;
  const kp = o.keyPoints ?? o.key_points;
  const tg = o.tags ?? o.Tags;
  return {
    date: String(o.date ?? ""),
    category: o.category === "industry" ? "industry" : "company",
    company: String(o.company ?? ""),
    ticker: String(o.ticker ?? ""),
    theme: String(o.theme ?? ""),
    source: String(o.source ?? ""),
    rating: String(o.rating ?? ""),
    title: String(o.title ?? o.headline ?? ""),
    keyPoints: Array.isArray(kp) ? kp.map(String) : [],
    rawText: String(o.rawText ?? ""),
    tags: Array.isArray(tg) ? tg.map(String) : [],
    sourceImage: String(o.sourceImage ?? o.source_image ?? ""),
  };
}

/** Ensures parse-paste research is always an array (single object and alternate keys are common). */
function normalizeParsePasteResearch(value: unknown): Omit<Research, "id">[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .filter((x) => x && typeof x === "object" && !Array.isArray(x))
      .map((x) => coerceResearchDraft(x as object));
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return [coerceResearchDraft(value)];
  }
  return [];
}

export const api = {
  health: () =>
    j<{
      ok: boolean;
      openrouter: boolean;
      dataDir?: string;
      database?: string;
      openRouterModel?: string;
      openRouterVisionModel?: string;
      openRouterWebSearch?: boolean;
      /** Server fetches http(s) URLs in paste and extracts article text before AI (set URL_FETCH=0 to disable). */
      urlFetch?: boolean;
    }>("/api/health"),
  research: {
    list: () => j<Research[]>("/api/research"),
    create: (body: Partial<Research>) =>
      j<Research>("/api/research", { method: "POST", body: JSON.stringify(body) }),
    update: (id: number, body: Partial<Research>) =>
      j<Research>(`/api/research/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: number) => j<{ ok: boolean }>(`/api/research/${id}`, { method: "DELETE" }),
  },
  meetings: {
    list: () => j<Meeting[]>("/api/meetings"),
    create: (body: Partial<Meeting>) =>
      j<Meeting>("/api/meetings", { method: "POST", body: JSON.stringify(body) }),
    update: (id: number, body: Partial<Meeting>) =>
      j<Meeting>(`/api/meetings/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: number) => j<{ ok: boolean }>(`/api/meetings/${id}`, { method: "DELETE" }),
  },
  ai: {
    /** Classifies paste as research (one or many notes), meeting, both, or rejects if neither. */
    parsePaste: async (
      rawText: string,
      opts?: { debugPrompts?: boolean }
    ): Promise<{
      research: Omit<Research, "id">[];
      meeting: Omit<Meeting, "id"> | null;
      debug?: { parsePasteSystemPrompt?: string; userMessageChars?: number };
      fetchSummary?: {
        urlFetchEnabled: boolean;
        urlsDetected: number;
        articlesExtracted: number;
        extractedTotalChars: number;
        perUrl: { url?: string; ok?: boolean; chars?: number; error?: string; title?: string }[];
        fallbackFromUrl?: boolean;
      };
    }> => {
      const data = await j<{
        research?: unknown;
        researchItems?: unknown;
        meeting?: unknown;
        fetchSummary?: {
          urlFetchEnabled: boolean;
          urlsDetected: number;
          articlesExtracted: number;
          extractedTotalChars: number;
          perUrl: { url?: string; ok?: boolean; chars?: number; error?: string; title?: string }[];
          fallbackFromUrl?: boolean;
        };
        _debug?: { parsePasteSystemPrompt?: string; userMessageChars?: number };
      }>(`/api/ai/parse-paste`, {
        method: "POST",
        body: JSON.stringify({
          rawText,
          debugPrompts: opts?.debugPrompts === true,
        }),
      });
      const research = normalizeParsePasteResearch(data.researchItems ?? data.research);
      const m = data.meeting;
      const meeting =
        m && typeof m === "object" && !Array.isArray(m)
          ? (m as Omit<Meeting, "id">)
          : null;
      return { research, meeting, debug: data._debug, fetchSummary: data.fetchSummary };
    },
    /** Queue identify-and-save on the server; poll `getJob` until completed or failed. */
    enqueueParsePaste: (rawText: string, opts?: { debugPrompts?: boolean; sourceImage?: string }) =>
      j<{ job_id: number; status: string }>("/api/ai/parse-paste-jobs", {
        method: "POST",
        body: JSON.stringify({
          rawText,
          debugPrompts: opts?.debugPrompts === true,
          ...(opts?.sourceImage ? { sourceImage: opts.sourceImage } : {}),
        }),
      }),
    getJob: (id: number) => j<AiJob>(`/api/ai/jobs/${id}`),
    listJobs: (opts?: { kind?: string; statuses?: string[]; limit?: number }) => {
      const q = new URLSearchParams();
      if (opts?.kind) q.set("kind", opts.kind);
      if (opts?.statuses?.length) q.set("status", opts.statuses.join(","));
      if (opts?.limit != null) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return j<{ jobs: AiJob[] }>(`/api/ai/jobs${qs ? `?${qs}` : ""}`);
    },
    deleteJob: (id: number) => j<{ ok: boolean }>(`/api/ai/jobs/${id}`, { method: "DELETE" }),
    parseResearch: (rawText: string) =>
      j<Omit<Research, "id">>(`/api/ai/parse-research`, {
        method: "POST",
        body: JSON.stringify({ rawText }),
      }),
    parseMeeting: (rawText: string) =>
      j<Omit<Meeting, "id">>(`/api/ai/parse-meeting`, {
        method: "POST",
        body: JSON.stringify({ rawText }),
      }),
    /** OCR: image as base64 (no data: prefix). */
    extractImageText: (body: { mimeType: string; base64: string }) =>
      j<{ text: string }>(`/api/ai/extract-image-text`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
};
