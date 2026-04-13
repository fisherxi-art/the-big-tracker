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

/** @param {DatabaseSync} db */
export function expensesRepo(db) {
  const insertStmt = db.prepare(`
    INSERT INTO expenses (expense_date, amount, currency, merchant, description, category, note, image_path)
    VALUES (@expense_date, @amount, @currency, @merchant, @description, @category, @note, @image_path)
  `);

  const listRecent = db.prepare(`
    SELECT id, expense_date, amount, currency, merchant, description, category, note, image_path, created_at
    FROM expenses
    ORDER BY expense_date DESC, id DESC
    LIMIT 10
  `);

  const monthlyStatsStmt = db.prepare(`
    SELECT category, SUM(amount) AS total, currency
    FROM expenses
    WHERE strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now')
    GROUP BY category, currency
  `);

  retainStatements(db, [insertStmt, listRecent, monthlyStatsStmt]);

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

    stats() {
      const recent = listRecent.all().map((r) => ({
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
      }));
      const monthlyStats = monthlyStatsStmt.all().map((r) => ({
        category: r.category ?? "",
        total: Number(r.total ?? 0),
        currency: r.currency ?? "",
      }));
      return { recent, monthlyStats };
    },
  };
}
