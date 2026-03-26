import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import { api, type Meeting, type Research } from "./api";

type Tab = "research" | "meetings";

function IconSun({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
      />
    </svg>
  );
}

function IconMoon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
      />
    </svg>
  );
}

function btnGhost() {
  return "inline-flex items-center justify-center rounded-sm border border-border bg-transparent px-2.5 sm:px-3 py-2 text-sm font-medium min-h-[40px] sm:min-h-[44px] touch-manipulation active:opacity-80 transition-opacity";
}

function btnPrimary() {
  return "inline-flex items-center justify-center rounded-sm bg-primary px-3 sm:px-4 py-2.5 sm:py-3 text-sm font-semibold text-primary-foreground min-h-[44px] sm:min-h-[48px] touch-manipulation active:opacity-90 transition-opacity disabled:opacity-50 disabled:pointer-events-none w-full sm:w-auto shadow-sm";
}

function inputClass() {
  return "w-full rounded-sm border border-border bg-card px-2.5 sm:px-3 py-2 sm:py-3 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0";
}

function ratingTone(rating: string) {
  if (!rating) return "bg-muted text-muted-foreground";
  const x = rating.toLowerCase();
  if (/买入|buy|上调|增持|overweight/i.test(x)) {
    return "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800";
  }
  if (/回避|sell|下调|减持|underweight/i.test(x)) {
    return "bg-red-100 text-red-900 border-red-300 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800";
  }
  return "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-800";
}

const THEME_STORAGE_KEY = "thebigtracker-theme";

function readThemeFromDom(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyThemeClass(mode: "light" | "dark") {
  if (mode === "dark") document.documentElement.classList.add("dark");
  else document.documentElement.classList.remove("dark");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** DB stores one data URL or a JSON array of data URLs */
function parseStoredSourceImages(s: string | undefined): string[] {
  if (!s?.trim()) return [];
  const t = s.trim();
  if (t.startsWith("[")) {
    try {
      const a = JSON.parse(t) as unknown;
      return Array.isArray(a)
        ? a.filter((x): x is string => typeof x === "string" && x.startsWith("data:"))
        : [];
    } catch {
      return [];
    }
  }
  if (t.startsWith("data:")) return [t];
  return [];
}

function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const onBackdrop = (e: SyntheticEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const onImgLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    setNatural({ w: el.naturalWidth, h: el.naturalHeight });
  };

  const imgStyle =
    natural && natural.w > 0 && natural.h > 0
      ? ({
          width: `${Math.round(natural.w * zoom)}px`,
          height: `${Math.round(natural.h * zoom)}px`,
          ...(zoom <= 1
            ? {
                maxWidth: "min(calc(100vw - 48px), 100%)",
                maxHeight: "calc(100dvh - 160px)",
              }
            : {}),
        } as const)
      : { maxHeight: "calc(100dvh - 160px)", maxWidth: "calc(100vw - 48px)" };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/95 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen image"
      onClick={onBackdrop}
    >
      <div className="shrink-0 flex flex-wrap items-center justify-center gap-2 px-3 py-2 border-b border-white/10">
        <button
          type="button"
          className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white min-h-[44px] touch-manipulation active:opacity-80"
          onClick={(e) => {
            e.stopPropagation();
            setZoom((z) => Math.max(0.5, z / 1.25));
          }}
        >
          −
        </button>
        <span className="text-xs text-white/80 tabular-nums min-w-[3.5rem] text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white min-h-[44px] touch-manipulation active:opacity-80"
          onClick={(e) => {
            e.stopPropagation();
            setZoom((z) => Math.min(6, z * 1.25));
          }}
        >
          +
        </button>
        <button
          type="button"
          className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs text-white min-h-[44px] touch-manipulation active:opacity-80"
          onClick={(e) => {
            e.stopPropagation();
            setZoom(1);
          }}
        >
          Fit
        </button>
        <button
          type="button"
          className="rounded-lg border border-white/30 bg-white/15 px-4 py-2 text-sm font-medium text-white min-h-[44px] touch-manipulation active:opacity-80"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          Close
        </button>
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto overscroll-contain flex items-center justify-center p-3 touch-pan-x touch-pan-y"
        onClick={onBackdrop}
      >
        <img
          src={url}
          alt=""
          className="block object-contain select-none"
          draggable={false}
          onLoad={onImgLoad}
          style={imgStyle}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}

function SourceImages({ stored }: { stored: string }) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const urls = parseStoredSourceImages(stored);
  const show =
    urls.length > 0 ? urls : stored.trim().startsWith("data:") ? [stored.trim()] : [];
  if (!show.length) return null;
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
        {show.length > 1 ? "Source images" : "Source image"}
      </p>
      <div className="flex flex-col gap-2">
        {show.map((u, i) => (
          <button
            key={i}
            type="button"
            className="w-full rounded-sm border border-border bg-muted/20 overflow-hidden text-left focus:outline-none focus:ring-2 focus:ring-primary touch-manipulation active:opacity-90"
            onClick={() => setLightbox(u)}
            aria-label="Open image fullscreen"
          >
            <img
              src={u}
              alt=""
              className="max-w-full max-h-[min(50vh,480px)] w-full object-contain pointer-events-none"
            />
          </button>
        ))}
      </div>
      {lightbox ? (
        <ImageLightbox key={lightbox} url={lightbox} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

/** Card / detail headline: AI title, then company·ticker, theme, or first line of stored paste. */
function researchDisplayTitle(r: Research) {
  if (r.title?.trim()) return r.title.trim();
  if (r.category === "company") {
    const line = [r.company, r.ticker].filter(Boolean).join(" · ");
    if (line) return line;
  }
  if (r.theme?.trim()) return r.theme.trim();
  const first = r.rawText?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (first) return first.length > 120 ? `${first.slice(0, 117)}…` : first;
  return "Research note";
}

function normalizeSearch(q: string): string {
  return q.trim().toLowerCase();
}

function researchMatchesQuery(r: Research, q: string): boolean {
  if (!q) return true;
  const hay = [
    r.title,
    r.company,
    r.ticker,
    r.theme,
    r.source,
    r.rating,
    r.date,
    r.category,
    r.rawText,
    ...r.keyPoints,
    ...r.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function meetingMatchesQuery(m: Meeting, q: string): boolean {
  if (!q) return true;
  const hay = [
    m.date,
    m.time,
    m.location,
    m.nature,
    m.eventName,
    m.invitingParty,
    m.keyTopics,
    m.rsvpStatus,
    m.notes,
    m.sourceType,
    m.sourceContent,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function AiModelsBar({
  health,
}: {
  health: {
    openrouter?: boolean;
    openRouterModel?: string;
    openRouterVisionModel?: string;
    openRouterWebSearch?: boolean;
  } | null;
}) {
  if (!health) return null;
  return (
    <div
      className="border-b border-border bg-muted/50"
      role="region"
      aria-label="AI model configuration"
    >
      <div className="mx-auto max-w-[1400px] px-2.5 sm:px-4 py-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-8 sm:gap-y-1 text-[11px] sm:text-xs">
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-semibold uppercase tracking-widest text-[10px] text-muted-foreground">
            AI models
          </span>
          <span
            className={`h-2 w-2 shrink-0 rounded-sm ${
              health.openrouter ? "bg-emerald-500" : "bg-amber-500"
            }`}
            title={health.openrouter ? "OpenRouter configured" : "Missing OPENROUTER_API_KEY"}
            aria-hidden
          />
          <span className="text-muted-foreground">{health.openrouter ? "Ready" : "No API key"}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 sm:gap-y-1 min-w-0 flex-1 font-mono text-[11px] leading-snug">
          <span className="text-muted-foreground font-sans uppercase tracking-wide text-[10px] sm:pt-0.5">
            Text
          </span>
          <code className="text-foreground break-all block">{health.openRouterModel ?? "—"}</code>
          <span className="text-muted-foreground font-sans uppercase tracking-wide text-[10px] sm:pt-0.5">
            Vision
          </span>
          <code className="text-foreground break-all block">{health.openRouterVisionModel ?? "—"}</code>
          <span className="text-muted-foreground font-sans uppercase tracking-wide text-[10px] sm:pt-0.5">
            Web search
          </span>
          <span className="text-foreground tabular-nums font-sans">
            {health.openRouterWebSearch ? "On" : "Off"}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("research");
  const [health, setHealth] = useState<Parameters<typeof AiModelsBar>[0]["health"]>(null);
  const [research, setResearch] = useState<Research[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [selR, setSelR] = useState<Research | null>(null);
  const [selM, setSelM] = useState<Meeting | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [showAiDebug, setShowAiDebug] = useState(false);
  const [parsePasteDebug, setParsePasteDebug] = useState<{
    parsePasteSystemPrompt?: string;
    parseResearchSystemPrompt?: string;
    userMessageChars?: number;
  } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  /** Last pasted/dropped image data URLs — used when user taps Identify & save after OCR (no second image paste). */
  const pendingSourceImagesRef = useRef<string[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(readThemeFromDom);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    applyThemeClass(next);
    setTheme(next);
  }

  const searchNorm = useMemo(() => normalizeSearch(searchQuery), [searchQuery]);
  const filteredResearch = useMemo(
    () =>
      searchNorm ? research.filter((r) => researchMatchesQuery(r, searchNorm)) : research,
    [research, searchNorm]
  );
  const filteredMeetings = useMemo(
    () =>
      searchNorm ? meetings.filter((m) => meetingMatchesQuery(m, searchNorm)) : meetings,
    [meetings, searchNorm]
  );

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const [h, r, m] = await Promise.all([
        api.health(),
        api.research.list(),
        api.meetings.list(),
      ]);
      setHealth(h);
      setResearch(r);
      setMeetings(m);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!showAiDebug) {
      setParsePasteDebug(null);
      return;
    }
    let cancelled = false;
    fetch("/api/ai/debug-prompts")
      .then((r) => r.json())
      .then((d: { parsePasteSystemPrompt?: string; parseResearchSystemPrompt?: string }) => {
        if (cancelled || !d) return;
        setParsePasteDebug({
          parsePasteSystemPrompt: d.parsePasteSystemPrompt,
          parseResearchSystemPrompt: d.parseResearchSystemPrompt,
        });
      })
      .catch(() => {
        if (!cancelled) setParsePasteDebug(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showAiDebug]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [success]);

  /** Keep selected meeting in sync with list (e.g. full `sourceImage` after refresh or create). */
  useEffect(() => {
    setSelM((sel) => {
      if (!sel) return sel;
      const fresh = meetings.find((m) => m.id === sel.id);
      return fresh ?? sel;
    });
  }, [meetings]);

  useEffect(() => {
    if (selR && !filteredResearch.some((r) => r.id === selR.id)) setSelR(null);
  }, [filteredResearch, selR]);

  useEffect(() => {
    if (selM && !filteredMeetings.some((m) => m.id === selM.id)) setSelM(null);
  }, [filteredMeetings, selM]);

  /** Classify + create DB rows from raw text (used by button and after image OCR). */
  async function parseAndSaveFromText(
    rawText: string,
    opts?: { sourceImages?: string[] }
  ) {
    const text = rawText.trim();
    if (!text) return;
    const fromOpts = opts?.sourceImages?.filter((u) => typeof u === "string" && u.startsWith("data:"));
    const fromRef = pendingSourceImagesRef.current?.filter(
      (u) => typeof u === "string" && u.startsWith("data:")
    );
    const imgs =
      fromOpts && fromOpts.length > 0 ? fromOpts : fromRef && fromRef.length > 0 ? fromRef : [];
    const sourceImagePayload =
      imgs.length === 1 ? imgs[0] : imgs.length > 1 ? JSON.stringify(imgs) : undefined;
    try {
      const { research: rList, meeting: mData, debug } = await api.ai.parsePaste(text, {
        debugPrompts: showAiDebug,
      });
      if (showAiDebug && debug?.userMessageChars != null) {
        setParsePasteDebug((prev) => ({
          ...prev,
          parsePasteSystemPrompt: debug?.parsePasteSystemPrompt ?? prev?.parsePasteSystemPrompt,
          userMessageChars: debug.userMessageChars,
        }));
      }
      const parts: string[] = [];
      const createdR: Research[] = [];
      for (const rData of rList) {
        const c = await api.research.create(
          sourceImagePayload ? { ...rData, sourceImage: sourceImagePayload } : rData
        );
        createdR.push(c);
      }
      if (createdR.length) {
        setResearch((prev) => [...createdR, ...prev]);
        setSelR(createdR[0]);
        parts.push(
          createdR.length === 1 ? "1 research note" : `${createdR.length} research notes`
        );
      }
      if (mData) {
        const c = await api.meetings.create(
          sourceImagePayload ? { ...mData, sourceImage: sourceImagePayload } : mData
        );
        setMeetings((prev) => [c, ...prev]);
        setSelM(c);
        parts.push("meeting");
      }
      setPasteText("");
      if (createdR.length && mData) setTab("research");
      else if (mData && !createdR.length) setTab("meetings");
      else if (createdR.length) setTab("research");
      setSuccess(`Saved ${parts.join(" & ")}.`);
      if (parts.length) pendingSourceImagesRef.current = null;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "AI parse failed");
    }
  }

  async function runIdentifyAndSave() {
    if (!pasteText.trim()) return;
    setAiBusy(true);
    setErr(null);
    setSuccess(null);
    try {
      await parseAndSaveFromText(pasteText);
    } finally {
      setAiBusy(false);
    }
  }

  async function deleteResearch(id: number) {
    if (!confirm("Delete this research note?")) return;
    setErr(null);
    try {
      await api.research.remove(id);
      setResearch((p) => p.filter((x) => x.id !== id));
      setSelR((s) => (s?.id === id ? null : s));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function extractTextFromImageFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    setAiBusy(true);
    setErr(null);
    setSuccess(null);
    try {
      const chunks: string[] = [];
      const dataUrls: string[] = [];
      for (const file of images) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        dataUrls.push(dataUrl);
        const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) {
          setErr("Could not read image");
          return;
        }
        const { text } = await api.ai.extractImageText({
          mimeType: m[1],
          base64: m[2].replace(/\s/g, ""),
        });
        chunks.push(text);
      }
      const block = chunks.join("\n\n---\n\n").trim();
      const onlyEmpty = chunks.every((c) => {
        const t = c.trim();
        return !t || /^\(no text found\)$/i.test(t);
      });
      if (!block || onlyEmpty) {
        setErr("No text recognized in the image.");
        return;
      }
      const merged = pasteText.trim() ? `${pasteText.trim()}\n\n${block}` : block;
      setPasteText(merged);
      pendingSourceImagesRef.current = dataUrls;
      await parseAndSaveFromText(merged, { sourceImages: dataUrls });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Image processing failed");
    } finally {
      setAiBusy(false);
    }
  }

  function onPasteImages(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items?.length) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    void extractTextFromImageFiles(files);
  }

  function onDropImages(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length) void extractTextFromImageFiles(files);
  }

  function onDragOverImages(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  async function deleteMeeting(id: number) {
    if (!confirm("Delete this meeting?")) return;
    setErr(null);
    try {
      await api.meetings.remove(id);
      setMeetings((p) => p.filter((x) => x.id !== id));
      setSelM((s) => (s?.id === id ? null : s));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-20 border-b-2 border-primary bg-[hsl(var(--bloomberg-header))] pt-[env(safe-area-inset-top,0)] shadow-[0_1px_0_0_hsl(var(--border))]">
        <div className="mx-auto max-w-[1400px] px-2.5 sm:px-4 py-2.5 sm:py-3 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
          <div className="min-w-0 border-l-[3px] border-primary pl-3">
            <h1 className="text-base sm:text-lg md:text-xl font-bold tracking-tight truncate text-foreground">
              TheBigTracker
            </h1>
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mt-0.5 hidden sm:block">
              Research
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {health && (
              <span
                className={`text-[10px] sm:text-xs px-2 py-1 rounded-sm border font-medium tabular-nums max-w-[120px] sm:max-w-none truncate ${
                  health.openrouter
                    ? "border-emerald-700/50 text-emerald-800 bg-emerald-100/90 dark:border-emerald-600/50 dark:text-emerald-200 dark:bg-emerald-950/60"
                    : "border-amber-700/50 text-amber-950 bg-amber-100/90 dark:border-amber-600/50 dark:text-amber-200 dark:bg-amber-950/50"
                }`}
                title={health.openrouter ? "OpenRouter API key configured" : "Set OPENROUTER_API_KEY on the server"}
              >
                {health.openrouter ? "API OK" : "No API key"}
              </span>
            )}
            <button
              type="button"
              className={`${btnGhost()} !min-h-[40px] sm:!min-h-[44px] !min-w-[40px] sm:!min-w-[44px] !p-1.5 sm:!p-2 !justify-center`}
              onClick={toggleTheme}
              title={theme === "dark" ? "Light theme" : "Dark theme"}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? <IconSun className="w-5 h-5" /> : <IconMoon className="w-5 h-5" />}
            </button>
            <button type="button" className={`${btnGhost()} !min-h-[40px] sm:!min-h-[44px] !py-1.5 sm:!py-2 !px-2 sm:!px-3`} onClick={() => load()}>
              Refresh
            </button>
          </div>
        </div>
      </header>

      <AiModelsBar health={health} />

      <div className="flex-1 flex flex-col min-h-0 mx-auto max-w-[1400px] w-full">
        <section className="shrink-0 border-b border-border bg-muted/30 px-2.5 sm:px-4 py-2 sm:py-3">
          <label htmlFor="paste-main" className="sr-only">
            Paste area
          </label>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) void extractTextFromImageFiles(files);
            }}
          />
          <div
            className="rounded-sm border border-dashed border-border/90 bg-card/40 p-1.5"
            onDrop={onDropImages}
            onDragOver={onDragOverImages}
          >
            <textarea
              id="paste-main"
              className={`${inputClass()} min-h-[88px] sm:min-h-[120px] md:min-h-[140px] font-mono text-xs sm:text-sm leading-snug sm:leading-relaxed border-0 bg-transparent`}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              onPaste={onPasteImages}
              placeholder="Paste or drop…"
              autoComplete="off"
              autoCorrect="off"
            />
          </div>
          <div className="mt-1.5 sm:mt-2 flex flex-row flex-wrap gap-2 items-stretch">
            <button
              type="button"
              className={`${btnGhost()} text-xs shrink-0 justify-center max-sm:flex-1`}
              disabled={aiBusy}
              onClick={() => imageInputRef.current?.click()}
            >
              Choose image…
            </button>
            <button
              type="button"
              className={`${btnPrimary()} min-w-0 flex-1 sm:flex-none sm:min-w-[200px]`}
              disabled={aiBusy || !pasteText.trim()}
              onClick={() => runIdentifyAndSave()}
            >
              {aiBusy ? "Working…" : "Identify & save"}
            </button>
          </div>
          <div className="mt-1.5 sm:mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex items-center gap-1.5 text-[10px] sm:text-[11px] text-muted-foreground cursor-pointer touch-manipulation">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={showAiDebug}
                onChange={(e) => {
                  setShowAiDebug(e.target.checked);
                  if (!e.target.checked) setParsePasteDebug(null);
                }}
              />
              Show AI prompt (debug)
            </label>
          </div>
          {showAiDebug && parsePasteDebug?.parsePasteSystemPrompt ? (
            <details className="mt-1.5 sm:mt-2 rounded-sm border border-border bg-card/80 p-2 text-[11px]" open>
              <summary className="cursor-pointer font-medium text-muted-foreground">
                Parse-paste system prompt
                {parsePasteDebug.userMessageChars != null
                  ? ` · last paste: ${parsePasteDebug.userMessageChars} chars`
                  : ""}
              </summary>
              <pre className="mt-2 max-h-[min(50vh,360px)] overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-snug text-foreground/90">
                {parsePasteDebug.parsePasteSystemPrompt}
              </pre>
            </details>
          ) : null}
          {showAiDebug && parsePasteDebug?.parseResearchSystemPrompt ? (
            <details className="mt-1.5 sm:mt-2 rounded-sm border border-border bg-card/80 p-2 text-[11px]">
              <summary className="cursor-pointer font-medium text-muted-foreground">
                Parse-research system prompt (API only)
              </summary>
              <pre className="mt-2 max-h-[min(40vh,280px)] overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-snug text-foreground/90">
                {parsePasteDebug.parseResearchSystemPrompt}
              </pre>
            </details>
          ) : null}
          <div className="mt-2 sm:mt-3 pt-2 sm:pt-3 border-t border-border/60 flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-stretch sm:gap-2">
              <button
                type="button"
                className={`rounded-sm px-2 py-2 text-xs font-medium touch-manipulation active:opacity-90 transition-colors min-h-[40px] sm:min-h-0 sm:px-2.5 sm:py-1.5 ${
                  tab === "research"
                    ? "bg-accent text-accent-foreground ring-1 ring-border"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setTab("research")}
              >
                Research{" "}
                <span className="tabular-nums opacity-80">
                  (
                  {searchNorm
                    ? `${filteredResearch.length}/${research.length}`
                    : research.length}
                  )
                </span>
              </button>
              <button
                type="button"
                className={`rounded-sm px-2 py-2 text-xs font-medium touch-manipulation active:opacity-90 transition-colors min-h-[40px] sm:min-h-0 sm:px-2.5 sm:py-1.5 ${
                  tab === "meetings"
                    ? "bg-accent text-accent-foreground ring-1 ring-border"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setTab("meetings")}
              >
                Meetings{" "}
                <span className="tabular-nums opacity-80">
                  (
                  {searchNorm
                    ? `${filteredMeetings.length}/${meetings.length}`
                    : meetings.length}
                  )
                </span>
              </button>
            </div>
            <div className="w-full min-w-0">
              <label htmlFor="search-main" className="sr-only">
                Search notes and meetings
              </label>
              <input
                id="search-main"
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                placeholder="Search…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`${inputClass()} text-sm py-2 sm:py-3`}
              />
            </div>
          </div>
        </section>

        <main className="flex-1 flex flex-col min-h-0 overflow-y-auto overscroll-contain px-2.5 py-2 sm:p-4 md:p-6 gap-2 sm:gap-3">
            {success && (
              <div className="rounded-sm border border-emerald-300 bg-emerald-50 text-emerald-900 px-2.5 py-1.5 text-xs sm:text-sm shrink-0 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
                {success}
              </div>
            )}
            {err && (
              <div className="rounded-sm border border-red-300 bg-red-50 text-red-900 px-2.5 py-1.5 text-xs sm:text-sm shrink-0 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
                {err}
              </div>
            )}
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : tab === "research" ? (
              <ResearchBoard
                items={filteredResearch}
                totalCount={research.length}
                selected={selR}
                onSelect={setSelR}
                onDelete={deleteResearch}
              />
            ) : (
              <MeetingsBoard
                items={filteredMeetings}
                totalCount={meetings.length}
                selected={selM}
                onSelect={setSelM}
                onDelete={deleteMeeting}
              />
            )}
        </main>
      </div>
    </div>
  );
}

function ResearchBoard({
  items,
  totalCount,
  selected,
  onSelect,
  onDelete,
}: {
  items: Research[];
  totalCount: number;
  selected: Research | null;
  onSelect: (r: Research | null) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div
      className={`flex flex-col gap-3 sm:gap-4 lg:gap-6 lg:min-h-[min(70vh,800px)] ${
        selected ? "lg:grid lg:grid-cols-12" : ""
      }`}
    >
      <div className={`flex flex-col min-h-0 gap-2 sm:gap-3 ${selected ? "lg:col-span-7" : ""}`}>
        <h2 className="text-[10px] sm:text-xs font-semibold uppercase tracking-widest text-muted-foreground shrink-0">
          Notes
        </h2>
        <div className="grid gap-2 sm:gap-3 grid-cols-1 sm:grid-cols-2 content-start">
          {items.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r)}
              className={`text-left rounded-sm border p-3 sm:p-4 min-h-[64px] sm:min-h-[72px] touch-manipulation active:opacity-90 transition-opacity ${
                selected?.id === r.id ? "border-primary ring-1 ring-primary/40 bg-muted/25" : "border-border hover:bg-muted/15"
              }`}
            >
              <div className="flex items-start justify-between gap-1.5 sm:gap-2 mb-1 sm:mb-2">
                <span className="font-semibold text-[13px] sm:text-sm leading-snug line-clamp-3">
                  {researchDisplayTitle(r)}
                </span>
                {r.rating ? (
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${ratingTone(r.rating)}`}>
                    {r.rating}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {r.date}
                {r.source ? ` · ${r.source}` : ""}
              </p>
            </button>
          ))}
          {items.length === 0 && (
            <p className="text-xs sm:text-sm text-muted-foreground col-span-full py-6 sm:py-10 text-center border border-dashed border-border rounded-sm px-3 sm:px-4">
              {totalCount > 0
                ? "No notes match your search."
                : "No research notes yet. Paste text above and tap Identify & save."}
            </p>
          )}
        </div>
      </div>
      {selected ? (
        <div className="lg:col-span-5 flex flex-col min-h-0 border border-border rounded-sm bg-card/50 overflow-hidden lg:sticky lg:top-4 lg:self-start max-h-[min(58vh,520px)] sm:max-h-[65vh] lg:max-h-[min(75vh,900px)]">
          <div className="px-3 sm:px-4 py-2 sm:py-3 border-b border-border shrink-0 flex items-center justify-between gap-2 bg-muted/20">
            <h3 className="text-xs sm:text-sm font-semibold uppercase tracking-wide text-muted-foreground">Detail</h3>
            <button
              type="button"
              className="text-[11px] sm:text-xs font-medium text-red-700 border border-red-300 rounded-sm px-2.5 sm:px-3 py-1.5 sm:py-2 min-h-[36px] sm:min-h-[40px] touch-manipulation active:opacity-80 dark:text-red-400 dark:border-red-800/80"
              onClick={() => onDelete(selected.id)}
            >
              Delete
            </button>
          </div>
          <div className="overflow-y-auto p-3 sm:p-4 flex-1">
            <ResearchDetail r={selected} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ResearchDetail({ r }: { r: Research }) {
  return (
    <div className="space-y-4 sm:space-y-5 text-sm">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Title</p>
        <p className="font-medium text-base leading-snug">{researchDisplayTitle(r)}</p>
        {(r.company || r.ticker || r.theme) && (
          <p className="text-xs text-muted-foreground mt-1">
            {r.category === "company"
              ? [r.company, r.ticker].filter(Boolean).join(" · ") || "—"
              : r.theme || "—"}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 sm:gap-y-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Date</dt>
          <dd className="mt-0.5">{r.date || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Category</dt>
          <dd className="mt-0.5 capitalize">{r.category}</dd>
        </div>
        <div className="col-span-full">
          <dt className="text-muted-foreground">Source</dt>
          <dd className="mt-0.5 break-words">{r.source || "—"}</dd>
        </div>
        {r.rating ? (
          <div className="col-span-full">
            <dt className="text-muted-foreground">Rating / view</dt>
            <dd className="mt-0.5">
              <span className={`inline-block text-xs px-2 py-0.5 rounded border ${ratingTone(r.rating)}`}>
                {r.rating}
              </span>
            </dd>
          </div>
        ) : null}
      </dl>
      {r.keyPoints?.length ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Key points</p>
          <ul className="list-disc pl-4 space-y-1.5 text-xs leading-relaxed">
            {r.keyPoints.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.tags?.length ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Tags</p>
          <div className="flex flex-wrap gap-1.5">
            {r.tags.map((t) => (
              <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {r.rawText ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Full text</p>
          <pre className="text-xs whitespace-pre-wrap break-words font-sans leading-relaxed text-foreground/90 bg-muted/30 rounded-sm p-2 sm:p-3 max-h-[min(42vh,360px)] sm:max-h-[min(50vh,420px)] overflow-y-auto">
            {r.rawText}
          </pre>
        </div>
      ) : null}
      {r.sourceImage ? <SourceImages stored={r.sourceImage} /> : null}
    </div>
  );
}

function MeetingsBoard({
  items,
  totalCount,
  selected,
  onSelect,
  onDelete,
}: {
  items: Meeting[];
  totalCount: number;
  selected: Meeting | null;
  onSelect: (m: Meeting | null) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div
      className={`flex flex-col gap-3 sm:gap-4 lg:gap-6 lg:min-h-[min(70vh,800px)] ${
        selected ? "lg:grid lg:grid-cols-12" : ""
      }`}
    >
      <div className={`flex flex-col min-h-0 gap-2 sm:gap-3 ${selected ? "lg:col-span-7" : ""}`}>
        <h2 className="text-[10px] sm:text-xs font-semibold uppercase tracking-widest text-muted-foreground shrink-0">
          Meetings
        </h2>
        <div className="grid gap-2 sm:gap-3 grid-cols-1 sm:grid-cols-2 content-start">
          {items.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelect(m)}
              className={`text-left rounded-sm border p-3 sm:p-4 min-h-[72px] sm:min-h-[80px] touch-manipulation active:opacity-90 transition-opacity ${
                selected?.id === m.id ? "border-primary ring-1 ring-primary/40 bg-muted/25" : "border-border hover:bg-muted/15"
              }`}
            >
              <p className="font-semibold text-[13px] sm:text-sm leading-snug line-clamp-3 mb-1 sm:mb-2">{m.eventName || "—"}</p>
              <p className="text-xs text-muted-foreground">
                {m.date}
                {m.time ? ` · ${m.time}` : ""}
              </p>
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{m.invitingParty || "—"}</p>
            </button>
          ))}
          {items.length === 0 && (
            <p className="text-xs sm:text-sm text-muted-foreground col-span-full py-6 sm:py-10 text-center border border-dashed border-border rounded-sm px-3 sm:px-4">
              {totalCount > 0
                ? "No meetings match your search."
                : "No meetings yet. Paste an invite above and tap Identify & save."}
            </p>
          )}
        </div>
      </div>
      {selected ? (
        <div className="lg:col-span-5 flex flex-col min-h-0 border border-border rounded-sm bg-card/50 overflow-hidden lg:sticky lg:top-4 lg:self-start max-h-[min(58vh,520px)] sm:max-h-[65vh] lg:max-h-[min(75vh,900px)]">
          <div className="px-3 sm:px-4 py-2 sm:py-3 border-b border-border shrink-0 flex items-center justify-between gap-2 bg-muted/20">
            <h3 className="text-xs sm:text-sm font-semibold uppercase tracking-wide text-muted-foreground">Detail</h3>
            <button
              type="button"
              className="text-[11px] sm:text-xs font-medium text-red-700 border border-red-300 rounded-sm px-2.5 sm:px-3 py-1.5 sm:py-2 min-h-[36px] sm:min-h-[40px] touch-manipulation active:opacity-80 dark:text-red-400 dark:border-red-800/80"
              onClick={() => onDelete(selected.id)}
            >
              Delete
            </button>
          </div>
          <div className="overflow-y-auto p-3 sm:p-4 flex-1">
            <MeetingDetail m={selected} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MeetingDetail({ m }: { m: Meeting }) {
  const rows: [string, string][] = [
    ["Date", m.date || "—"],
    ["Time", m.time || "—"],
    ["Location", m.location || "—"],
    ["Type", m.nature || "—"],
    ["Inviting party", m.invitingParty || "—"],
    ["RSVP", m.rsvpStatus || "—"],
  ];
  return (
    <div className="space-y-4 sm:space-y-5 text-sm">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Event</p>
        <p className="font-medium text-base leading-snug break-words">{m.eventName || "—"}</p>
      </div>
      <dl className="space-y-2 sm:space-y-3 text-xs">
        {rows.map(([label, val]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 text-foreground break-words">{val}</dd>
          </div>
        ))}
      </dl>
      {m.keyTopics ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Key topics</p>
          <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">{m.keyTopics}</p>
        </div>
      ) : null}
      {m.notes ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Notes</p>
          <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">{m.notes}</p>
        </div>
      ) : null}
      {m.sourceType || m.sourceContent ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Source</p>
          {m.sourceType ? <p className="text-xs text-muted-foreground mb-2">{m.sourceType}</p> : null}
          {m.sourceContent ? (
            <pre className="text-xs whitespace-pre-wrap break-words font-sans leading-relaxed bg-muted/30 rounded-sm p-2 sm:p-3 max-h-[min(38vh,320px)] sm:max-h-[min(45vh,380px)] overflow-y-auto">
              {m.sourceContent}
            </pre>
          ) : null}
        </div>
      ) : null}
      {m.sourceImage?.trim() ? <SourceImages stored={m.sourceImage} /> : null}
    </div>
  );
}
