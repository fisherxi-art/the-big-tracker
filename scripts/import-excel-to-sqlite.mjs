/**
 * One-shot import: Excel workbooks → SQLite (upsert by id).
 * Expected files (default): data/research.xlsx, data/meetings.xlsx
 * Row 1 = headers; data from row 2 (same layout as the original Perplexity export).
 */
import dotenv from "dotenv";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import { openDb } from "../server/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
dotenv.config({ path: join(root, ".env"), override: true });

const DATA_DIR = process.env.DATA_DIR
  ? join(root, process.env.DATA_DIR.replace(/^\.\//, ""))
  : join(root, "data");

function resolveDbPath() {
  const raw = process.env.DATABASE_PATH;
  if (!raw) return join(DATA_DIR, "app.db");
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return join(root, raw.replace(/^\.\//, ""));
}

const RESEARCH_XLSX =
  process.env.EXCEL_RESEARCH_PATH || join(DATA_DIR, "research.xlsx");
const MEETINGS_XLSX =
  process.env.EXCEL_MEETINGS_PATH || join(DATA_DIR, "meetings.xlsx");

function cell(row, i) {
  const v = row.getCell(i).value;
  if (v && typeof v === "object" && "text" in v) return v.text;
  if (v && typeof v === "object" && "result" in v) return v.result ?? "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v ?? "";
}

function parseJsonArrayField(s) {
  if (s == null || s === "") return "[]";
  const str = String(s).trim();
  if (!str) return "[]";
  try {
    const v = JSON.parse(str);
    if (Array.isArray(v)) return JSON.stringify(v);
  } catch {
    /* fallthrough */
  }
  const arr = str
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return JSON.stringify(arr);
}

async function readResearchRows(path) {
  if (!existsSync(path)) {
    console.warn(`Skip research: file not found: ${path}`);
    return [];
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheet = wb.getWorksheet("Sheet1") || wb.worksheets[0];
  if (!sheet) return [];
  const out = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const id = Number(cell(row, 1));
    if (!Number.isFinite(id) || id <= 0) return;
    out.push({
      id,
      date: String(cell(row, 2) || ""),
      category: String(cell(row, 3) || "company"),
      company: String(cell(row, 4) || ""),
      ticker: String(cell(row, 5) || ""),
      theme: String(cell(row, 6) || ""),
      source: String(cell(row, 7) || ""),
      rating: String(cell(row, 8) || ""),
      key_points: parseJsonArrayField(cell(row, 9)),
      raw_text: String(cell(row, 10) || ""),
      tags: parseJsonArrayField(cell(row, 11)),
    });
  });
  return out;
}

async function readMeetingRows(path) {
  if (!existsSync(path)) {
    console.warn(`Skip meetings: file not found: ${path}`);
    return [];
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheet = wb.getWorksheet("Sheet1") || wb.worksheets[0];
  if (!sheet) return [];
  const out = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const id = Number(cell(row, 1));
    if (!Number.isFinite(id) || id <= 0) return;
    out.push({
      id,
      date: String(cell(row, 2) || ""),
      time: String(cell(row, 3) || ""),
      location: String(cell(row, 4) || ""),
      nature: String(cell(row, 5) || ""),
      event_name: String(cell(row, 6) || ""),
      inviting_party: String(cell(row, 7) || ""),
      key_topics: String(cell(row, 8) || ""),
      rsvp_status: String(cell(row, 9) || "Pending"),
      notes: String(cell(row, 10) || ""),
      source_type: String(cell(row, 11) || ""),
      source_content: String(cell(row, 12) ?? ""),
    });
  });
  return out;
}

const dbPath = resolveDbPath();
const db = openDb(dbPath);

const upsertResearch = db.prepare(`
  INSERT OR REPLACE INTO research (id, date, category, company, ticker, theme, source, rating, title, key_points, raw_text, tags)
  VALUES (@id, @date, @category, @company, @ticker, @theme, @source, @rating, @title, @key_points, @raw_text, @tags)
`);

const upsertMeeting = db.prepare(`
  INSERT OR REPLACE INTO meetings (id, date, time, location, nature, event_name, inviting_party, key_topics, rsvp_status, notes, source_type, source_content)
  VALUES (@id, @date, @time, @location, @nature, @event_name, @inviting_party, @key_topics, @rsvp_status, @notes, @source_type, @source_content)
`);

async function main() {
  console.log(`Database: ${dbPath}`);
  console.log(`Research Excel: ${RESEARCH_XLSX}`);
  console.log(`Meetings Excel: ${MEETINGS_XLSX}`);

  const researchRows = await readResearchRows(RESEARCH_XLSX);
  const meetingRows = await readMeetingRows(MEETINGS_XLSX);

  let rN = 0;
  for (const r of researchRows) {
    upsertResearch.run({
      id: r.id,
      date: r.date,
      category: r.category === "industry" ? "industry" : "company",
      company: r.company,
      ticker: r.ticker,
      theme: r.theme,
      source: r.source,
      rating: r.rating,
      title: "",
      key_points: r.key_points,
      raw_text: r.raw_text,
      tags: r.tags,
    });
    rN++;
  }
  let mN = 0;
  for (const m of meetingRows) {
    upsertMeeting.run(m);
    mN++;
  }
  console.log(`Imported ${rN} research row(s), ${mN} meeting row(s).`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
