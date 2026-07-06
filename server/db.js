import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

/**
 * Keep prepared statements reachable so V8 cannot GC them mid-query (fixes
 * "statement has been finalized" on node:sqlite before Node 22.16 / 24).
 * @param {DatabaseSync} db
 * @param {unknown[]} stmts
 */
function retainStatements(db, stmts) {
  if (!db.__sqliteStmtRefs) db.__sqliteStmtRefs = [];
  db.__sqliteStmtRefs.push(...stmts);
}

/**
 * @param {string} dbPath Absolute path to SQLite file
 */
export function openDb(dbPath) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'company',
      company TEXT NOT NULL DEFAULT '',
      ticker TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      rating TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      key_points TEXT NOT NULL DEFAULT '[]',
      raw_text TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_research_date ON research(date);

    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL DEFAULT '',
      time TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      nature TEXT NOT NULL DEFAULT '',
      event_name TEXT NOT NULL DEFAULT '',
      inviting_party TEXT NOT NULL DEFAULT '',
      key_topics TEXT NOT NULL DEFAULT '',
      rsvp_status TEXT NOT NULL DEFAULT 'Pending',
      notes TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT '',
      source_content TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_date TEXT,
      amount REAL,
      currency TEXT,
      merchant TEXT,
      description TEXT,
      category TEXT,
      note TEXT,
      image_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

    CREATE TABLE IF NOT EXISTS expense_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL,
      item_name TEXT NOT NULL DEFAULT '',
      amount REAL,
      category TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_expense_items_expense_id ON expense_items(expense_id);

    CREATE TABLE IF NOT EXISTS ai_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_kind_status ON ai_jobs(kind, status);
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_created ON ai_jobs(created_at DESC);
  `);
  try {
    const cols = db.prepare("PRAGMA table_info(research)").all();
    if (cols.length && !cols.some((c) => c.name === "title")) {
      db.exec("ALTER TABLE research ADD COLUMN title TEXT NOT NULL DEFAULT '';");
    }
  } catch {
    /* ignore */
  }
  try {
    const rcols = db.prepare("PRAGMA table_info(research)").all();
    if (rcols.length && !rcols.some((c) => c.name === "source_image")) {
      db.exec("ALTER TABLE research ADD COLUMN source_image TEXT NOT NULL DEFAULT '';");
    }
  } catch {
    /* ignore */
  }
  try {
    const mcols = db.prepare("PRAGMA table_info(meetings)").all();
    if (mcols.length && !mcols.some((c) => c.name === "source_image")) {
      db.exec("ALTER TABLE meetings ADD COLUMN source_image TEXT NOT NULL DEFAULT '';");
    }
  } catch {
    /* ignore */
  }
}

function parseJsonArray(s) {
  if (s == null || s === "") return [];
  try {
    const v = JSON.parse(String(s));
    return Array.isArray(v) ? v : [];
  } catch {
    return String(s)
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
}

/** @param {DatabaseSync} db */
export function researchRepo(db) {
  const list = db.prepare(`
    SELECT id, date, category, company, ticker, theme, source, rating, title, key_points, raw_text, tags, source_image
    FROM research ORDER BY id DESC
  `);

  const get = db.prepare(`
    SELECT id, date, category, company, ticker, theme, source, rating, title, key_points, raw_text, tags, source_image
    FROM research WHERE id = ?
  `);

  const insert = db.prepare(`
    INSERT INTO research (date, category, company, ticker, theme, source, rating, title, key_points, raw_text, tags, source_image)
    VALUES (@date, @category, @company, @ticker, @theme, @source, @rating, @title, @key_points, @raw_text, @tags, @source_image)
  `);

  const update = db.prepare(`
    UPDATE research SET
      date = @date,
      category = @category,
      company = @company,
      ticker = @ticker,
      theme = @theme,
      source = @source,
      rating = @rating,
      title = @title,
      key_points = @key_points,
      raw_text = @raw_text,
      tags = @tags,
      source_image = @source_image
    WHERE id = @id
  `);

  const del = db.prepare(`DELETE FROM research WHERE id = ?`);

  retainStatements(db, [list, get, insert, update, del]);

  function rowToApi(r) {
    if (!r) return null;
    return {
      id: r.id,
      date: r.date ?? "",
      category: r.category === "industry" ? "industry" : "company",
      company: r.company ?? "",
      ticker: r.ticker ?? "",
      theme: r.theme ?? "",
      source: r.source ?? "",
      rating: r.rating ?? "",
      title: r.title ?? "",
      keyPoints: parseJsonArray(r.key_points),
      rawText: r.raw_text ?? "",
      tags: parseJsonArray(r.tags),
      sourceImage: r.source_image ?? "",
    };
  }

  return {
    list() {
      return list.all().map(rowToApi);
    },
    getById(id) {
      return rowToApi(get.get(id));
    },
    insert(payload) {
      const kp = payload.keyPoints ?? payload.key_points;
      const tg = payload.tags ?? payload.Tags;
      const keyPoints = JSON.stringify(Array.isArray(kp) ? kp : []);
      const tags = JSON.stringify(Array.isArray(tg) ? tg : []);
      const result = insert.run({
        date: payload.date ?? "",
        category: payload.category === "industry" ? "industry" : "company",
        company: payload.company ?? "",
        ticker: payload.ticker ?? "",
        theme: payload.theme ?? "",
        source: payload.source ?? "",
        rating: payload.rating ?? "",
        title: payload.title ?? "",
        key_points: keyPoints,
        raw_text: payload.rawText ?? payload.raw_text ?? "",
        tags,
        source_image: payload.sourceImage ?? payload.source_image ?? "",
      });
      const rid = Number(result.lastInsertRowid);
      return this.getById(rid);
    },
    update(id, payload) {
      const cur = get.get(id);
      if (!cur) return null;
      const prev = rowToApi(cur);
      const kpIn =
        payload.keyPoints !== undefined
          ? payload.keyPoints
          : payload.key_points !== undefined
            ? payload.key_points
            : undefined;
      const tagsIn =
        payload.tags !== undefined
          ? payload.tags
          : payload.Tags !== undefined
            ? payload.Tags
            : undefined;
      const rawIn =
        payload.rawText !== undefined
          ? payload.rawText
          : payload.raw_text !== undefined
            ? payload.raw_text
            : undefined;
      const titleIn =
        payload.title !== undefined ? String(payload.title) : undefined;
      const srcImgIn =
        payload.sourceImage !== undefined
          ? payload.sourceImage
          : payload.source_image !== undefined
            ? payload.source_image
            : undefined;
      const next = {
        ...prev,
        ...payload,
        id,
        category:
          payload.category !== undefined
            ? payload.category === "industry"
              ? "industry"
              : "company"
            : prev.category,
        keyPoints: kpIn !== undefined ? (Array.isArray(kpIn) ? kpIn : prev.keyPoints) : prev.keyPoints,
        tags: tagsIn !== undefined ? (Array.isArray(tagsIn) ? tagsIn : prev.tags) : prev.tags,
        rawText: rawIn !== undefined ? rawIn : prev.rawText,
        title: titleIn !== undefined ? titleIn : prev.title,
        sourceImage: srcImgIn !== undefined ? String(srcImgIn) : prev.sourceImage,
      };
      update.run({
        date: next.date ?? "",
        category: next.category === "industry" ? "industry" : "company",
        company: next.company ?? "",
        ticker: next.ticker ?? "",
        theme: next.theme ?? "",
        source: next.source ?? "",
        rating: next.rating ?? "",
        title: next.title ?? "",
        key_points: JSON.stringify(next.keyPoints ?? []),
        raw_text: next.rawText ?? "",
        tags: JSON.stringify(next.tags ?? []),
        source_image: next.sourceImage ?? "",
        id,
      });
      return this.getById(id);
    },
    delete(id) {
      const r = del.run(id);
      return r.changes > 0;
    },
  };
}

/** @param {DatabaseSync} db */
export function meetingsRepo(db) {
  const list = db.prepare(`
    SELECT id, date, time, location, nature, event_name, inviting_party, key_topics, rsvp_status, notes, source_type, source_content, source_image
    FROM meetings ORDER BY id DESC
  `);

  const get = db.prepare(`
    SELECT id, date, time, location, nature, event_name, inviting_party, key_topics, rsvp_status, notes, source_type, source_content, source_image
    FROM meetings WHERE id = ?
  `);

  const insert = db.prepare(`
    INSERT INTO meetings (date, time, location, nature, event_name, inviting_party, key_topics, rsvp_status, notes, source_type, source_content, source_image)
    VALUES (@date, @time, @location, @nature, @event_name, @inviting_party, @key_topics, @rsvp_status, @notes, @source_type, @source_content, @source_image)
  `);

  const update = db.prepare(`
    UPDATE meetings SET
      date = @date,
      time = @time,
      location = @location,
      nature = @nature,
      event_name = @event_name,
      inviting_party = @inviting_party,
      key_topics = @key_topics,
      rsvp_status = @rsvp_status,
      notes = @notes,
      source_type = @source_type,
      source_content = @source_content,
      source_image = @source_image
    WHERE id = @id
  `);

  const del = db.prepare(`DELETE FROM meetings WHERE id = ?`);

  retainStatements(db, [list, get, insert, update, del]);

  function rowToApi(r) {
    if (!r) return null;
    return {
      id: r.id,
      date: r.date ?? "",
      time: r.time ?? "",
      location: r.location ?? "",
      nature: r.nature ?? "",
      eventName: r.event_name ?? "",
      invitingParty: r.inviting_party ?? "",
      keyTopics: r.key_topics ?? "",
      rsvpStatus: r.rsvp_status ?? "Pending",
      notes: r.notes ?? "",
      sourceType: r.source_type ?? "",
      sourceContent: r.source_content ?? "",
      sourceImage: r.source_image ?? "",
    };
  }

  return {
    list() {
      return list.all().map(rowToApi);
    },
    getById(id) {
      return rowToApi(get.get(id));
    },
    insert(payload) {
      const result = insert.run({
        date: payload.date ?? "",
        time: payload.time ?? "",
        location: payload.location ?? "",
        nature: payload.nature ?? "",
        event_name: payload.eventName ?? "",
        inviting_party: payload.invitingParty ?? "",
        key_topics: payload.keyTopics ?? "",
        rsvp_status: payload.rsvpStatus ?? "Pending",
        notes: payload.notes ?? "",
        source_type: payload.sourceType ?? "",
        source_content: payload.sourceContent ?? "",
        source_image: payload.sourceImage ?? payload.source_image ?? "",
      });
      const rid = Number(result.lastInsertRowid);
      return this.getById(rid);
    },
    update(id, payload) {
      const cur = get.get(id);
      if (!cur) return null;
      update.run({
        date: payload.date ?? cur.date,
        time: payload.time ?? cur.time,
        location: payload.location ?? cur.location,
        nature: payload.nature ?? cur.nature,
        event_name: payload.eventName ?? cur.event_name,
        inviting_party: payload.invitingParty ?? cur.inviting_party,
        key_topics: payload.keyTopics ?? cur.key_topics,
        rsvp_status: payload.rsvpStatus ?? cur.rsvp_status,
        notes: payload.notes ?? cur.notes,
        source_type: payload.sourceType ?? cur.source_type,
        source_content:
          payload.sourceContent !== undefined
            ? payload.sourceContent
            : cur.source_content,
        source_image:
          payload.sourceImage !== undefined
            ? payload.sourceImage
            : payload.source_image !== undefined
              ? payload.source_image
              : cur.source_image,
        id,
      });
      return this.getById(id);
    },
    delete(id) {
      const r = del.run(id);
      return r.changes > 0;
    },
  };
}

/** Hong Kong civil date YYYY-MM-DD for "today" (chart week boundaries). */
function hkTodayYmd() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const mo = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (y && mo && d) return `${y}-${mo}-${d}`;
  return new Date().toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday (Gregorian civil date). */
function civilDowSun0(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

function ymdAddDays(ymd, deltaDays) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d + deltaDays, 12, 0, 0);
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Week starts Thursday, ends Wednesday. Returns YYYY-MM-DD of that Thursday. */
function thursdayWeekStartYmd(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd).trim())) return null;
  const s = String(ymd).trim();
  const [y, m, d] = s.split("-").map(Number);
  const dow = civilDowSun0(y, m, d);
  const daysSinceThu = (dow - 4 + 7) % 7;
  return ymdAddDays(s, -daysSinceThu);
}

/** Approximate HKD for household chart; override with HOUSEHOLD_FX_* env. */
function amountToHkdForChart(amount, currency) {
  const raw = Number(amount);
  if (!Number.isFinite(raw)) return 0;
  const c = String(currency ?? "HKD")
    .trim()
    .toUpperCase();
  const cny = Number(process.env.HOUSEHOLD_FX_CNY_HKD || 1.09);
  const usd = Number(process.env.HOUSEHOLD_FX_USD_HKD || 7.8);
  const rates = { HKD: 1, CNY: Number.isFinite(cny) ? cny : 1.09, USD: Number.isFinite(usd) ? usd : 7.8 };
  const r = rates[c];
  if (r == null || !Number.isFinite(r)) return raw;
  return raw * r;
}

/** @param {DatabaseSync} db */
/** DB category values that map to a normalized household category. */
const EXPENSE_CATEGORY_DB_VALUES = {
  Groceries: ["Groceries", "買菜"],
  Dining: ["Dining", "餐飲"],
  Transport: ["Transport"],
  Utilities: ["Utilities"],
  Shopping: ["Shopping"],
  Other: ["Other"],
};

function expenseCategoryDbValues(normalized) {
  const key = String(normalized ?? "").trim();
  return EXPENSE_CATEGORY_DB_VALUES[key] || (key ? [key] : []);
}

export function expensesRepo(db) {
  const insertStmt = db.prepare(`
    INSERT INTO expenses (expense_date, amount, currency, merchant, description, category, note, image_path)
    VALUES (@expense_date, @amount, @currency, @merchant, @description, @category, @note, @image_path)
  `);

  const listPageStmt = db.prepare(`
    SELECT id, expense_date, amount, currency, merchant, description, category, note, image_path, created_at
    FROM expenses
    ORDER BY expense_date DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countAllStmt = db.prepare(`SELECT COUNT(*) AS n FROM expenses`);

  const currentMonthStmt = db.prepare(`SELECT strftime('%Y-%m', 'now') AS month`);

  const listOldReceiptImagesStmt = db.prepare(`
    SELECT id, image_path, expense_date, created_at
    FROM expenses
    WHERE TRIM(COALESCE(image_path, '')) != ''
    AND (
      (TRIM(COALESCE(expense_date, '')) != '' AND expense_date < @cutoff)
      OR (TRIM(COALESCE(expense_date, '')) = '' AND date(created_at) < @cutoff)
    )
  `);

  const clearReceiptImageStmt = db.prepare(`
    UPDATE expenses SET image_path = '' WHERE id = ?
  `);

  const listSinceForChartStmt = db.prepare(`
    SELECT expense_date, amount, currency
    FROM expenses
    WHERE expense_date != '' AND expense_date >= ?
  `);

  const monthlyStatsStmt = db.prepare(`
    SELECT category, SUM(amount) AS total, currency
    FROM expenses
    WHERE strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now')
    GROUP BY category, currency
  `);

  const getStmt = db.prepare(`
    SELECT id, expense_date, amount, currency, merchant, description, category, note, image_path, created_at
    FROM expenses WHERE id = ?
  `);

  const updateStmt = db.prepare(`
    UPDATE expenses SET
      expense_date = @expense_date,
      amount = @amount,
      currency = @currency,
      merchant = @merchant,
      description = @description,
      category = @category,
      note = @note,
      image_path = @image_path
    WHERE id = @id
  `);

  const deleteStmt = db.prepare(`DELETE FROM expenses WHERE id = ?`);
  const listItemsStmt = db.prepare(`
    SELECT id, expense_id, item_name, amount, category, created_at
    FROM expense_items
    WHERE expense_id = ?
    ORDER BY id ASC
  `);
  const deleteItemsStmt = db.prepare(`DELETE FROM expense_items WHERE expense_id = ?`);
  const listImagePathsStmt = db.prepare(`
    SELECT image_path FROM expenses
    WHERE image_path IS NOT NULL AND TRIM(image_path) != ''
  `);
  const countImagePathStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM expenses WHERE image_path = ?
  `);
  const insertItemStmt = db.prepare(`
    INSERT INTO expense_items (expense_id, item_name, amount, category)
    VALUES (@expense_id, @item_name, @amount, @category)
  `);

  retainStatements(db, [
    insertStmt,
    listPageStmt,
    countAllStmt,
    currentMonthStmt,
    listSinceForChartStmt,
    monthlyStatsStmt,
    getStmt,
    updateStmt,
    deleteStmt,
    listItemsStmt,
    deleteItemsStmt,
    listImagePathsStmt,
    countImagePathStmt,
    listOldReceiptImagesStmt,
    clearReceiptImageStmt,
    insertItemStmt,
  ]);

  function rowToExpense(r) {
    if (!r) return null;
    return {
      id: r.id,
      expense_date: r.expense_date ?? "",
      amount: Number(r.amount ?? 0),
      currency: r.currency ?? "",
      merchant: r.merchant ?? "",
      description: r.description ?? "",
      category: r.category ?? "",
      note: r.note ?? "",
      image_path: r.image_path ?? "",
      created_at: r.created_at ?? "",
    };
  }

  function rowToExpenseItem(r) {
    if (!r) return null;
    return {
      id: r.id,
      expense_id: r.expense_id,
      item_name: r.item_name ?? "",
      amount: Number(r.amount ?? 0),
      category: r.category ?? "",
      created_at: r.created_at ?? "",
    };
  }

  function normalizeItems(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const name =
          String(x.item_name ?? x.name ?? x.item ?? x.description ?? "").trim();
        const category = String(x.category ?? "").trim();
        const amountRaw = Number(x.amount ?? x.price ?? x.cost ?? 0);
        const amount = Number.isFinite(amountRaw) ? amountRaw : 0;
        if (!name) return null;
        return { item_name: name.slice(0, 300), category: category.slice(0, 120), amount };
      })
      .filter(Boolean);
  }

  return {
    /**
     * @param {object} payload
     * @returns {{ success: true, id: number }}
     */
    insert(payload) {
      const amount = Number(payload.amount);
      const result = insertStmt.run({
        expense_date: String(payload.expense_date ?? payload.date ?? "").trim(),
        amount: Number.isFinite(amount) ? amount : 0,
        currency: String(payload.currency ?? "").trim(),
        merchant: String(payload.merchant ?? "").trim(),
        description: String(payload.description ?? "").trim(),
        category: String(payload.category ?? "").trim(),
        note: String(payload.note ?? "").trim(),
        image_path: String(payload.image_path ?? "").trim(),
      });
      return { success: true, id: Number(result.lastInsertRowid) };
    },

    getById(id) {
      const base = rowToExpense(getStmt.get(id));
      if (!base) return null;
      return {
        ...base,
        items: listItemsStmt.all(id).map((r) => rowToExpenseItem(r)).filter(Boolean),
      };
    },

    /**
     * @param {number} id
     * @param {object} payload
     */
    update(id, payload) {
      const cur = getStmt.get(id);
      if (!cur) return null;
      const prev = rowToExpense(cur);
      const amount = Number(payload.amount ?? prev.amount);
      updateStmt.run({
        expense_date: String(
          payload.expense_date ?? payload.date ?? prev.expense_date ?? ""
        ).trim(),
        amount: Number.isFinite(amount) ? amount : 0,
        currency: String(payload.currency ?? prev.currency ?? "").trim(),
        merchant: String(payload.merchant ?? prev.merchant ?? "").trim(),
        description: String(payload.description ?? prev.description ?? "").trim(),
        category: String(payload.category ?? prev.category ?? "").trim(),
        note: String(payload.note ?? prev.note ?? "").trim(),
        image_path: String(payload.image_path ?? prev.image_path ?? "").trim(),
        id,
      });
      return this.getById(id);
    },

    delete(id) {
      const r = deleteStmt.run(id);
      return r.changes > 0;
    },

    /**
     * Replace all item rows for one expense.
     * @param {number} expenseId
     * @param {object[]} items
     */
    replaceItems(expenseId, items) {
      deleteItemsStmt.run(expenseId);
      const normalized = normalizeItems(items);
      for (const it of normalized) {
        insertItemStmt.run({
          expense_id: expenseId,
          item_name: it.item_name,
          amount: it.amount,
          category: it.category,
        });
      }
      return normalized.length;
    },

    listItems(expenseId) {
      return listItemsStmt.all(expenseId).map((r) => rowToExpenseItem(r)).filter(Boolean);
    },

    listImagePaths() {
      return listImagePathsStmt
        .all()
        .map((r) => String(r.image_path ?? "").trim())
        .filter(Boolean);
    },

    isImagePathInUse(imagePath) {
      const p = String(imagePath ?? "").trim();
      if (!p) return false;
      const row = countImagePathStmt.get(p);
      return Number(row?.n) > 0;
    },

    /**
     * Thu–Wed weeks (Asia/Hong_Kong "today"), totals converted to HKD for chart vs budget.
     * @param {number} weekCount
     */
    weeklySpending(weekCount = 12) {
      const n = Number(weekCount);
      const weeks = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 52) : 12;
      const todayHk = hkTodayYmd();
      const currentWeekStart = thursdayWeekStartYmd(todayHk);
      if (!currentWeekStart) return [];
      const firstWeekStart = ymdAddDays(currentWeekStart, -(weeks - 1) * 7);
      /** @type {{ weekStart: string, weekEnd: string, totalHkd: number }[]} */
      const buckets = [];
      for (let i = 0; i < weeks; i++) {
        const start = ymdAddDays(firstWeekStart, i * 7);
        const end = ymdAddDays(start, 6);
        buckets.push({ weekStart: start, weekEnd: end, totalHkd: 0 });
      }
      const idxByStart = new Map(buckets.map((b, i) => [b.weekStart, i]));
      const rows = listSinceForChartStmt.all(firstWeekStart);
      for (const row of rows) {
        const ws = thursdayWeekStartYmd(row.expense_date);
        if (!ws) continue;
        const idx = idxByStart.get(ws);
        if (idx === undefined) continue;
        buckets[idx].totalHkd += amountToHkdForChart(row.amount, row.currency);
      }
      return buckets;
    },

    stats() {
      const monthlyStats = monthlyStatsStmt.all().map((r) => ({
        category: r.category ?? "",
        total: Number(r.total ?? 0),
        currency: r.currency ?? "",
      }));
      const budgetRaw = Number(process.env.HOUSEHOLD_WEEKLY_BUDGET_HKD ?? 3000);
      const weeklyBudgetHkd = Number.isFinite(budgetRaw) ? budgetRaw : 3000;
      const currentMonth = String(currentMonthStmt.get()?.month ?? "");
      return {
        monthlyStats,
        weeklySpending: this.weeklySpending(12),
        weeklyBudgetHkd,
        currentMonth,
      };
    },

    /**
     * @param {{ limit?: number, offset?: number, month?: string, category?: string, currency?: string }} [opts]
     */
    list(opts = {}) {
      const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 100);
      const offset = Math.max(Number(opts.offset) || 0, 0);
      const month = String(opts.month ?? "").trim();
      const currency = String(opts.currency ?? "").trim().toUpperCase();
      const category = String(opts.category ?? "").trim();
      const hasFilter = month || currency || category;

      if (!hasFilter) {
        const total = Number(countAllStmt.get()?.n ?? 0);
        const records = listPageStmt.all(limit, offset).map((r) => rowToExpense(r));
        return { records, total, limit, offset };
      }

      const params = [];
      let where = "WHERE 1=1";
      if (month) {
        where += " AND TRIM(COALESCE(expense_date, '')) != '' AND strftime('%Y-%m', expense_date) = ?";
        params.push(month);
      }
      if (currency) {
        where += " AND UPPER(TRIM(COALESCE(currency, 'HKD'))) = ?";
        params.push(currency);
      }
      if (category) {
        const cats = expenseCategoryDbValues(category);
        if (cats.length) {
          where += ` AND TRIM(COALESCE(category, '')) IN (${cats.map(() => "?").join(", ")})`;
          params.push(...cats);
        }
      }
      const countSql = `SELECT COUNT(*) AS n FROM expenses ${where}`;
      const listSql = `
        SELECT id, expense_date, amount, currency, merchant, description, category, note, image_path, created_at
        FROM expenses ${where}
        ORDER BY expense_date DESC, id DESC
        LIMIT ? OFFSET ?
      `;
      const total = Number(db.prepare(countSql).get(...params)?.n ?? 0);
      const records = db
        .prepare(listSql)
        .all(...params, limit, offset)
        .map((r) => rowToExpense(r));
      return { records, total, limit, offset };
    },

    /** Expenses with receipt images where expense_date (or created_at) is before cutoff YYYY-MM-DD. */
    listWithReceiptImagesOlderThan(cutoffYmd) {
      const cutoff = String(cutoffYmd ?? "").trim();
      if (!cutoff) return [];
      return listOldReceiptImagesStmt.all({ cutoff }).map((r) => ({
        id: r.id,
        image_path: r.image_path ?? "",
        expense_date: r.expense_date ?? "",
        created_at: r.created_at ?? "",
      }));
    },

    clearReceiptImage(id) {
      const r = clearReceiptImageStmt.run(id);
      return r.changes > 0;
    },
  };
}

/** @typedef {{ kind: string, status: string, payload: object, result?: object|null, error?: string|null, id: number, created_at: string, updated_at: string }} AiJobRow */

/** @param {DatabaseSync} db */
export function aiJobsRepo(db) {
  const insertStmt = db.prepare(`
    INSERT INTO ai_jobs (kind, status, payload, result, error, created_at, updated_at)
    VALUES (@kind, @status, @payload, @result, @error, @created_at, @updated_at)
  `);
  const getStmt = db.prepare(`SELECT * FROM ai_jobs WHERE id = ?`);
  const updateStmt = db.prepare(`
    UPDATE ai_jobs SET
      status = @status,
      payload = @payload,
      result = @result,
      error = @error,
      updated_at = @updated_at
    WHERE id = @id
  `);
  const delStmt = db.prepare(`DELETE FROM ai_jobs WHERE id = ?`);
  const listRecentStmt = db.prepare(`
    SELECT * FROM ai_jobs ORDER BY id DESC LIMIT ?
  `);
  const claimPendingStmt = db.prepare(`
    UPDATE ai_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'
  `);
  const listReceiptPayloadsStmt = db.prepare(`
    SELECT payload FROM ai_jobs WHERE kind = 'receipt'
  `);
  const countReceiptFilenameStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM ai_jobs
    WHERE kind = 'receipt' AND (
      payload LIKE @needle1 OR payload LIKE @needle2
    )
  `);

  retainStatements(db, [insertStmt, getStmt, updateStmt, delStmt, listRecentStmt, claimPendingStmt, listReceiptPayloadsStmt, countReceiptFilenameStmt]);

  function rowToApi(r) {
    if (!r) return null;
    let payload = {};
    let result = null;
    try {
      payload = r.payload ? JSON.parse(String(r.payload)) : {};
    } catch {
      payload = {};
    }
    try {
      result = r.result == null || r.result === "" ? null : JSON.parse(String(r.result));
    } catch {
      result = null;
    }
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      payload,
      result,
      error: r.error ?? null,
      created_at: r.created_at ?? "",
      updated_at: r.updated_at ?? "",
    };
  }

  const nowIso = () => new Date().toISOString();

  return {
    /** @param {{ kind: string, status?: string, payload?: object }} p */
    create(p) {
      const ts = nowIso();
      const payloadJson = JSON.stringify(p.payload ?? {});
      const res = insertStmt.run({
        kind: p.kind,
        status: p.status ?? "pending",
        payload: payloadJson,
        result: null,
        error: null,
        created_at: ts,
        updated_at: ts,
      });
      const id = Number(res.lastInsertRowid);
      return this.getById(id);
    },
    getById(id) {
      return rowToApi(getStmt.get(id));
    },
    /** @param {number} id @param {{ status?: string, payload?: object, result?: object|null, error?: string|null }} fields */
    update(id, fields) {
      const cur = getStmt.get(id);
      if (!cur) return null;
      const prev = rowToApi(cur);
      if (!prev) return null;
      const status = fields.status ?? prev.status;
      const payloadJson =
        fields.payload !== undefined
          ? JSON.stringify(fields.payload ?? {})
          : cur.payload ?? JSON.stringify(prev.payload ?? {});
      let resultJson = null;
      if (fields.result !== undefined) {
        resultJson = fields.result == null ? null : JSON.stringify(fields.result);
      } else {
        resultJson = cur.result ?? null;
      }
      const err =
        fields.error !== undefined ? (fields.error == null ? null : String(fields.error)) : cur.error;
      const ts = nowIso();
      updateStmt.run({
        id,
        status,
        payload: payloadJson,
        result: resultJson,
        error: err,
        updated_at: ts,
      });
      return this.getById(id);
    },
    delete(id) {
      const r = delStmt.run(id);
      return r.changes > 0;
    },
    /** @returns {boolean} true if this call transitioned pending → processing */
    claimPending(id) {
      const ts = nowIso();
      const r = claimPendingStmt.run(ts, id);
      return r.changes > 0;
    },
    /**
     * @param {{ kind?: string, statuses?: string[], limit?: number }} [opts]
     */
    list(opts = {}) {
      const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
      const rows = listRecentStmt.all(limit).map(rowToApi).filter(Boolean);
      let out = rows;
      if (opts.kind) out = out.filter((j) => j.kind === opts.kind);
      if (opts.statuses?.length)
        out = out.filter((j) => opts.statuses.includes(j.status));
      return out;
    },
    listReceiptFilenames() {
      const names = [];
      for (const row of listReceiptPayloadsStmt.all()) {
        let payload = {};
        try {
          payload = row.payload ? JSON.parse(String(row.payload)) : {};
        } catch {
          payload = {};
        }
        const direct = String(payload.filename ?? "").trim();
        if (direct) {
          names.push(direct);
          continue;
        }
        const fromPath = String(payload.image_path ?? "").match(/\/uploads\/([^/?#]+)$/);
        if (fromPath) names.push(fromPath[1]);
      }
      return names;
    },
    isReceiptFilenameReferenced(filename) {
      const name = String(filename ?? "").trim();
      if (!name) return false;
      const row = countReceiptFilenameStmt.get({
        needle1: `%"filename":"${name}"%`,
        needle2: `%/uploads/${name}"%`,
      });
      return Number(row?.n) > 0;
    },
    /** Mark interrupted server runs as pending so workers can retry. */
    resetStaleProcessing() {
      const ts = nowIso();
      const r = db.prepare(`
        UPDATE ai_jobs SET status = 'pending', updated_at = ?
        WHERE status = 'processing'
      `).run(ts);
      return r.changes;
    },
  };
}
