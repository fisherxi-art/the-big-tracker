const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist
const uploadDir = path.join(__dirname, 'uploads');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Setup SQLite
const dbPath = path.join(dataDir, 'expenses.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Database connection error:', err);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS expenses (
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
        )`);
    }
});

// Setup Multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Helper: Convert local file to base64
function fileToBase64(filePath) {
    const fileData = fs.readFileSync(filePath);
    return Buffer.from(fileData).toString('base64');
}

// API: Upload Image & Call OpenRouter
app.post('/api/upload', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

        const filePath = req.file.path;
        const mimeType = req.file.mimetype;
        const base64Image = fileToBase64(filePath);
        const apiKey = process.env.OPENROUTER_API_KEY;

        if (!apiKey) {
            return res.status(500).json({ error: 'OPENROUTER_API_KEY is not set' });
        }

        // Call OpenRouter
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'google/gemini-2.5-flash', // Fast and cost-effective vision model
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: 'system',
                        content: `You are an expense receipt analyzer. Extract information from the receipt image. 
                        Return ONLY a valid JSON object with these keys:
                        - date (string, YYYY-MM-DD format)
                        - amount (number)
                        - currency (string, e.g. HKD)
                        - merchant (string, shop name)
                        - description (string, what was bought)
                        - category (string, choose from: Groceries, Dining, Transport, Utilities, Shopping, Other)`
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Extract data from this receipt.' },
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                        ]
                    }
                ]
            })
        });

        const data = await response.json();

        if (!data.choices || data.choices.length === 0) {
            throw new Error('Invalid response from AI');
        }

        const content = data.choices[0].message.content;
        let parsedData;
        try {
            parsedData = JSON.parse(content);
        } catch (e) {
            parsedData = {};
        }

        res.json({
            image_path: `/uploads/${req.file.filename}`,
            extracted: parsedData
        });

    } catch (error) {
        console.error('Error processing receipt:', error);
        res.status(500).json({ error: 'Failed to process receipt', details: error.message });
    }
});

// API: Save Expense
app.post('/api/save', (req, res) => {
    const { date, amount, currency, merchant, description, category, note, image_path } = req.body;

    const stmt = db.prepare(`INSERT INTO expenses 
        (expense_date, amount, currency, merchant, description, category, note, image_path) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    stmt.run([date, amount, currency, merchant, description, category, note, image_path], function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, id: this.lastID });
    });
    stmt.finalize();
});

// API: Get Stats & Recent
app.get('/api/stats', (req, res) => {
    db.all(`SELECT * FROM expenses ORDER BY expense_date DESC LIMIT 10`, [], (err, recent) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all(`SELECT category, SUM(amount) as total, currency FROM expenses 
                WHERE strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now') 
                GROUP BY category, currency`, [], (err, stats) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ recent, monthlyStats: stats });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
