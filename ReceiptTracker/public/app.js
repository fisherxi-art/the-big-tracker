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
    recent_title: "最近紀錄",
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
    recent_title: "Recent Records",
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

function escAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
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
          <img class="preview-image-job" src="${escAttr(image_path)}" alt="">
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
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  document.getElementById("loading").classList.remove("hidden");
  try {
    for (const file of files) {
      const formData = new FormData();
      formData.append("receipt", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
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

    const statsList = document.getElementById("stats-list");
    statsList.innerHTML = "";
    data.monthlyStats.forEach((stat) => {
      const catKey = "cat_" + stat.category.toLowerCase();
      const label = dict[currentLang][catKey] || stat.category;
      statsList.innerHTML += `<li><span>${label}</span> <span>${stat.currency} ${stat.total.toFixed(2)}</span></li>`;
    });
    if (data.monthlyStats.length === 0) statsList.innerHTML = "<li>No records this month</li>";

    const recentList = document.getElementById("recent-list");
    recentList.innerHTML = "";
    data.recent.forEach((r) => {
      recentList.innerHTML += buildSavedExpenseRow(r);
    });
  } catch (err) {
    console.error("Failed to load stats", err);
  }
}

