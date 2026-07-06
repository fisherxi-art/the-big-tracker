let currentLang = "zh";

const dict = {
  zh: {
    title: "記帳助手",
    upload_btn: "拍照 / 上傳收據",
    analyzing: "AI 分析中，請稍候...",
    confirm_title: "請確認資料",
    lbl_date: "日期",
    lbl_currency: "幣種",
    lbl_amount: "金額",
    lbl_merchant: "商戶",
    lbl_desc: "內容",
    lbl_category: "分類",
    lbl_note: "備註",
    btn_cancel: "取消",
    btn_save: "儲存",
    cat_groceries: "買菜",
    cat_dining: "餐飲",
    cat_transport: "交通",
    cat_utilities: "水電煤",
    cat_shopping: "購物",
    cat_other: "其他",
    stats_title: "本月開支總計",
    weekly_chart_title: "每週開支（週四至週三）",
    weekly_budget_legend: "每週預算線",
    recent_title: "最近紀錄",
    records_title: "全部紀錄",
    storage_title: "儲存空間",
    storage_summary: "已用 {used} / {total} MB（收據照片 {receiptMb} MB，{receiptCount} 張）",
    storage_summary_no_disk: "收據照片 {receiptMb} MB（{receiptCount} 張）",
    prune_photos_btn: "刪除 6 個月前的收據照片",
    confirm_prune_photos: "刪除 6 個月前的收據照片？開支紀錄會保留，但照片將永久移除。",
    prune_done: "已移除 {files} 張照片（{records} 筆紀錄）。",
    prune_none: "沒有 6 個月前的收據照片可刪除。",
    category_items_heading: "本月 {label}（{currency}）",
    category_items_empty: "本月此分類沒有紀錄。",
    load_more_records: "載入更多紀錄",
    receipt_thumb_title: "查看收據圖片",
    btn_delete: "刪除",
    /** Combined: open line items + edit form */
    btn_details_edit: "明細 / 編輯",
    confirm_delete: "確定要刪除這筆紀錄嗎？",
    itemized_title: "收據項目明細",
    item_name: "項目",
    item_price: "價格",
    item_category: "分類",
    no_items: "沒有可辨識的項目",
    job_queued: "已加入佇列…",
    job_failed: "分析失敗",
    dismiss: "關閉",
  },
  en: {
    title: "Home Finance",
    upload_btn: "Snap / Upload Receipt(s)",
    analyzing: "AI analyzing…",
    confirm_title: "Confirm Details",
    lbl_date: "Date",
    lbl_currency: "Currency",
    lbl_amount: "Amount",
    lbl_merchant: "Merchant",
    lbl_desc: "Description",
    lbl_category: "Category",
    lbl_note: "Note",
    btn_cancel: "Dismiss",
    btn_save: "Save",
    cat_groceries: "Groceries",
    cat_dining: "Dining",
    cat_transport: "Transport",
    cat_utilities: "Utilities",
    cat_shopping: "Shopping",
    cat_other: "Other",
    stats_title: "This Month's Spending",
    weekly_chart_title: "Weekly spending (Thu–Wed)",
    weekly_budget_legend: "Weekly budget line",
    recent_title: "Recent Records",
    records_title: "All records",
    storage_title: "Storage",
    storage_summary: "Using {used} / {total} MB (receipt photos {receiptMb} MB, {receiptCount} files)",
    storage_summary_no_disk: "Receipt photos {receiptMb} MB ({receiptCount} files)",
    prune_photos_btn: "Delete photos older than 6 months",
    confirm_prune_photos: "Delete receipt photos older than 6 months? Expense records stay; photos are removed permanently.",
    prune_done: "Removed {files} photo(s) from {records} record(s).",
    prune_none: "No receipt photos older than 6 months to delete.",
    category_items_heading: "{label} this month ({currency})",
    category_items_empty: "No records in this category this month.",
    load_more_records: "Load more records",
    receipt_thumb_title: "View receipt image",
    btn_delete: "Delete",
    btn_details_edit: "Details / Edit",
    confirm_delete: "Delete this expense record?",
    itemized_title: "Receipt line items",
    item_name: "Item",
    item_price: "Price",
    item_category: "Category",
    no_items: "No identifiable line items",
    job_queued: "Queued…",
    job_failed: "Analysis failed",
    dismiss: "Dismiss",
  },
};

function t(key) {
  return dict[currentLang][key] || key;
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (dict[currentLang][key]) {
      if (el.tagName === "INPUT") el.placeholder = dict[currentLang][key];
      else el.textContent = dict[currentLang][key];
    }
  });
}

document.getElementById("lang-toggle").addEventListener("click", () => {
  currentLang = currentLang === "zh" ? "en" : "zh";
  applyTranslations();
  loadStats();
  loadReceiptJobs();
});

let receiptPollTimer = null;
let activeCategoryFilter = null;
let statsCurrentMonth = "";
const RECORDS_PAGE_SIZE = 40;
let recordsOffset = 0;
let recordsTotal = 0;
let recordsLoading = false;

function categoryFilterKey(category, currency) {
  return `${category}\0${String(currency || "HKD").toUpperCase()}`;
}

async function renderCategoryItemsPanel(category, currency, label) {
  const panel = document.getElementById("category-items-panel");
  const heading = document.getElementById("category-items-heading");
  const list = document.getElementById("category-items-list");
  if (!panel || !heading || !list) return;

  const cur = String(currency || "HKD").toUpperCase();
  const cat = normalizeExpenseCategory(category);
  heading.textContent = formatTemplate(t("category_items_heading"), { label, currency: cur });
  list.innerHTML = `<li class="category-items-empty">${escAttr(t("analyzing"))}</li>`;
  panel.classList.remove("hidden");

  try {
    const params = new URLSearchParams({
      month: statsCurrentMonth,
      category: cat,
      currency: cur,
      limit: "100",
      offset: "0",
    });
    const res = await fetch(`/api/expenses?${params}`);
    const data = await readApiJson(res);
    const items = data.records || [];
    if (items.length === 0) {
      list.innerHTML = `<li class="category-items-empty">${escAttr(t("category_items_empty"))}</li>`;
    } else {
      list.innerHTML = items
        .map((r) => {
          const amt = typeof r.amount === "number" ? r.amount : Number(r.amount);
          const amtStr = Number.isFinite(amt) ? amt.toFixed(2) : "";
          const merchant = String(r.merchant || r.description || "").trim() || "—";
          return `<li class="category-item">
          <span class="category-item-date">${escAttr(r.expense_date)}</span>
          <span class="category-item-merchant">${escAttr(merchant)}</span>
          <span class="category-item-amount">${escAttr(cur)} ${escAttr(amtStr)}</span>
        </li>`;
        })
        .join("");
    }
  } catch (err) {
    list.innerHTML = `<li class="category-items-empty">${escAttr(err.message || String(err))}</li>`;
  }
}

async function toggleCategoryItems(category, currency, label) {
  const key = categoryFilterKey(category, currency);
  const panel = document.getElementById("category-items-panel");
  if (activeCategoryFilter === key) {
    activeCategoryFilter = null;
    panel?.classList.add("hidden");
    document.querySelectorAll(".stats-category-btn.active").forEach((b) => b.classList.remove("active"));
    return;
  }
  activeCategoryFilter = key;
  document.querySelectorAll(".stats-category-btn").forEach((b) => {
    b.classList.toggle(
      "active",
      b.dataset.category === category && String(b.dataset.currency || "").toUpperCase() === String(currency || "HKD").toUpperCase()
    );
  });
  renderCategoryItemsPanel(category, currency, label);
}

function updateLoadMoreButton() {
  const btn = document.getElementById("load-more-records");
  if (!btn) return;
  const remaining = Math.max(0, recordsTotal - recordsOffset);
  if (remaining <= 0) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  const base = t("load_more_records");
  btn.textContent = `${base} (${remaining})`;
}

async function loadExpenseRecords({ reset = false } = {}) {
  if (recordsLoading) return;
  recordsLoading = true;
  const btn = document.getElementById("load-more-records");
  if (reset) {
    recordsOffset = 0;
    recordsTotal = 0;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(
      `/api/expenses?limit=${RECORDS_PAGE_SIZE}&offset=${recordsOffset}`
    );
    const data = await readApiJson(res);
    const rows = data.records || [];
    recordsTotal = Number(data.total) || 0;
    const list = document.getElementById("recent-list");
    if (!list) return;
    if (reset) list.innerHTML = "";
    if (reset && rows.length === 0) {
      list.innerHTML = `<li class="records-empty">${escAttr(currentLang === "zh" ? "尚無紀錄" : "No records yet")}</li>`;
    } else {
      list.insertAdjacentHTML("beforeend", rows.map((r) => buildSavedExpenseRow(r)).join(""));
    }
    recordsOffset += rows.length;
    updateLoadMoreButton();
  } catch (err) {
    console.error("loadExpenseRecords", err);
    if (reset) {
      const list = document.getElementById("recent-list");
      if (list) {
        list.innerHTML = `<li class="records-empty">${escAttr(err.message || String(err))}</li>`;
      }
    }
  } finally {
    recordsLoading = false;
    if (btn) btn.disabled = false;
  }
}

document.getElementById("load-more-records")?.addEventListener("click", () => {
  void loadExpenseRecords();
});

document.getElementById("stats-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".stats-category-btn");
  if (!btn) return;
  toggleCategoryItems(btn.dataset.category, btn.dataset.currency, btn.textContent.trim());
});

function formatTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

function renderStorageSummary(storage) {
  const el = document.getElementById("storage-summary");
  const fill = document.getElementById("storage-bar-fill");
  const bar = document.querySelector(".storage-bar");
  if (!el || !storage) return;
  const receiptMb = storage.receiptStorageMb ?? 0;
  const receiptCount = storage.receiptFileCount ?? 0;
  const used = storage.diskUsedMb;
  const total = storage.diskTotalMb;
  if (used != null && total != null && total > 0) {
    el.textContent = formatTemplate(t("storage_summary"), {
      used,
      total,
      receiptMb,
      receiptCount,
    });
    const pct = Math.min(100, Math.max(0, (used / total) * 100));
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    if (bar) {
      bar.setAttribute("aria-valuenow", String(Math.round(pct)));
      bar.setAttribute("aria-valuetext", `${used} MB of ${total} MB`);
    }
  } else {
    el.textContent = formatTemplate(t("storage_summary_no_disk"), { receiptMb, receiptCount });
    if (fill) fill.style.width = "0%";
  }
}

async function pruneOldReceiptPhotos() {
  if (!confirm(t("confirm_prune_photos"))) return;
  try {
    const res = await fetch("/api/household/prune-receipt-photos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 6 }),
    });
    const data = await readApiJson(res);
    const files = data.filesRemoved ?? 0;
    const records = data.recordsUpdated ?? 0;
    alert(files > 0 ? formatTemplate(t("prune_done"), { files, records }) : t("prune_none"));
    await loadStats();
  } catch (err) {
    alert(err.message || String(err));
  }
}

document.getElementById("prune-receipt-photos")?.addEventListener("click", pruneOldReceiptPhotos);

function escAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** Safari throws "The string did not match the expected pattern" when res.json() hits HTML/plain text. */
async function readApiJson(res) {
  const text = await res.text();
  if (!text.trim()) {
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return {};
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const html = /^\s*</.test(text);
    throw new Error(
      html
        ? `Server error (${res.status}) — try again or check server logs`
        : `Invalid server response (${res.status})`
    );
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** `input[type=date]` requires YYYY-MM-DD; DB values may be unpadded. */
function formatDateForInput(v) {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return s.slice(0, 10);
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function categoryOptions(selected) {
  const opts = [
    ["Groceries", "cat_groceries"],
    ["Dining", "cat_dining"],
    ["Transport", "cat_transport"],
    ["Utilities", "cat_utilities"],
    ["Shopping", "cat_shopping"],
    ["Other", "cat_other"],
  ];
  return opts
    .map(
      ([val, dk]) =>
        `<option value="${val}"${selected === val ? " selected" : ""}>${t(dk)} (${val})</option>`
    )
    .join("");
}

function normalizeExpenseCategory(c) {
  const m = {
    Groceries: "Groceries",
    Dining: "Dining",
    Transport: "Transport",
    Utilities: "Utilities",
    Shopping: "Shopping",
    Other: "Other",
    買菜: "Groceries",
    餐飲: "Dining",
  };
  const x = String(c || "").trim();
  if (m[x]) return m[x];
  if (["Groceries", "Dining", "Transport", "Utilities", "Shopping", "Other"].includes(x)) return x;
  return "Other";
}

function currencyOptions(selected) {
  const curRaw = String(selected || "HKD").toUpperCase();
  const cur = ["HKD", "CNY", "USD"].includes(curRaw) ? curRaw : "HKD";
  return `<option value="HKD"${cur === "HKD" ? " selected" : ""}>HKD</option>
                  <option value="CNY"${cur === "CNY" ? " selected" : ""}>CNY</option>
                  <option value="USD"${cur === "USD" ? " selected" : ""}>USD</option>`;
}

/**
 * Bar chart: one bar per week (Thu–Wed), totals in HKD; dashed line = weekly budget.
 * @param {{ weekStart: string, weekEnd: string, totalHkd: number }[]} weeklySpending
 * @param {number} budgetHkd
 */
function renderWeeklyChart(weeklySpending, budgetHkd) {
  const host = document.getElementById("weekly-chart");
  const legend = document.getElementById("weekly-chart-legend");
  if (!host) return;
  if (!Array.isArray(weeklySpending) || weeklySpending.length === 0) {
    host.innerHTML = "";
    if (legend) legend.textContent = "";
    return;
  }
  const budgetLine = Number(budgetHkd);
  const budget = Number.isFinite(budgetLine) ? budgetLine : 3000;
  if (legend) {
    legend.textContent = `${t("weekly_budget_legend")}: ${budget.toFixed(0)} HKD`;
  }
  const W = 320;
  const H = 236;
  const padL = 40;
  const padB = 52;
  const padT = 12;
  const padR = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxSpend = Math.max(...weeklySpending.map((w) => Number(w.totalHkd) || 0), 0);
  const maxY = Math.max(budget * 1.02, maxSpend * 1.08, 1);
  const n = weeklySpending.length;
  const gap = 3;
  const barW = Math.max(2, (plotW - gap * (n - 1)) / n);
  const y0 = padT + plotH;
  let rects = "";
  weeklySpending.forEach((w, i) => {
    const total = Number(w.totalHkd) || 0;
    const x = padL + i * (barW + gap);
    const h = (total / maxY) * plotH;
    const y = y0 - h;
    const over = total > budget ? " weekly-bar--over" : "";
    rects += `<rect class="weekly-bar${over}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(h, 0).toFixed(2)}" rx="2" />`;
  });
  const budgetY = y0 - (budget / maxY) * plotH;
  const line = `<line class="weekly-budget-line" x1="${padL}" y1="${budgetY.toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${budgetY.toFixed(2)}" />`;
  const tagX = W - 2;
  const tagY = Math.max(padT + 10, budgetY - 4);
  const budgetTag = `<text class="weekly-budget-tag" x="${tagX}" y="${tagY.toFixed(2)}" text-anchor="end">${escAttr(budget.toFixed(0))}</text>`;
  const labelPivotY = y0 + 4;
  let xLabs = "";
  weeklySpending.forEach((w, i) => {
    const cx = padL + i * (barW + gap) + barW / 2;
    const short = String(w.weekStart || "").slice(5);
    const xf = cx.toFixed(2);
    const yf = labelPivotY.toFixed(2);
    xLabs += `<text class="weekly-chart-label" x="${xf}" y="${yf}" text-anchor="end" dominant-baseline="alphabetic" transform="rotate(-52 ${xf} ${yf})">${escAttr(short)}</text>`;
  });
  const yMaxLab = `<text class="weekly-y-label" x="${padL - 4}" y="${(padT + 10).toFixed(2)}" text-anchor="end">${escAttr(String(Math.round(maxY)))}</text>`;
  const y0Lab = `<text class="weekly-y-label" x="${padL - 4}" y="${(y0 + 4).toFixed(2)}" text-anchor="end">0</text>`;
  const aria = escAttr(t("weekly_chart_title"));
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${aria}">${yMaxLab}${y0Lab}${rects}${line}${budgetTag}${xLabs}</svg>`;
}

function renderExpenseItems(items) {
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) {
    return `<p class="recent-items-empty">${escAttr(t("no_items"))}</p>`;
  }
  const body = rows
    .map((it) => {
      const name = String(it.item_name ?? "").trim();
      const category = String(it.category ?? "").trim() || "Other";
      const amountNum = Number(it.amount ?? 0);
      const amount = Number.isFinite(amountNum) ? amountNum.toFixed(2) : "0.00";
      return `<tr>
        <td>${escAttr(name)}</td>
        <td>${escAttr(amount)}</td>
        <td>${escAttr(category)}</td>
      </tr>`;
    })
    .join("");
  return `<div class="recent-items-table-wrap">
      <table class="recent-items-table">
        <thead>
          <tr>
            <th>${escAttr(t("item_name"))}</th>
            <th>${escAttr(t("item_price"))}</th>
            <th>${escAttr(t("item_category"))}</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function buildSavedExpenseRow(r) {
  const catKey = "cat_" + (r.category ? r.category.toLowerCase() : "other");
  const label = dict[currentLang][catKey] || r.category;
  const path = (r.image_path && String(r.image_path).trim()) || "";
  const thumb = path
    ? `<a class="recent-thumb-wrap" href="${escAttr(path)}" target="_blank" rel="noopener noreferrer" title="${escAttr(t("receipt_thumb_title"))}">
          <img class="recent-thumb" src="${escAttr(path)}" alt="" loading="lazy" width="72" height="72" />
        </a>`
    : "";
  const cat = normalizeExpenseCategory(r.category);
  const amt = typeof r.amount === "number" ? r.amount : Number(r.amount);
  return `
                <li class="recent-item" data-expense-id="${r.id}">
                    ${thumb}
                    <div class="recent-item-body">
                    <div class="recent-item-summary">
                    <div class="recent-header">
                        <span>${escAttr(r.merchant)}</span>
                        <span>${escAttr(r.currency)} ${Number.isFinite(amt) ? amt.toFixed(2) : ""}</span>
                    </div>
                    <div class="recent-sub">
                        <span>${escAttr(r.expense_date)}</span>
                        <span>${escAttr(label)}</span>
                    </div>
                    <div class="recent-item-actions">
                      <button type="button" class="btn-link recent-btn-record" data-expense-id="${r.id}">${escAttr(t("btn_details_edit"))}</button>
                      <button type="button" class="btn-link btn-link-danger recent-btn-delete" data-expense-id="${r.id}">${escAttr(t("btn_delete"))}</button>
                    </div>
                    </div>
                    <section class="recent-item-details hidden" data-expense-details-for="${r.id}">
                      <h4>${escAttr(t("itemized_title"))}</h4>
                      <div class="recent-item-details-body">${escAttr(t("analyzing"))}</div>
                    </section>
                    <form class="recent-expense-form hidden" data-expense-id="${r.id}" novalidate>
            <input type="hidden" name="image_path" value="${escAttr(path)}">
            ${
              path
                ? `<div class="form-group recent-receipt-link"><a href="${escAttr(path)}" target="_blank" rel="noopener noreferrer">${escAttr(t("receipt_thumb_title"))}</a></div>`
                : ""
            }
            <div class="form-group">
              <label>${escAttr(t("lbl_date"))}</label>
              <input type="date" name="date" value="${escAttr(formatDateForInput(r.expense_date))}">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>${escAttr(t("lbl_currency"))}</label>
                <select name="currency">${currencyOptions(r.currency)}</select>
              </div>
              <div class="form-group">
                <label>${escAttr(t("lbl_amount"))}</label>
                <input type="number" name="amount" step="0.01" value="${Number.isFinite(amt) ? amt : ""}">
              </div>
            </div>
            <div class="form-group">
              <label>${escAttr(t("lbl_merchant"))}</label>
              <input type="text" name="merchant" value="${escAttr(r.merchant || "")}">
            </div>
            <div class="form-group">
              <label>${escAttr(t("lbl_desc"))}</label>
              <input type="text" name="description" value="${escAttr(r.description || "")}">
            </div>
            <div class="form-group">
              <label>${escAttr(t("lbl_category"))}</label>
              <select name="category">${categoryOptions(cat)}</select>
            </div>
            <div class="form-group">
              <label>${escAttr(t("lbl_note"))}</label>
              <input type="text" name="note" value="${escAttr(r.note || "")}">
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-secondary recent-btn-cancel-edit">${escAttr(t("btn_cancel"))}</button>
              <button type="submit" class="btn btn-primary">${escAttr(t("btn_save"))}</button>
            </div>
          </form>
                    </div>
                </li>
            `;
}

function renderReceiptJobs(jobs) {
  const el = document.getElementById("receipt-jobs");
  if (!el) return;
  const receiptJobs = (jobs || []).filter((j) => j.kind === "receipt");
  if (receiptJobs.length === 0) {
    el.innerHTML = "";
    return;
  }
  const catMap = {
    Groceries: "Groceries",
    Dining: "Dining",
    Transport: "Transport",
    Utilities: "Utilities",
    Shopping: "Shopping",
    Other: "Other",
    買菜: "Groceries",
    餐飲: "Dining",
  };
  el.innerHTML = receiptJobs
    .map((job) => {
      const id = job.id;
      const st = job.status;
      if (st === "failed") {
        return `
        <section class="card receipt-job-card" data-job-id="${id}">
          <p class="job-error">${escAttr(job.error || t("job_failed"))}</p>
          <button type="button" class="btn btn-secondary job-dismiss" data-job-id="${id}">${t("dismiss")}</button>
        </section>`;
      }
      if (st === "pending" || st === "processing") {
        return `
        <section class="card receipt-job-card" data-job-id="${id}">
          <p class="job-status">${escAttr(t("analyzing"))} (#${id})</p>
        </section>`;
      }
      if (st === "completed") {
        const extracted = (job.result && job.result.extracted) || {};
        const image_path = (job.result && job.result.image_path) || job.payload.image_path || "";
        let cat = "Other";
        if (extracted.category && catMap[extracted.category]) cat = catMap[extracted.category];
        const curRaw = String(extracted.currency || "HKD").toUpperCase();
        const cur = ["HKD", "CNY", "USD"].includes(curRaw) ? curRaw : "HKD";
        return `
        <section class="card receipt-job-card" data-job-id="${id}">
          <h2>${escAttr(t("confirm_title"))} #${id}</h2>
          <details class="receipt-job-preview">
            <summary class="receipt-job-preview-summary">
              <img class="receipt-job-preview-thumb" src="${escAttr(image_path)}" alt="" width="72" height="72" loading="lazy">
              <span class="receipt-job-preview-label">${escAttr(t("receipt_thumb_title"))}</span>
            </summary>
            <div class="receipt-job-preview-expanded-wrap">
              <img class="receipt-job-preview-expanded" src="${escAttr(image_path)}" alt="">
            </div>
          </details>
          <div class="receipt-job-line-items">
            <h3 class="receipt-job-line-items-title">${escAttr(t("itemized_title"))}</h3>
            ${renderExpenseItems(extracted.items)}
          </div>
          <form class="expense-job-form" data-job-id="${id}">
            <input type="hidden" name="image_path" value="${escAttr(image_path)}">
            <input type="hidden" name="job_id" value="${id}">
            <div class="form-group">
              <label>${escAttr(t("lbl_date"))}</label>
              <input type="date" name="date" value="${escAttr(extracted.date || "")}">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>${escAttr(t("lbl_currency"))}</label>
                <select name="currency">
                  <option value="HKD"${cur === "HKD" ? " selected" : ""}>HKD</option>
                  <option value="CNY"${cur === "CNY" ? " selected" : ""}>CNY</option>
                  <option value="USD"${cur === "USD" ? " selected" : ""}>USD</option>
                </select>
              </div>
              <div class="form-group">
                <label>${escAttr(t("lbl_amount"))}</label>
                <input type="number" name="amount" step="0.01" value="${escAttr(extracted.amount != null ? extracted.amount : "")}">
              </div>
            </div>
            <div class="form-group">
              <label>${escAttr(t("lbl_merchant"))}</label>
              <input type="text" name="merchant" value="${escAttr(extracted.merchant || "")}">
            </div>
            <div class="form-group">
              <label>${escAttr(t("lbl_desc"))}</label>
              <input type="text" name="description" value="${escAttr(extracted.description || "")}">
            </div>
            <div class="form-group">
              <label>${escAttr(t("lbl_category"))}</label>
              <select name="category">${categoryOptions(cat)}</select>
            </div>
            <div class="form-group">
              <label>${escAttr(t("lbl_note"))}</label>
              <input type="text" name="note" placeholder="Optional">
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-secondary job-dismiss" data-job-id="${id}">${t("btn_cancel")}</button>
              <button type="submit" class="btn btn-primary">${t("btn_save")}</button>
            </div>
          </form>
        </section>`;
      }
      return "";
    })
    .join("");
}

async function loadReceiptJobs() {
  try {
    const res = await fetch("/api/ai/jobs?kind=receipt&limit=50");
    const data = await res.json();
    const jobs = data.jobs || [];
    renderReceiptJobs(jobs);
    const busy = jobs.some(
      (j) => j.kind === "receipt" && (j.status === "pending" || j.status === "processing")
    );
    if (busy) {
      if (!receiptPollTimer) {
        receiptPollTimer = setInterval(loadReceiptJobs, 2000);
      }
    } else if (receiptPollTimer) {
      clearInterval(receiptPollTimer);
      receiptPollTimer = null;
    }
  } catch (e) {
    console.error("loadReceiptJobs", e);
  }
}

document.getElementById("receipt-jobs").addEventListener("click", async (e) => {
  const btn = e.target.closest(".job-dismiss");
  if (!btn) return;
  const id = Number(btn.dataset.jobId);
  if (!id) return;
  try {
    const res = await fetch(`/api/ai/jobs/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error || "Delete failed");
    await loadReceiptJobs();
    await loadStats();
  } catch (err) {
    alert(err.message || String(err));
  }
});

document.getElementById("receipt-jobs").addEventListener("submit", async (e) => {
  const form = e.target;
  if (!form.classList.contains("expense-job-form")) return;
  e.preventDefault();
  const jobId = Number(form.dataset.jobId);
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  data.job_id = jobId;
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    if (result.success) {
      await loadReceiptJobs();
      await loadStats();
      document.getElementById("stats-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (err) {
    alert("Save failed: " + err.message);
  }
});

document.getElementById("receipt-upload").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []).filter((f) => f && f.size > 0);
  if (!files.length) return;
  document.getElementById("loading").classList.remove("hidden");
  try {
    for (const file of files) {
      const formData = new FormData();
      formData.append("receipt", file, file.name || "receipt.jpg");
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      await readApiJson(res);
    }
    await loadReceiptJobs();
  } catch (err) {
    alert("Upload failed: " + err.message);
  } finally {
    document.getElementById("loading").classList.add("hidden");
    e.target.value = "";
  }
});

async function loadExpenseDetails(id, container) {
  try {
    const res = await fetch(`/api/expenses/${id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Load details failed");
    const items = Array.isArray(data.items) ? data.items : [];
    const bodyEl = container.querySelector(".recent-item-details-body");
    if (bodyEl) bodyEl.innerHTML = renderExpenseItems(items);
  } catch (err) {
    const bodyEl = container.querySelector(".recent-item-details-body");
    if (bodyEl) bodyEl.textContent = err.message || String(err);
  }
}

document.getElementById("recent-list").addEventListener("click", (e) => {
  const recordBtn = e.target.closest(".recent-btn-record");
  if (recordBtn) {
    const id = recordBtn.dataset.expenseId;
    const details = document.querySelector(`.recent-item-details[data-expense-details-for="${id}"]`);
    const form = document.querySelector(`.recent-expense-form[data-expense-id="${id}"]`);
    if (!details || !form) return;
    const isOpen =
      !details.classList.contains("hidden") || !form.classList.contains("hidden");
    document.querySelectorAll("#recent-list .recent-item-details").forEach((x) =>
      x.classList.add("hidden")
    );
    document.querySelectorAll("#recent-list .recent-expense-form").forEach((f) =>
      f.classList.add("hidden")
    );
    if (!isOpen) {
      details.classList.remove("hidden");
      form.classList.remove("hidden");
      const bodyEl = details.querySelector(".recent-item-details-body");
      if (bodyEl && !details.dataset.loaded) {
        bodyEl.textContent = t("analyzing");
        details.dataset.loaded = "1";
        void loadExpenseDetails(id, details);
      }
    }
    return;
  }
  const cancelBtn = e.target.closest(".recent-btn-cancel-edit");
  if (cancelBtn) {
    const form = cancelBtn.closest(".recent-expense-form");
    if (form) {
      form.classList.add("hidden");
      const rid = form.dataset.expenseId;
      const details = document.querySelector(
        `.recent-item-details[data-expense-details-for="${rid}"]`
      );
      if (details) details.classList.add("hidden");
    }
    return;
  }
  const delBtn = e.target.closest(".recent-btn-delete");
  if (delBtn) {
    const id = delBtn.dataset.expenseId;
    if (!id || !confirm(t("confirm_delete"))) return;
    void (async () => {
      try {
        const res = await fetch(`/api/expenses/${id}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Delete failed");
        await loadStats();
      } catch (err) {
        alert(err.message || String(err));
      }
    })();
  }
});

/**
 * Submit event target can be the form or the submit control (browser-dependent).
 * If we don't match the form and call preventDefault(), the browser does a full
 * page navigation and edits appear to "not save".
 */
async function handleRecentExpenseFormSubmit(e) {
  const form = e.target.closest?.("form.recent-expense-form");
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.expenseId;
  if (!id) return;
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  try {
    const res = await fetch(`/api/expenses/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Save failed");
    form.classList.add("hidden");
    await loadStats();
  } catch (err) {
    alert(err.message || String(err));
  }
}

document.addEventListener("submit", handleRecentExpenseFormSubmit);

applyTranslations();
loadStats();
loadReceiptJobs();

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();

    renderWeeklyChart(
      Array.isArray(data.weeklySpending) ? data.weeklySpending : [],
      data.weeklyBudgetHkd != null ? Number(data.weeklyBudgetHkd) : 3000
    );

    const statsList = document.getElementById("stats-list");
    statsList.innerHTML = "";
    activeCategoryFilter = null;
    document.getElementById("category-items-panel")?.classList.add("hidden");

    data.monthlyStats.forEach((stat) => {
      const normalizedCat = normalizeExpenseCategory(stat.category);
      const catKey = "cat_" + normalizedCat.toLowerCase();
      const label = dict[currentLang][catKey] || stat.category;
      const cur = escAttr(stat.currency || "HKD");
      statsList.innerHTML += `<li class="stats-row">
        <button type="button" class="stats-category-btn" data-category="${escAttr(normalizedCat)}" data-currency="${cur}">${escAttr(label)}</button>
        <span class="stats-row-total">${cur} ${stat.total.toFixed(2)}</span>
      </li>`;
    });
    if (data.monthlyStats.length === 0) statsList.innerHTML = "<li>No records this month</li>";

    renderStorageSummary(data.storage);

    statsCurrentMonth = String(data.currentMonth || "");
    await loadExpenseRecords({ reset: true });
  } catch (err) {
    console.error("Failed to load stats", err);
  }
}

