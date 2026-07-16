const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded files statically
app.use('/uploads', express.static(uploadsDir));

// Serve frontend static files
app.use(express.static(__dirname));

// Multer storage configuration for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Initialize SQLite database
const dbPath = path.join(__dirname, 'bpkascan.db');
const db = new sqlite3.Database(dbPath);

// Wrap SQLite methods in Promises
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Database Initialization Schema
async function initDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      documentNumber TEXT,
      title TEXT,
      fileName TEXT,
      fileType TEXT,
      fileSize INTEGER,
      fileNameOnDisk TEXT,
      image TEXT,
      pages TEXT,
      source TEXT,
      scannerName TEXT,
      resolution TEXT,
      colorMode TEXT,
      paperSize TEXT,
      category TEXT,
      status TEXT,
      tags TEXT,
      description TEXT,
      uploadedBy TEXT,
      extractedText TEXT,
      createdAt INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt INTEGER,
      userName TEXT,
      userId INTEGER,
      role TEXT,
      action TEXT,
      target TEXT,
      details TEXT,
      status TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS scanners (
      id TEXT PRIMARY KEY,
      name TEXT,
      deviceId TEXT,
      type TEXT,
      isOnline INTEGER,
      lastSeen INTEGER
    )
  `);

  console.log('Database tables initialized.');
}

initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
});

// Helper to format document row for JSON response
function mapDocument(row) {
  if (!row) return null;
  return {
    ...row,
    pages: row.pages ? JSON.parse(row.pages) : [],
    tags: row.tags ? JSON.parse(row.tags) : [],
    hasFile: !!row.fileNameOnDisk
  };
}

// Serve homepage specifically mapping to the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'BPKAScan — Sistem Manajemen Dokumen Scan.html'));
});

// ==========================================
// DOCUMENTS API
// ==========================================

// Get all documents
app.get('/api/documents', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM documents ORDER BY createdAt DESC');
    res.json(rows.map(mapDocument));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create or update a document
app.post('/api/documents', upload.single('file'), async (req, res) => {
  try {
    const metadata = JSON.parse(req.body.metadata);
    const id = metadata.id;

    if (!id) {
      return res.status(400).json({ error: 'Document ID is required' });
    }

    // Check if document already exists
    const existing = await dbGet('SELECT fileNameOnDisk FROM documents WHERE id = ?', [id]);
    let fileNameOnDisk = existing ? existing.fileNameOnDisk : null;

    if (req.file) {
      // If there was an old file, we could delete it, but let's keep it simple for now or overwrite
      if (fileNameOnDisk && fileNameOnDisk !== req.file.filename) {
        const oldPath = path.join(uploadsDir, fileNameOnDisk);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
      fileNameOnDisk = req.file.filename;
    }

    const pagesStr = JSON.stringify(metadata.pages || []);
    const tagsStr = JSON.stringify(metadata.tags || []);

    await dbRun(`
      INSERT OR REPLACE INTO documents (
        id, documentNumber, title, fileName, fileType, fileSize, fileNameOnDisk,
        image, pages, source, scannerName, resolution, colorMode, paperSize,
        category, status, tags, description, uploadedBy, extractedText, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      metadata.documentNumber || '',
      metadata.title || 'Untitled Document',
      metadata.fileName || '',
      metadata.fileType || 'application/pdf',
      req.file ? req.file.size : (metadata.fileSize || 0),
      fileNameOnDisk,
      metadata.image || '',
      pagesStr,
      metadata.source || 'upload',
      metadata.scannerName || '',
      metadata.resolution || '',
      metadata.colorMode || '',
      metadata.paperSize || '',
      metadata.category || 'Lainnya',
      metadata.status || 'Tersimpan',
      tagsStr,
      metadata.description || '',
      metadata.uploadedBy || 'Sistem',
      metadata.extractedText || '',
      metadata.createdAt || Date.now()
    ]);

    const savedRow = await dbGet('SELECT * FROM documents WHERE id = ?', [id]);
    res.json(mapDocument(savedRow));
  } catch (err) {
    console.error('Error saving document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete all documents
app.delete('/api/documents', async (req, res) => {
  try {
    const docs = await dbAll('SELECT fileNameOnDisk FROM documents');
    for (const doc of docs) {
      if (doc.fileNameOnDisk) {
        const filePath = path.join(uploadsDir, doc.fileNameOnDisk);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }
    await dbRun('DELETE FROM documents');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a document
app.delete('/api/documents/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await dbGet('SELECT fileNameOnDisk FROM documents WHERE id = ?', [id]);
    
    if (doc && doc.fileNameOnDisk) {
      const filePath = path.join(uploadsDir, doc.fileNameOnDisk);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await dbRun('DELETE FROM documents WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Serve / download the PDF file of a document
app.get('/api/documents/:id/file', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await dbGet('SELECT fileNameOnDisk, fileName FROM documents WHERE id = ?', [id]);
    
    if (!doc || !doc.fileNameOnDisk) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(uploadsDir, doc.fileNameOnDisk);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found on disk');
    }

    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ==========================================
// LOGS API
// ==========================================

// Get all logs
app.get('/api/logs', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM logs ORDER BY createdAt DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log an activity
app.post('/api/logs', async (req, res) => {
  try {
    const log = req.body;
    const result = await dbRun(`
      INSERT INTO logs (createdAt, userName, userId, role, action, target, details, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      log.createdAt || Date.now(),
      log.userName || 'Sistem',
      log.userId || 0,
      log.role || 'Sistem',
      log.action || '',
      log.target || '',
      log.details || '',
      log.status || 'Sukses'
    ]);
    const savedLog = await dbGet('SELECT * FROM logs WHERE id = ?', [result.lastID]);
    res.json(savedLog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete logs (with optional action filter)
app.delete('/api/logs', async (req, res) => {
  try {
    const action = req.query.action;
    if (action && action !== 'all') {
      await dbRun('DELETE FROM logs WHERE action = ?', [action]);
    } else {
      await dbRun('DELETE FROM logs');
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SCANNERS API
// ==========================================

// Get all scanners
app.get('/api/scanners', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM scanners');
    // Map isOnline back to boolean
    res.json(rows.map(r => ({ ...r, isOnline: !!r.isOnline })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create or update a scanner
app.post('/api/scanners', async (req, res) => {
  try {
    const scanner = req.body;
    await dbRun(`
      INSERT OR REPLACE INTO scanners (id, name, deviceId, type, isOnline, lastSeen)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      scanner.id,
      scanner.name,
      scanner.deviceId,
      scanner.type,
      scanner.isOnline ? 1 : 0,
      scanner.lastSeen || Date.now()
    ]);
    res.json(scanner);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a scanner
app.delete('/api/scanners/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM scanners WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`BPKAScan Server is running at http://localhost:${PORT}`);
});
