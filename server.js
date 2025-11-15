// server.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const USERNAME = process.env.USERNAME || 'admin';
const PASSWORD = process.env.PASSWORD || '12345';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const validHash = crypto.createHash('sha256').update(PASSWORD).digest('hex');

let voterData = [];
let ready = false;

// ---------- MIDDLEWARE ----------
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com', "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter for login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later.' },
});

// ---------- AUTH MIDDLEWARE ----------
function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ---------- DATA LOADING (XLSX ONLY) ----------
async function loadData() {
  console.log('Starting data load (XLSX)...');
  const start = Date.now();
  voterData = [];
  ready = false;

  const seen = new Set(); // dedupe
  const addVoter = (v) => {
    const key = `${v.serial}|${v.englishName}`.toLowerCase().trim();
    if (!seen.has(key) && v.englishName.trim()) {
      seen.add(key);
      voterData.push(v);
    }
  };

  const timeout = setTimeout(() => {
    console.warn('Data load timeout – forcing ready');
    ready = true;
  }, 15000); // generous for large Excel files

  try {
    // ----- LOAD XLSX -----
    const xlsxPath = path.join(__dirname, 'ourdata.xlsx');
    if (!fs.existsSync(xlsxPath)) throw new Error('ourdata.xlsx not found');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('No worksheet in XLSX');

    // ---- Build column map (case‑insensitive, trim, normalize spaces) ----
    const headerRow = sheet.getRow(1).values;
    const col = {};
    headerRow.forEach((h, i) => {
      if (h) {
        const norm = h.toString().trim().toLowerCase().replace(/\s+/g, ' ');
        col[norm] = i;
      }
    });

    // Helper to fetch a cell value by any possible header name
    const get = (names, row) => {
      for (const n of names) {
        const idx = col[n.toLowerCase().replace(/\s+/g, ' ')];
        if (idx && row[idx]) return row[idx].toString().trim();
      }
      return '';
    };

    // ---- Process rows ----
    sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return; // skip header

      const v = row.values;

      const voter = {
        // Serial number
        serial: get(['अ.नं.', 'अ नं', 'sr no', 'serial', 'अ.क्र.', 'अ क्र'], v) || rowNum.toString(),

        // Names
        marathiName: get(['नाव (मराठी)', 'नाव मराठी', 'marathi name'], v),
        englishName: get(['english name', 'englishname'], v),
    

        // Polling booth
        polling: get(['मतदान केंद्र', 'polling booth', 'polling station'], v),

        // NEW fields – exact column names you gave
        voteFor: get(['उमेदवार', 'candidate', 'vote for', 'vote_for'], v),   // उमेदवार
        vote:    get(['निशाणी', 'symbol', 'निशाणी - कमळ', 'vote symbol'], v), // निशाणी
        message: get(['message', 'आवाहन', 'msg'], v),
      };

      addVoter(voter);
    });

    clearTimeout(timeout);
    ready = true;
    console.log(`XLSX loaded: ${voterData.length} unique records in ${Date.now() - start}ms`);
  } catch (err) {
    clearTimeout(timeout);
    console.error('Load error:', err.message);
    ready = true;
  }
}

// ---------- PRELOAD ----------
console.log('Preloading data...');
loadData().catch(err => {
  console.error('Preload failed:', err);
  ready = true;
});

app.get('/debug-data', (req, res) => res.json(voterData.slice(0, 2)));

// Dev: reload on file change
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const xlsxPath = path.join(__dirname, 'ourdata.xlsx');
  if (fs.existsSync(xlsxPath)) {
    fs.watchFile(xlsxPath, (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        console.log('ourdata.xlsx changed → reloading...');
        loadData().catch(console.error);
      }
    });
  }
}

// ---------- ROUTES ----------
app.post('/login', loginLimiter, (req, res) => {
  const { user_id, password } = req.body || {};
  if (!user_id || !password) return res.status(400).json({ error: 'Username and password required' });

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  if (user_id === USERNAME && hash === validHash) {
    const token = jwt.sign({ user: USERNAME }, JWT_SECRET, { expiresIn: '2h' });
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/search', authenticateToken, (req, res) => {
  if (!ready) return res.status(503).json({ error: 'Data loading…' });

  const q = (req.query.q || '').toString().toLowerCase().trim().substring(0, 50);
  if (q.length < 2) return res.json([]);

  const results = voterData
    .filter(v => {
      const hay = `${v.englishName} ${v.surname} ${v.first} ${v.middle} ${v.marathiName}`.toLowerCase();
      return hay.includes(q);
    })
    //.slice(0, 20)
    .map(v => ({
      serial:      v.serial,
      marathiName: v.marathiName,
      englishName: v.englishName,
      surname:     v.surname,
      first:       v.first,
      middle:      v.middle,
      polling:     v.polling,
      voteFor:     v.voteFor,
      vote:        v.vote,
      message:     v.message,
    }));

  res.json(results);
});

app.post('/admin/reload', authenticateToken, async (req, res) => {
  console.log('Manual reload requested');
  await loadData();
  res.json({ success: true, message: `Reloaded: ${voterData.length} records` });
});

app.get('/debug', (req, res) => {
  res.json({
    ready,
    totalRecords: voterData.length,
    xlsxExists: fs.existsSync(path.join(__dirname, 'ourdata.xlsx')),
    sampleNames: voterData.slice(0, 3).map(v => v.englishName || v.marathiName),
    files: fs.readdirSync(__dirname).filter(f => f.endsWith('.xlsx')),
  });
});

app.get('*', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'voter-portal.html');
  fs.existsSync(htmlPath)
    ? res.sendFile(htmlPath)
    : res.status(404).send('Frontend not found – check public/ folder');
});

// ---------- ERROR & SHUTDOWN ----------
app.use((err, _req, res, _next) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({ error: 'Server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Data ready: ${ready ? 'Yes' : 'Loading...'} | Records: ${voterData.length}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('unhandledRejection', r => console.error('Unhandled Rejection:', r));
process.on('uncaughtException', e => { console.error('Crash:', e); process.exit(1); });