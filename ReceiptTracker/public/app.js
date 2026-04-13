let currentLang = 'zh';

const dict = {
    zh: {
        title: "記帳助手",
        upload_btn: "拍照 / 上傳收據",
        analyzing: "AI 分析中，請稍候...",
        confirm_title: "請確認資料",
        lbl_date: "日期", lbl_currency: "幣種", lbl_amount: "金額",
        lbl_merchant: "商戶", lbl_desc: "內容", lbl_category: "分類", lbl_note: "備註",
        btn_cancel: "取消", btn_save: "儲存",
        cat_groceries: "買菜", cat_dining: "餐飲", cat_transport: "交通",
        cat_utilities: "水電煤", cat_shopping: "購物", cat_other: "其他",
        stats_title: "本月開支總計", recent_title: "最近紀錄"
    },
    en: {
        title: "Home Finance",
        upload_btn: "Snap / Upload Receipt",
        analyzing: "AI Analyzing...",
        confirm_title: "Confirm Details",
        lbl_date: "Date", lbl_currency: "Currency", lbl_amount: "Amount",
        lbl_merchant: "Merchant", lbl_desc: "Description", lbl_category: "Category", lbl_note: "Note",
        btn_cancel: "Cancel", btn_save: "Save",
        cat_groceries: "Groceries", cat_dining: "Dining", cat_transport: "Transport",
        cat_utilities: "Utilities", cat_shopping: "Shopping", cat_other: "Other",
        stats_title: "This Month's Spending", recent_title: "Recent Records"
    }
};

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[currentLang][key]) {
            if (el.tagName === 'INPUT') el.placeholder = dict[currentLang][key];
            else el.textContent = dict[currentLang][key];
        }
    });
}

document.getElementById('lang-toggle').addEventListener('click', () => {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    applyTranslations();
    loadStats(); // Reload to translate categories
});

// Initialization
applyTranslations();
loadStats();

// Upload flow
document.getElementById('receipt-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('loading').classList.remove('hidden');

    const formData = new FormData();
    formData.append('receipt', file);

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();

        if(data.error) throw new Error(data.error);

        // Populate Form
        document.getElementById('preview-image').src = data.image_path;
        document.getElementById('image_path').value = data.image_path;

        const extracted = data.extracted || {};
        if(extracted.date) document.getElementById('date').value = extracted.date;
        if(extracted.amount) document.getElementById('amount').value = extracted.amount;
        if(extracted.currency) document.getElementById('currency').value = extracted.currency;
        if(extracted.merchant) document.getElementById('merchant').value = extracted.merchant;
        if(extracted.description) document.getElementById('description').value = extracted.description;

        // Category mapping
        const catMap = { "Groceries":"Groceries", "Dining":"Dining", "Transport":"Transport", "Utilities":"Utilities", "Shopping":"Shopping", "Other":"Other", "買菜":"Groceries", "餐飲":"Dining" };
        if(extracted.category && catMap[extracted.category]) {
            document.getElementById('category').value = catMap[extracted.category];
        }

        document.getElementById('form-section').classList.remove('hidden');
        document.getElementById('stats-section').classList.add('hidden');
    } catch (err) {
        alert('Upload failed: ' + err.message);
    } finally {
        document.getElementById('loading').classList.add('hidden');
        e.target.value = ''; // reset
    }
});

document.getElementById('cancel-btn').addEventListener('click', () => {
    document.getElementById('form-section').classList.add('hidden');
    document.getElementById('stats-section').classList.remove('hidden');
});

document.getElementById('expense-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    try {
        const res = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();

        if(result.success) {
            document.getElementById('form-section').classList.add('hidden');
            document.getElementById('stats-section').classList.remove('hidden');
            e.target.reset();
            loadStats();
        }
    } catch(err) {
        alert('Save failed: ' + err.message);
    }
});

async function loadStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();

        const statsList = document.getElementById('stats-list');
        statsList.innerHTML = '';
        data.monthlyStats.forEach(stat => {
            const catKey = 'cat_' + stat.category.toLowerCase();
            const label = dict[currentLang][catKey] || stat.category;
            statsList.innerHTML += `<li><span>${label}</span> <span>${stat.currency} ${stat.total.toFixed(2)}</span></li>`;
        });
        if(data.monthlyStats.length === 0) statsList.innerHTML = '<li>No records this month</li>';

        const recentList = document.getElementById('recent-list');
        recentList.innerHTML = '';
        data.recent.forEach(r => {
            const catKey = 'cat_' + (r.category ? r.category.toLowerCase() : 'other');
            const label = dict[currentLang][catKey] || r.category;
            recentList.innerHTML += `
                <li>
                    <div class="recent-header">
                        <span>${r.merchant}</span>
                        <span>${r.currency} ${r.amount.toFixed(2)}</span>
                    </div>
                    <div class="recent-sub">
                        <span>${r.expense_date}</span>
                        <span>${label}</span>
                    </div>
                </li>
            `;
        });
    } catch(err) {
        console.error("Failed to load stats", err);
    }
}
