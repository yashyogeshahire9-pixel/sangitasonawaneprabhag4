// server.js (LOGIN-FREE VERSION)
import express from 'express';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import helmet from 'helmet';
import morgan from 'morgan';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

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

// ---------- DATA ----------
let voterData = [];
let ready = false;

// ---------- LOAD XLSX ----------
async function loadData() {
  console.log('Loading voter data from ourdata.xlsx...');
  const start = Date.now();
  voterData = [];
  ready = false;

  const seen = new Set();

  try {
    const xlsxPath = path.join(__dirname, 'ourdata.xlsx');
    if (!fs.existsSync(xlsxPath)) {
      throw new Error('ourdata.xlsx file not found in project root!');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('No worksheet found in Excel file');

    // Build flexible column mapping
    const headerRow = sheet.getRow(1).values;
    const col = {};
    headerRow.forEach((h, i) => {
      if (h) {
        const key = h.toString().trim().toLowerCase().replace(/\s+/g, ' ');
        col[key] = i;
      }
    });

    const get = (names, row) => {
      for (const name of names) {
        const idx = col[name.toLowerCase().replace(/\s+/g, ' ')];
        if (idx && row[idx]) return row[idx].toString().trim();
      }
      return '';
    };

    sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return; // skip header

      const v = row.values;

      const voter = {
        serial:      get(['अ.नं.', 'अ नं', 'sr no', 'serial', 'अ.क्र.', 'अ क्र'], v) || rowNum.toString(),
        marathiName: get(['नाव (मराठी)', 'नाव मराठी', 'marathi name'], v),
        englishName: get(['english name', 'englishname'], v),
        polling:     get(['मतदान केंद्र', 'polling booth', 'polling station'], v),
        voteFor:     get(['उमेदवार', 'candidate', 'vote for'], v),
        vote:        get(['निशाणी', 'symbol'], v),
        message:     get(['आवाहन', 'message', 'msg'], v),
      };

      // Deduplicate
      const key = `${voter.serial}|${voter.englishName}`.toLowerCase();
      if (voter.englishName && !seen.has(key)) {
        seen.add(key);
        voterData.push(voter);
      }
    });

    ready = true;
    console.log(`Loaded ${voterData.length} voters in ${(Date.now() - start)}ms`);
  } catch (err) {
    console.error('Error loading data:', err.message);
    ready = true; // still allow server to start
  }
}

// Load data on startup
loadData();

// Optional: Auto-reload when Excel file changes (dev only)
if (process.env.NODE_ENV !== 'production') {
  const xlsxPath = path.join(__dirname, 'ourdata.xlsx');
  if (fs.existsSync(xlsxPath)) {
    fs.watchFile(xlsxPath, (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        console.log('ourdata.xlsx changed → Reloading...');
        loadData();
      }
    });
  }
}

// ---------- PUBLIC SEARCH ROUTE (NO AUTH REQUIRED) ----------
app.get('/search', (req, res) => {
  if (!ready) {
    return res.status(503).json({ error: 'Data is still loading, please wait...' });
  }

  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (q.length < 2) {
    return res.json([]);
  }

  const results = voterData
    .filter(v => {
      const searchIn = `${v.englishName} ${v.marathiName} ${v.polling}`.toLowerCase();
      return searchIn.includes(q);
    })
    //.slice(0, 20) // limit results
    .map(v => ({
      serial: v.serial,
      marathiName: v.marathiName,
      englishName: v.englishName,
      polling: v.polling,
      voteFor: v.voteFor,
      vote: v.vote,
      message: v.message,
    }));

  res.json(results);
});

// Debug endpoint (optional – remove in production if you want)
app.get('/debug', (req, res) => {
  res.json({
    ready,
    totalVoters: voterData.length,
    sample: voterData.slice(0, 3).map(v => ({ english: v.englishName, marathi: v.marathiName })),
  });
});

// Serve frontend
app.get('*', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'voter-portal.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('voter-portal.html not found in /public folder');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Public search: http://localhost:${PORT}/search?q=ram`);
  console.log(`Total voters loaded: ${voterData.length} (ready: ${ready})`);
});