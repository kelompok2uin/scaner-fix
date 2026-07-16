/**
 * BPKAScan v2.0 — Aplikasi Manajemen Dokumen Scan
 * Fitur: Login/Auth, Upload PDF, Integrasi Scanner, OCR, Log Aktivitas, Metadata Lengkap
 */

'use strict';

// ============================================================
// SECTION 1: DATABASE (SQLite via Express API Backend)
// ============================================================

// In-memory state
let db = { documents: [], logs: [], scanners: [] };

async function loadDatabase() {
  try {
    const [docsRes, logsRes, scannersRes] = await Promise.all([
      fetch('/api/documents'),
      fetch('/api/logs'),
      fetch('/api/scanners')
    ]);
    
    if (docsRes.ok) {
      const docs = await docsRes.json();
      db.documents = docs.map(normalizeDocument).sort((a, b) => b.createdAt - a.createdAt);
    }
    if (logsRes.ok) {
      const logs = await logsRes.json();
      db.logs = logs.sort((a, b) => b.createdAt - a.createdAt);
    }
    if (scannersRes.ok) {
      db.scanners = await scannersRes.json();
    }
  } catch (e) {
    console.error('Database load error:', e);
    db = { documents: [], logs: [], scanners: [] };
  }
}

function normalizeDocument(doc) {
  const pages = Array.isArray(doc.pages) && doc.pages.length ? doc.pages : (doc.image ? [doc.image] : []);
  return {
    ...doc,
    pages,
    image: pages[0] || null,
    createdAt:      doc.createdAt || Date.now(),
    fileType:       doc.fileType  || 'application/pdf',
    fileName:       doc.fileName  || `${doc.title || 'dokumen'}.pdf`,
    documentNumber: doc.documentNumber || generateDocNumber(),
    uploadedBy:     doc.uploadedBy || currentUser?.name || 'Sistem',
    status:         doc.status || 'Tersimpan',
    source:         doc.source || 'upload',
    fileSize:       doc.fileSize || 0,
  };
}

async function saveDocumentToDB(doc) {
  const formData = new FormData();
  const { fileBlob, ...metadata } = doc;
  
  formData.append('metadata', JSON.stringify(metadata));
  if (fileBlob) {
    formData.append('file', fileBlob, doc.fileName || 'document.pdf');
  }

  const response = await fetch('/api/documents', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Gagal menyimpan ke server');
  }

  const savedDoc = await response.json();
  const idx = db.documents.findIndex(d => d.id === savedDoc.id);
  if (idx !== -1) {
    db.documents[idx] = normalizeDocument(savedDoc);
  } else {
    db.documents.unshift(normalizeDocument(savedDoc));
  }
  db.documents.sort((a, b) => b.createdAt - a.createdAt);
}

async function deleteDocumentFromDB(id) {
  const response = await fetch(`/api/documents/${id}`, {
    method: 'DELETE'
  });
  if (!response.ok) {
    throw new Error('Gagal menghapus dokumen dari server');
  }
  db.documents = db.documents.filter(d => d.id !== id);
}

async function saveLogToDB(logEntry) {
  try {
    const response = await fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logEntry)
    });
    if (response.ok) {
      const savedLog = await response.json();
      db.logs.unshift(savedLog);
    }
  } catch (e) {
    console.error('Log save error:', e);
  }
}

// ============================================================
// SECTION 2: AUTH SYSTEM
// ============================================================

const USERS = [
  { id: 1, name: 'Administrator', username: 'admin',    password: 'admin123',  role: 'Admin',    email: 'admin@bpkascan.id' },
  { id: 2, name: 'Operator Scan', username: 'operator', password: 'scan123',   role: 'Operator', email: 'operator@bpkascan.id' },
  { id: 3, name: 'Viewer',        username: 'viewer',   password: 'view123',   role: 'Viewer',   email: 'viewer@bpkascan.id' },
];

let currentUser = null;

function getStoredSession() {
  try {
    const sess = sessionStorage.getItem('scanvault_session');
    return sess ? JSON.parse(sess) : null;
  } catch { return null; }
}

function saveSession(user) {
  sessionStorage.setItem('scanvault_session', JSON.stringify({ ...user, loginTime: Date.now() }));
}

function clearSession() {
  sessionStorage.removeItem('scanvault_session');
}

function login(identifier, password) {
  const user = USERS.find(u =>
    (u.username === identifier || u.email === identifier) && u.password === password
  );
  if (!user) return null;
  const { password: _, ...safeUser } = user;
  return safeUser;
}

function initAuth() {
  currentUser = USERS[0];
  showApp();
}

function showLoginScreen() {
  // Removed
}

function showApp() {
  const appContainer = document.getElementById('app-container');
  if (appContainer) appContainer.classList.remove('hidden');
  updateUserUI();
  initApp();
}

function updateUserUI() {
  if (!currentUser) return;
  const sidebarUser = document.getElementById('sidebar-username');
  const sidebarRole = document.getElementById('sidebar-role');
  if (sidebarUser) sidebarUser.textContent = currentUser.name;
  if (sidebarRole) sidebarRole.textContent = currentUser.role;

  // Pre-fill user fields in forms
  const userFields = ['doc-user', 'upload-doc-user'];
  userFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = currentUser.name;
  });
}

function bindElement(id, event, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, handler);
  }
}

// ============================================================
// SECTION 3: APP STATE
// ============================================================

let currentTab = 'dashboard';
let inputMode = 'hw-scan';
let webcamStream = null;
let loadedImage = null;
let currentRotation = 0;
let activeFilter = 'original';
let currentBrightness = 0;
let currentContrast = 0;
let pendingPages = [];
let pendingPdf = null;
let activeDocumentId = null;
let pdfUploadQueue = [];
let viewMode = 'grid';
let activeLogFilter = 'all';
let confirmCallback = null;

// ============================================================
// SECTION 4: HELPERS
// ============================================================

function generateDocNumber() {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  const rand = Math.random().toString(36).substr(2,6).toUpperCase();
  return `DOC-${ymd}-${rand}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function formatDateShort(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function getSourceLabel(source) {
  const map = { scan: 'Scan', upload: 'Upload', camera: 'Kamera' };
  return map[source] || source;
}

function getSourceBadgeClass(source) {
  const map = { scan: 'badge-orange', upload: 'badge-blue', camera: 'badge-purple' };
  return map[source] || 'badge-blue';
}

function getStatusBadgeClass(status) {
  const map = { 'Tersimpan': 'badge-green', 'Diproses': 'badge-blue', 'Diarsipkan': 'badge-purple' };
  return map[status] || 'badge-green';
}

function pdfPlaceholderSVG(name = 'PDF') {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260"><rect width="100%" height="100%" fill="#1b2336"/><rect x="40" y="30" width="120" height="200" rx="8" fill="#243050" stroke="#10b981" stroke-width="1.5"/><text x="100" y="145" text-anchor="middle" font-size="32" font-weight="bold" fill="#10b981" font-family="sans-serif">PDF</text><text x="100" y="175" text-anchor="middle" font-size="11" fill="#6b7280" font-family="sans-serif">${name.slice(0,20)}</text></svg>`)}`;
}

// ============================================================
// SECTION 5: TOAST NOTIFICATIONS
// ============================================================

function showToast(message, type = 'info', duration = 3500) {
  const iconMap = {
    success: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    warning: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    info:    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${iconMap[type] || iconMap.info}<span>${message}</span>`;
  document.getElementById('toast-container').appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================================
// SECTION 6: CONFIRM DIALOG
// ============================================================

function showConfirm(title, message) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-modal').classList.add('open');
    confirmCallback = resolve;
  });
}

// ============================================================
// SECTION 7: ACTIVITY LOG
// ============================================================

async function logActivity(action, target = '', details = '') {
  const entry = {
    createdAt: Date.now(),
    userId:    currentUser?.id || 0,
    userName:  currentUser?.name || 'Sistem',
    action,
    target,
    details,
    status:    'Berhasil',
  };
  await saveLogToDB(entry);
  renderLogs();
  updateLogBadge();
}

// ============================================================
// SECTION 8: RENDER FUNCTIONS
// ============================================================

// --- Dashboard ---
function renderDashboard() {
  const total = db.documents.length;
  const scanToday = db.documents.filter(d => {
    const today = new Date(); const docDate = new Date(d.createdAt);
    return d.source === 'scan' && docDate.toDateString() === today.toDateString();
  }).length;
  const uploadCount = db.documents.filter(d => d.source === 'upload').length;
  const totalBytes = db.documents.reduce((s, d) => s + (d.fileSize || 0), 0);
  const maxBytes = 500 * 1024 * 1024; // 500 MB max display
  const pct = Math.min(100, (totalBytes / maxBytes) * 100).toFixed(1);

  document.getElementById('stat-total-docs').textContent = total;
  document.getElementById('stat-scan-today').textContent = scanToday;
  document.getElementById('stat-upload-count').textContent = uploadCount;
  document.getElementById('stat-storage-bytes-val').textContent = formatBytes(totalBytes);
  document.getElementById('storage-progress').style.width = `${pct}%`;
  document.getElementById('stat-storage-percent').textContent = `${pct}% dari 500 MB`;

  const recentAdd = total > 0
    ? `+${total} dokumen tersimpan`
    : 'Belum ada dokumen baru';
  document.getElementById('stat-recent-add').textContent = recentAdd;

  // Recent docs table
  const tbody = document.getElementById('dashboard-recent-table-body');
  const recent = db.documents.slice(0, 5);
  if (recent.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7" class="text-center text-muted">Belum ada dokumen. Silakan upload atau scan dokumen pertama Anda!</td></tr>`;
  } else {
    tbody.innerHTML = recent.map(doc => `
      <tr>
        <td><code style="font-size:0.8rem;">${doc.documentNumber}</code></td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${doc.title || doc.fileName}</td>
        <td><span class="badge ${getSourceBadgeClass(doc.source)}">${getSourceLabel(doc.source)}</span></td>
        <td>${formatDateShort(doc.createdAt)}</td>
        <td>${doc.uploadedBy || '-'}</td>
        <td><span class="badge ${getStatusBadgeClass(doc.status)}">${doc.status}</span></td>
        <td>
          <div class="action-btns">
            <button class="action-btn" onclick="openDetailModal('${doc.id}')" title="Lihat"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button class="action-btn" onclick="downloadDocument('${doc.id}')" title="Unduh"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
            <button class="action-btn danger" onclick="deleteDocument('${doc.id}')" title="Hapus"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg></button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  // Scanner list
  renderDashboardScanners();
  lucide.createIcons();
}

function renderDashboardScanners() {
  const container = document.getElementById('dashboard-scanner-list');
  if (!db.scanners || db.scanners.length === 0) {
    container.innerHTML = '<div class="scanner-item-empty text-muted text-sm">Tidak ada scanner terdaftar. Tambahkan di Pengaturan.</div>';
    return;
  }
  container.innerHTML = db.scanners.map(s => `
    <div class="scanner-list-item">
      <span>${s.name}</span>
      <div class="scanner-status-pill">
        <span class="dot ${s.isOnline ? 'online' : 'offline'}"></span>
        <span>${s.isOnline ? 'Online' : 'Offline'}</span>
      </div>
    </div>
  `).join('');
}

// --- Library ---
function renderLibrary(searchQuery = '', sourceFilter = 'all', statusFilter = 'all', sortBy = 'newest') {
  let docs = [...db.documents];

  // Filter
  if (sourceFilter !== 'all') docs = docs.filter(d => d.source === sourceFilter);
  if (statusFilter !== 'all') docs = docs.filter(d => d.status === statusFilter);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    docs = docs.filter(d =>
      (d.title || '').toLowerCase().includes(q) ||
      (d.documentNumber || '').toLowerCase().includes(q) ||
      (d.fileName || '').toLowerCase().includes(q) ||
      (d.uploadedBy || '').toLowerCase().includes(q) ||
      (d.extractedText || '').toLowerCase().includes(q) ||
      (d.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  // Sort
  if (sortBy === 'newest')   docs.sort((a, b) => b.createdAt - a.createdAt);
  if (sortBy === 'oldest')   docs.sort((a, b) => a.createdAt - b.createdAt);
  if (sortBy === 'name_asc') docs.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  if (sortBy === 'size_desc') docs.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0));

  const container = document.getElementById('documents-container');

  if (docs.length === 0) {
    container.innerHTML = `
      <div class="empty-state-container">
        <svg xmlns="http://www.w3.org/2000/svg" class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 17.25a6.25 6.25 0 110-12.5 6.25 6.25 0 010 12.5z"/><path d="M16 16l4.5 4.5"/></svg>
        <h3>Tidak Ada Dokumen</h3>
        <p class="text-muted">${searchQuery ? 'Tidak ada dokumen yang cocok dengan pencarian Anda.' : 'Belum ada dokumen. Upload PDF atau scan dokumen Anda.'}</p>
        <button class="btn btn-primary mt-4" onclick="switchTab('upload')">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Upload Dokumen Baru
        </button>
      </div>`;
    return;
  }

  if (viewMode === 'grid') {
    container.className = 'documents-display grid-view';
    container.innerHTML = docs.map(doc => createDocCard(doc)).join('');
  } else {
    container.className = 'documents-display list-view';
    container.innerHTML = docs.map(doc => createDocListItem(doc)).join('');
  }
  lucide.createIcons();
}

function createDocCard(doc) {
  const thumb = doc.fileType === 'application/pdf' && !doc.image
    ? `<div class="pdf-icon-placeholder"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>PDF</span></div>`
    : `<img src="${doc.image || pdfPlaceholderSVG(doc.fileName)}" alt="${doc.title}" loading="lazy">`;

  return `
    <div class="doc-card" onclick="openDetailModal('${doc.id}')">
      <div class="doc-card-thumb">
        ${thumb}
        <div class="doc-card-source-badge">
          <span class="badge ${getSourceBadgeClass(doc.source)}">${getSourceLabel(doc.source)}</span>
        </div>
      </div>
      <div class="doc-card-info">
        <div class="doc-card-name">${doc.title || doc.fileName}</div>
        <div class="doc-card-meta">
          <span>${formatDateShort(doc.createdAt)}</span>
          <span>${formatBytes(doc.fileSize)}</span>
        </div>
      </div>
    </div>`;
}

function createDocListItem(doc) {
  return `
    <div class="doc-list-item" onclick="openDetailModal('${doc.id}')">
      <div class="doc-list-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="doc-list-info">
        <div class="doc-list-name">${doc.title || doc.fileName}</div>
        <div class="doc-list-meta">${doc.documentNumber} · ${formatBytes(doc.fileSize)} · ${doc.uploadedBy} · ${formatDateShort(doc.createdAt)}</div>
      </div>
      <span class="badge ${getSourceBadgeClass(doc.source)}">${getSourceLabel(doc.source)}</span>
      <span class="badge ${getStatusBadgeClass(doc.status)}">${doc.status}</span>
      <div class="doc-list-actions">
        <button class="action-btn" onclick="event.stopPropagation();downloadDocument('${doc.id}')" title="Unduh">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="action-btn danger" onclick="event.stopPropagation();deleteDocument('${doc.id}')" title="Hapus">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>
        </button>
      </div>
    </div>`;
}

// --- Library Badge ---
function updateLibBadge() {
  document.getElementById('lib-badge').textContent = db.documents.length;
}

// --- Logs ---
function renderLogs(filterAction = 'all') {
  const tbody = document.getElementById('logs-table-body');
  let logs = [...db.logs];
  if (filterAction !== 'all') logs = logs.filter(l => l.action === filterAction);

  if (logs.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7" class="text-center text-muted">Belum ada aktivitas yang dicatat.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map((log, i) => `
    <tr>
      <td class="text-muted text-xs">${i + 1}</td>
      <td class="text-xs">${formatDate(log.createdAt)}</td>
      <td><strong>${log.userName || '-'}</strong></td>
      <td><span class="log-action-badge log-badge-${log.action}">${log.action}</span></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${log.target}">${log.target || '-'}</td>
      <td class="text-muted text-xs">${log.details || '-'}</td>
      <td><span class="badge badge-green">${log.status || 'Berhasil'}</span></td>
    </tr>
  `).join('');
}

function updateLogBadge() {
  document.getElementById('log-badge').textContent = db.logs.length;
}

// --- Settings: Scanners ---
function renderScannerConfig() {
  const container = document.getElementById('scanner-config-list');
  if (!db.scanners || db.scanners.length === 0) {
    container.innerHTML = '<div class="scanner-config-item-empty text-muted text-sm">Belum ada scanner terdaftar.</div>';
    return;
  }
  container.innerHTML = db.scanners.map(s => `
    <div class="scanner-config-item">
      <div style="flex:1;">
        <div style="font-size:0.875rem;font-weight:600;">${s.name}</div>
        <div class="text-muted text-xs">${s.type} · ${s.deviceId}</div>
      </div>
      <span class="scanner-status-pill">
        <span class="dot ${s.isOnline ? 'online' : 'offline'}"></span>
        ${s.isOnline ? 'Online' : 'Offline'}
      </span>
      <button class="action-btn danger" onclick="removeScanner('${s.id}')" title="Hapus scanner">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
      </button>
    </div>
  `).join('');
}

// --- Settings: User Accounts ---
function renderUserAccounts() {
  const container = document.getElementById('user-accounts-list');
  container.innerHTML = USERS.map(u => `
    <div class="user-account-item">
      <div class="user-account-avatar">${u.name.charAt(0)}</div>
      <div class="user-account-info">
        <div class="user-account-name">${u.name}</div>
        <div class="user-account-role">${u.role} · ${u.email}</div>
      </div>
      ${u.id === currentUser?.id ? '<span class="badge badge-green">Login Aktif</span>' : ''}
    </div>
  `).join('');
}

// --- Scanner Select Dropdown ---
function renderScannerSelect() {
  const sel = document.getElementById('scanner-select');
  sel.innerHTML = '';
  if (!db.scanners || db.scanners.length === 0) {
    sel.innerHTML = '<option value="">-- Tidak ada scanner terdaftar --</option>';
    document.getElementById('btn-start-scan').disabled = true;
    return;
  }
  sel.innerHTML = '<option value="">-- Pilih Scanner --</option>' +
    db.scanners.map(s =>
      `<option value="${s.id}" ${!s.isOnline ? 'disabled' : ''}>${s.name} ${s.isOnline ? '🟢' : '🔴 (Offline)'}</option>`
    ).join('');

  sel.addEventListener('change', () => {
    const selected = sel.value;
    const scanner = db.scanners.find(s => s.id === selected);
    document.getElementById('btn-start-scan').disabled = !selected || !scanner?.isOnline;
    if (scanner) {
      document.getElementById('scanner-status-label').textContent = scanner.isOnline ? `${scanner.name} — Siap` : `${scanner.name} — Offline`;
      const dot = document.getElementById('scanner-status-dot');
      dot.className = `scanner-status-dot ${scanner.isOnline ? 'online' : 'offline'}`;
    }
  });
}

// ============================================================
// SECTION 9: DOCUMENT DETAIL MODAL
// ============================================================

function openDetailModal(docId) {
  const doc = db.documents.find(d => d.id === docId);
  if (!doc) return;
  activeDocumentId = docId;

  document.getElementById('modal-doc-title').textContent = doc.title || doc.fileName;
  document.getElementById('modal-doc-category').textContent = doc.category || '-';
  document.getElementById('modal-doc-category').className = `badge badge-${getStatusBadgeClass(doc.status).replace('badge-','')}`;
  document.getElementById('modal-doc-source').textContent = getSourceLabel(doc.source);
  document.getElementById('modal-doc-source').className = `badge badge-source ${getSourceBadgeClass(doc.source)}`;
  document.getElementById('modal-doc-number').textContent = doc.documentNumber;
  document.getElementById('modal-doc-filename').textContent = doc.fileName || '-';
  document.getElementById('modal-doc-format-status').textContent = `PDF · ${doc.status}`;
  document.getElementById('modal-doc-scan-date').textContent = formatDate(doc.createdAt);
  document.getElementById('modal-doc-size').textContent = formatBytes(doc.fileSize);
  document.getElementById('modal-doc-uploader').textContent = doc.uploadedBy || '-';
  document.getElementById('modal-doc-page-count').textContent = (doc.pages?.length || 1) + ' halaman';
  document.getElementById('modal-doc-desc').textContent = doc.description || '-';
  document.getElementById('modal-doc-ocr-text').value = doc.extractedText || '';

  // Tags
  const tagsContainer = document.getElementById('modal-doc-tags');
  const tags = Array.isArray(doc.tags) ? doc.tags : [];
  tagsContainer.innerHTML = tags.length ? tags.map(t => `<span class="tag-pill">${t}</span>`).join('') : '-';

  // Preview
  const img = document.getElementById('modal-doc-img');
  const iframe = document.getElementById('modal-doc-pdf');
  const placeholder = document.getElementById('modal-pdf-placeholder');

  if (doc.hasFile) {
    iframe.src = `/api/documents/${doc.id}/file`;
    iframe.className = '';
    img.className = 'hidden';
    placeholder.classList.add('hidden');
  } else if (doc.fileBlob) {
    // Show iframe for PDF
    const url = URL.createObjectURL(doc.fileBlob);
    iframe.src = url;
    iframe.className = '';
    img.className = 'hidden';
    placeholder.classList.add('hidden');
  } else if (doc.image && !doc.image.includes('data:application/pdf')) {
    img.src = doc.image;
    img.className = '';
    iframe.className = 'hidden';
    placeholder.classList.add('hidden');
  } else {
    img.className = 'hidden';
    iframe.className = 'hidden';
    placeholder.classList.remove('hidden');
    document.getElementById('modal-pdf-name').textContent = doc.fileName;
  }

  document.getElementById('doc-detail-modal').classList.add('open');
  lucide.createIcons();
  logActivity('view', doc.documentNumber, `Melihat dokumen: ${doc.title}`);
}

function closeDetailModal() {
  document.getElementById('doc-detail-modal').classList.remove('open');
  // Revoke any blob URLs
  const iframe = document.getElementById('modal-doc-pdf');
  if (iframe.src.startsWith('blob:')) URL.revokeObjectURL(iframe.src);
  iframe.src = '';
  activeDocumentId = null;
}

// ============================================================
// SECTION 10: PDF UPLOAD
// ============================================================

function handlePdfDrop(event) {
  event.preventDefault();
  document.getElementById('pdf-dropzone').classList.remove('drag-over');
  const files = Array.from(event.dataTransfer.files).filter(f => f.type === 'application/pdf');
  if (files.length === 0) { showToast('Hanya file PDF yang diterima!', 'warning'); return; }
  files.forEach(f => addToUploadQueue(f));
}

function addToUploadQueue(file) {
  // Validate
  if (file.type !== 'application/pdf') {
    showToast(`File "${file.name}" bukan PDF dan diabaikan.`, 'warning');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    showToast(`File "${file.name}" melebihi batas 50 MB.`, 'error');
    return;
  }
  if (pdfUploadQueue.length >= 10) {
    showToast('Maksimal 10 file sekaligus.', 'warning');
    return;
  }
  if (pdfUploadQueue.find(q => q.name === file.name)) {
    showToast(`File "${file.name}" sudah ada di antrian.`, 'info');
    return;
  }

  pdfUploadQueue.push(file);
  renderUploadQueue();
  document.getElementById('upload-metadata-form').classList.remove('hidden');

  // Auto-fill title with file name
  const titleField = document.getElementById('upload-doc-title');
  if (!titleField.value) titleField.value = file.name.replace('.pdf', '');
}

function removeFromUploadQueue(index) {
  pdfUploadQueue.splice(index, 1);
  renderUploadQueue();
  if (pdfUploadQueue.length === 0) {
    document.getElementById('upload-metadata-form').classList.add('hidden');
  }
}

function renderUploadQueue() {
  const container = document.getElementById('upload-queue');
  if (pdfUploadQueue.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = pdfUploadQueue.map((file, i) => `
    <div class="upload-queue-item">
      <div class="upload-queue-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="upload-queue-info">
        <div class="upload-queue-name">${file.name}</div>
        <div class="upload-queue-size">${formatBytes(file.size)}</div>
      </div>
      <button class="upload-queue-remove" onclick="removeFromUploadQueue(${i})" title="Hapus dari antrian">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

async function handleUploadSubmit(e) {
  e.preventDefault();

  if (pdfUploadQueue.length === 0) {
    showToast('Pilih file PDF terlebih dahulu.', 'warning');
    return;
  }

  const title    = document.getElementById('upload-doc-title').value.trim();
  const category = document.getElementById('upload-doc-category').value;
  const status   = document.getElementById('upload-doc-status').value;
  const tags     = document.getElementById('upload-doc-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const desc     = document.getElementById('upload-doc-desc').value.trim();
  const docNum   = document.getElementById('upload-doc-number').value.trim() || generateDocNumber();
  const user     = document.getElementById('upload-doc-user').value.trim() || currentUser?.name || 'Sistem';

  if (!title || !category) {
    showToast('Judul dan Kategori wajib diisi!', 'warning');
    return;
  }

  const btn = document.getElementById('upload-save-btn');
  btn.disabled = true;
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;animation:spin 1s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg><span>Mengupload...</span>';

  let uploadedCount = 0;

  for (const file of pdfUploadQueue) {
    try {
      const fileBlob = new Blob([await file.arrayBuffer()], { type: 'application/pdf' });
      const docId    = `doc_${Date.now()}_${Math.random().toString(36).substr(2,8)}`;

      const doc = {
        id:             docId,
        documentNumber: docNum,
        title:          pdfUploadQueue.length > 1 ? `${title} (${file.name})` : title,
        fileName:       file.name,
        fileType:       'application/pdf',
        fileSize:       file.size,
        fileBlob:       fileBlob,
        image:          pdfPlaceholderSVG(file.name),
        pages:          [],
        source:         'upload',
        category,
        status,
        tags,
        description:    desc,
        uploadedBy:     user,
        extractedText:  '',
        createdAt:      Date.now(),
      };

      await saveDocumentToDB(doc);
      await logActivity('upload', doc.documentNumber, `Upload PDF: ${file.name} (${formatBytes(file.size)})`);
      uploadedCount++;

      // Animate new row in dashboard
      setTimeout(() => renderDashboard(), 100);
    } catch (err) {
      showToast(`Gagal menyimpan "${file.name}": ${err.message}`, 'error');
    }
  }

  // Reset
  pdfUploadQueue = [];
  renderUploadQueue();
  document.getElementById('upload-metadata-form').classList.add('hidden');
  document.getElementById('upload-metadata-form').reset();
  document.getElementById('upload-doc-user').value = currentUser?.name || '';
  btn.disabled = false;
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg><span>Upload & Simpan ke Vault</span>';
  lucide.createIcons();

  renderDashboard();
  renderLibrary();
  updateLibBadge();
  renderRecentUploadList();

  showToast(`${uploadedCount} file berhasil diupload ke Vault!`, 'success');
}

function renderRecentUploadList() {
  const container = document.getElementById('recent-upload-list');
  const uploads = db.documents.filter(d => d.source === 'upload').slice(0, 5);
  if (uploads.length === 0) {
    container.innerHTML = '<p class="text-muted text-sm">Belum ada upload.</p>';
    return;
  }
  container.innerHTML = uploads.map(d => `
    <div class="recent-upload-item">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;" title="${d.fileName}">${d.fileName}</span>
      <span class="text-muted">${formatBytes(d.fileSize)}</span>
    </div>
  `).join('');
}

// ============================================================
// SECTION 11: SCANNER (Mesin Fisik Simulation)
// ============================================================

// Simulasi Scanner — Di produksi nyata, ini diganti dengan:
// 1. Local Scanner Agent (Electron/Node.js via WebSocket)
// 2. Dynamic Web TWAIN SDK
// 3. WebUSB API untuk scanner yang mendukung

let scannerSimulationImages = [
  'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?w=800&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=800&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=800&auto=format&fit=crop&q=80',
];

async function startHardwareScan() {
  const scannerId = document.getElementById('scanner-select').value;
  if (!scannerId) { showToast('Pilih scanner terlebih dahulu!', 'warning'); return; }

  const scanner = db.scanners.find(s => s.id === scannerId);
  if (!scanner || !scanner.isOnline) { showToast('Scanner tidak dapat digunakan (offline).', 'error'); return; }

  // === Simulasi Proses Scan ===
  const btn = document.getElementById('btn-start-scan');
  btn.disabled = true;
  document.getElementById('scan-progress-area').classList.remove('hidden');
  document.getElementById('scan-result-preview').classList.add('hidden');

  const statusLabel = document.getElementById('scanner-status-label');
  const statusDot   = document.getElementById('scanner-status-dot');
  const scanIcon    = document.querySelector('.scanner-icon-anim');
  scanIcon.classList.add('scanning');

  const steps = [
    { text: 'Menghubungkan ke scanner...', delay: 800 },
    { text: 'Memanaskan lampu scanner...', delay: 600 },
    { text: 'Memindai dokumen halaman 1...', delay: 1500 },
    { text: 'Mengkonversi hasil scan ke PDF...', delay: 1000 },
    { text: 'Mengupload PDF ke server...', delay: 800 },
    { text: 'Menyimpan ke Vault...', delay: 600 },
  ];

  statusLabel.textContent = 'Memindai...';
  statusDot.className = 'scanner-status-dot scanning';
  document.getElementById('scanner-status-display').style.borderColor = 'var(--color-warning)';

  const progressText = document.getElementById('scan-progress-text');
  let elapsed = 0;

  for (const step of steps) {
    progressText.textContent = step.text;
    await new Promise(r => setTimeout(r, step.delay));
    elapsed += step.delay;
  }

  // Pick a random simulated scan image
  const imgUrl = scannerSimulationImages[Math.floor(Math.random() * scannerSimulationImages.length)];

  // Convert to blob (simulate PDF generation)
  let fileSize = 0;
  let fileBlob = null;

  try {
    // In simulation, we just use the image URL as placeholder
    // In production: scanimage -> img2pdf -> send blob
    fileSize = Math.floor(Math.random() * 2 * 1024 * 1024) + 100 * 1024; // 100KB-2MB simulated
    fileBlob = null; // In real, this would be the actual PDF blob
  } catch (_) {}

  const scannerName = scanner.name;
  const resolution  = document.getElementById('scan-resolution').value;
  const colorMode   = document.getElementById('scan-color').value;
  const paper       = document.getElementById('scan-paper').value;
  const nowStr      = new Date().toLocaleString('id-ID');

  // Save scan result
  const docId = `scan_${Date.now()}_${Math.random().toString(36).substr(2,8)}`;
  const docNum = document.getElementById('doc-number').value.trim() || generateDocNumber();
  const title  = document.getElementById('doc-title').value.trim() || `Scan ${nowStr}`;
  const cat    = document.getElementById('doc-category').value || 'Lainnya';
  const stat   = document.getElementById('doc-status').value || 'Tersimpan';
  const tags   = document.getElementById('doc-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const desc   = document.getElementById('doc-description').value.trim();
  const user   = document.getElementById('doc-user').value.trim() || currentUser?.name || 'Sistem';
  const ocrTxt = document.getElementById('ocr-extracted-text').value.trim();

  const scanDoc = {
    id:             docId,
    documentNumber: docNum,
    title,
    fileName:       `scan_${Date.now()}.pdf`,
    fileType:       'application/pdf',
    fileSize,
    fileBlob,
    image:          imgUrl,
    pages:          [imgUrl],
    source:         'scan',
    scannerName,
    resolution,
    colorMode,
    paperSize:      paper,
    category:       cat,
    status:         stat,
    tags,
    description:    desc,
    uploadedBy:     user,
    extractedText:  ocrTxt,
    createdAt:      Date.now(),
  };

  await saveDocumentToDB(scanDoc);
  await logActivity('scan', docNum, `Scan via ${scannerName} — ${resolution} DPI, ${colorMode}, ${paper}`);

  // Show result
  const resultImg = document.getElementById('scan-result-img');
  resultImg.src = imgUrl;
  document.getElementById('scan-progress-area').classList.add('hidden');
  document.getElementById('scan-result-preview').classList.remove('hidden');
  scanIcon.classList.remove('scanning');
  statusLabel.textContent = `${scanner.name} — Selesai`;
  statusDot.className = 'scanner-status-dot online';
  document.getElementById('scanner-status-display').style.borderColor = '';

  // Update UI
  renderDashboard();
  renderLibrary();
  updateLibBadge();

  btn.disabled = false;
  document.getElementById('doc-metadata-form').reset();
  document.getElementById('doc-user').value = currentUser?.name || '';
  document.getElementById('doc-date').valueAsDate = new Date();

  showToast(`✅ Scan selesai! Dokumen "${title}" berhasil disimpan.`, 'success', 5000);
}

// ============================================================
// SECTION 12: CAMERA + OCR
// ============================================================

// (Camera code carried from original — streamlined)
let loadedImageObj = null;

async function startCamera() {
  const video = document.getElementById('webcam-video');
  const errEl = document.getElementById('camera-error');
  errEl.classList.add('hidden');
  try {
    const constraints = { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } };
    webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = webcamStream;

    // Enumerate cameras
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const sel = document.getElementById('camera-select');
    sel.innerHTML = cameras.map((c, i) => `<option value="${c.deviceId}">${c.label || `Kamera ${i+1}`}</option>`).join('');
  } catch (err) {
    errEl.classList.remove('hidden');
    if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  }
}

function stopCamera() {
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  document.getElementById('webcam-video').srcObject = null;
}

function captureFromWebcam() {
  const video = document.getElementById('webcam-video');
  if (!video.videoWidth) { showToast('Kamera belum siap.', 'warning'); return; }
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  loadScanImage(dataUrl);
  document.getElementById('editor-workzone').classList.remove('hidden');
}

function loadScanImage(src) {
  const img = new Image();
  img.onload = () => {
    loadedImageObj = img;
    loadedImage = src;
    currentRotation = 0;
    activeFilter = 'original';
    currentBrightness = 0;
    currentContrast = 0;
    document.getElementById('contrast-slider').value = 0;
    document.getElementById('brightness-slider').value = 0;
    document.getElementById('contrast-val').textContent = '0';
    document.getElementById('brightness-val').textContent = '0';
    renderCanvas();
    document.getElementById('ocr-extract-btn').disabled = false;
    document.getElementById('save-doc-btn').disabled = false;
    document.getElementById('add-page-btn').disabled = false;
    document.getElementById('ocr-status-badge').textContent = 'Gambar Dimuat';
    document.getElementById('ocr-status-badge').className = 'ocr-status-badge badge-processing';
  };
  img.src = src;
}

function handleScanImageFile(file) {
  if (!file) return;
  
  showToast(`Memproses scan otomatis untuk berkas "${file.name}"...`, 'info', 4000);
  
  const reader = new FileReader();
  reader.onload = function(event) {
    const img = new Image();
    img.onload = async () => {
      // 1. Draw image to editor canvas
      const canvas = document.getElementById('editor-canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      
      const imgData = canvas.toDataURL('image/jpeg', 0.9);
      
      // Update local state
      loadedImageObj = img;
      loadedImage = imgData;
      currentRotation = 0;
      activeFilter = 'original';
      currentBrightness = 0;
      currentContrast = 0;
      
      // 2. Perform background OCR
      showToast('Mengekstrak teks (OCR)...', 'info');
      let ocrText = '';
      try {
        const result = await Tesseract.recognize(imgData, 'ind+eng');
        ocrText = result.data.text.trim();
        showToast('Teks berhasil diekstrak!', 'success');
      } catch (e) {
        console.error('OCR error during autoscan:', e);
      }
      
      // 3. Generate PDF Blob via jsPDF
      showToast('Menyusun PDF...', 'info');
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      pdf.addImage(imgData, 'JPEG', 5, 5, 200, 280);
      const pdfBlob = pdf.output('blob');
      
      // 4. Construct document object
      const docId = `scan_file_${Date.now()}_${Math.random().toString(36).substr(2,8)}`;
      const fileNameWithoutExt = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
      const docNum = generateDocNumber();
      
      const doc = {
        id:             docId,
        documentNumber: docNum,
        title:          `Scan File: ${fileNameWithoutExt}`,
        fileName:       `${fileNameWithoutExt}_scan.pdf`,
        fileType:       'application/pdf',
        fileSize:       pdfBlob.size,
        fileBlob:       pdfBlob,
        image:          imgData,
        pages:          [imgData],
        source:         'scan',
        scannerName:    'File Manager',
        category:       'Lainnya',
        status:         'Tersimpan',
        tags:           ['file-scan', 'auto-upload'],
        description:    `Diunggah otomatis dari berkas gambar: ${file.name}`,
        uploadedBy:     currentUser?.name || 'Sistem',
        extractedText:  ocrText,
        createdAt:      Date.now()
      };
      
      // 5. Save to database
      showToast('Menyimpan ke Vault...', 'info');
      try {
        await saveDocumentToDB(doc);
        await logActivity('scan', docNum, `Scan Otomatis Berkas: ${file.name}`);
        showToast(`✅ Dokumen "${doc.title}" berhasil disimpan!`, 'success');
        
        // 6. Reset scanner workzone state
        loadedImage = null;
        loadedImageObj = null;
        document.getElementById('editor-workzone').classList.add('hidden');
        
        // 7. Go to Perpustakaan!
        switchTab('library');
      } catch (err) {
        showToast('Gagal menyimpan dokumen: ' + err.message, 'error');
      }
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function renderCanvas() {
  if (!loadedImageObj) return;
  const canvas = document.getElementById('editor-canvas');
  const ctx    = canvas.getContext('2d');
  const img    = loadedImageObj;
  const isRotated = currentRotation % 180 !== 0;

  canvas.width  = isRotated ? img.naturalHeight : img.naturalWidth;
  canvas.height = isRotated ? img.naturalWidth  : img.naturalHeight;

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((currentRotation * Math.PI) / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.restore();

  applyImageFilter(ctx, canvas, activeFilter, currentBrightness, currentContrast);
}

function applyImageFilter(ctx, canvas, filter, brightness, contrast) {
  if (filter === 'original' && brightness === 0 && contrast === 0) return;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const b = brightness / 100 * 255;
  const c = contrast / 100;
  const factor = (259 * (c * 255 + 255)) / (255 * (259 - c * 255));

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i+1], bl = data[i+2];
    if (filter === 'grayscale' || filter === 'document' || filter === 'monochrome') {
      const gray = 0.299 * r + 0.587 * g + 0.114 * bl;
      r = g = bl = gray;
    }
    r = factor * (r - 128) + 128 + b;
    g = factor * (g - 128) + 128 + b;
    bl = factor * (bl - 128) + 128 + b;
    if (filter === 'document') { r *= 1.2; g *= 1.1; bl *= 0.9; }
    if (filter === 'monochrome') { const th = (r + g + bl) / 3 > 128 ? 255 : 0; r = g = bl = th; }
    data[i]   = Math.max(0, Math.min(255, r));
    data[i+1] = Math.max(0, Math.min(255, g));
    data[i+2] = Math.max(0, Math.min(255, bl));
  }
  ctx.putImageData(imgData, 0, 0);
}

async function runOCR() {
  if (!loadedImage) { showToast('Tidak ada gambar untuk diproses.', 'warning'); return; }

  document.getElementById('ocr-extract-btn').disabled = true;
  document.getElementById('ocr-status-badge').textContent = 'Memproses OCR...';
  document.getElementById('ocr-status-badge').className = 'ocr-status-badge badge-processing';
  document.getElementById('ocr-progress-area').classList.remove('hidden');

  const progressBar  = document.getElementById('ocr-progress-bar');
  const progressPct  = document.getElementById('ocr-progress-percent');
  const statusText   = document.getElementById('ocr-status-text');

  try {
    const canvas = document.getElementById('editor-canvas');
    const imageData = canvas.toDataURL('image/jpeg', 0.95);

    const result = await Tesseract.recognize(imageData, 'ind+eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          const pct = Math.round((m.progress || 0) * 100);
          progressBar.style.width = pct + '%';
          progressPct.textContent = pct + '%';
          statusText.textContent  = `Mengenali teks... ${pct}%`;
        }
      }
    });

    document.getElementById('ocr-extracted-text').value = result.data.text.trim();
    document.getElementById('ocr-status-badge').textContent = 'OCR Selesai ✓';
    document.getElementById('ocr-status-badge').className = 'ocr-status-badge badge-done';
    showToast('Ekstraksi teks berhasil!', 'success');
  } catch (err) {
    showToast('OCR gagal: ' + err.message, 'error');
    document.getElementById('ocr-status-badge').textContent = 'OCR Error';
    document.getElementById('ocr-status-badge').className = 'ocr-status-badge badge-idle';
  } finally {
    document.getElementById('ocr-extract-btn').disabled = false;
    document.getElementById('ocr-progress-area').classList.add('hidden');
  }
}

async function saveCameraDocument(e) {
  e.preventDefault();
  if (!loadedImage) { showToast('Tidak ada gambar yang siap disimpan.', 'warning'); return; }

  const canvas  = document.getElementById('editor-canvas');
  const imgData = canvas.toDataURL('image/jpeg', 0.9);
  const title   = document.getElementById('doc-title').value.trim();
  const cat     = document.getElementById('doc-category').value;
  const stat    = document.getElementById('doc-status').value || 'Tersimpan';
  const tags    = document.getElementById('doc-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const desc    = document.getElementById('doc-description').value.trim();
  const user    = document.getElementById('doc-user').value.trim() || currentUser?.name || 'Sistem';
  const docNum  = document.getElementById('doc-number').value.trim() || generateDocNumber();
  const ocrTxt  = document.getElementById('ocr-extracted-text').value.trim();

  if (!title || !cat) { showToast('Judul dan Kategori wajib diisi!', 'warning'); return; }

  // Build PDF from captured images via jsPDF
  const { jsPDF } = window.jspdf;
  const pages = pendingPages.length ? [...pendingPages, imgData] : [imgData];
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  pages.forEach((p, i) => {
    if (i > 0) pdf.addPage();
    pdf.addImage(p, 'JPEG', 5, 5, 200, 280);
  });

  const pdfBlob = pdf.output('blob');
  const approxSize = pdfBlob.size;

  const docId = `cam_${Date.now()}_${Math.random().toString(36).substr(2,8)}`;

  const doc = {
    id:             docId,
    documentNumber: docNum,
    title,
    fileName:       `kamera_${Date.now()}.pdf`,
    fileType:       'application/pdf',
    fileSize:       approxSize,
    fileBlob:       pdfBlob,
    image:          pages[0],
    pages,
    source:         'camera',
    category:       cat,
    status:         stat,
    tags,
    description:    desc,
    uploadedBy:     user,
    extractedText:  ocrTxt,
    createdAt:      Date.now(),
  };

  await saveDocumentToDB(doc);
  await logActivity('scan', docNum, `Scan via Kamera — ${pages.length} halaman`);

  // Reset form
  loadedImage = null;
  loadedImageObj = null;
  pendingPages = [];
  document.getElementById('doc-metadata-form').reset();
  document.getElementById('doc-user').value = currentUser?.name || '';
  document.getElementById('doc-date').valueAsDate = new Date();
  document.getElementById('editor-workzone').classList.add('hidden');
  document.getElementById('ocr-extracted-text').value = '';
  document.getElementById('save-doc-btn').disabled = true;
  document.getElementById('ocr-extract-btn').disabled = true;

  renderDashboard();
  renderLibrary();
  updateLibBadge();
  showToast(`Dokumen "${title}" berhasil disimpan dari kamera!`, 'success');
}

// ============================================================
// SECTION 13: DOCUMENT ACTIONS
// ============================================================

async function downloadDocument(docId) {
  const doc = db.documents.find(d => d.id === docId);
  if (!doc) return;

  if (doc.hasFile) {
    const link = Object.assign(document.createElement('a'), { href: `/api/documents/${doc.id}/file`, download: doc.fileName });
    link.click();
    await logActivity('download', doc.documentNumber, `Download: ${doc.fileName}`);
    showToast(`Mengunduh "${doc.fileName}"...`, 'info');
  } else if (doc.fileBlob) {
    const url  = URL.createObjectURL(doc.fileBlob);
    const link = Object.assign(document.createElement('a'), { href: url, download: doc.fileName });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    await logActivity('download', doc.documentNumber, `Download: ${doc.fileName}`);
    showToast(`Mengunduh "${doc.fileName}"...`, 'info');
  } else if (doc.pages?.length > 0) {
    // Generate PDF from pages
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    doc.pages.forEach((p, i) => {
      if (i > 0) pdf.addPage();
      try { pdf.addImage(p, 'JPEG', 5, 5, 200, 280); } catch (_) {}
    });
    pdf.save(doc.fileName || `${doc.title}.pdf`);
    await logActivity('download', doc.documentNumber, `Download (generated PDF): ${doc.fileName}`);
    showToast(`PDF "${doc.fileName}" sedang diunduh...`, 'info');
  } else {
    showToast('File tidak tersedia untuk diunduh.', 'warning');
  }
}

async function deleteDocument(docId) {
  const doc = db.documents.find(d => d.id === docId);
  if (!doc) return;

  const confirmed = await showConfirm('Hapus Dokumen', `Yakin ingin menghapus "${doc.title || doc.fileName}"? Tindakan ini tidak dapat dibatalkan.`);
  if (!confirmed) return;

  await deleteDocumentFromDB(docId);
  await logActivity('delete', doc.documentNumber, `Hapus dokumen: ${doc.title}`);

  closeDetailModal();
  renderDashboard();
  renderLibrary();
  updateLibBadge();
  showToast('Dokumen berhasil dihapus.', 'success');
}

// ============================================================
// SECTION 14: SCANNER MANAGEMENT
// ============================================================

async function addScanner() {
  const name   = document.getElementById('new-scanner-name').value.trim();
  const device = document.getElementById('new-scanner-device').value.trim();
  const type   = document.getElementById('new-scanner-type').value;

  if (!name || !device) { showToast('Nama dan Device ID wajib diisi!', 'warning'); return; }

  const scanner = {
    id:       `scanner_${Date.now()}`,
    name,
    deviceId: device,
    type,
    isOnline: true, // Simulate online on add
    lastSeen: Date.now(),
  };

  await fetch('/api/scanners', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scanner)
  });
  db.scanners.push(scanner);

  closeModal('add-scanner-modal');
  renderScannerConfig();
  renderScannerSelect();
  renderDashboardScanners();

  document.getElementById('new-scanner-name').value = '';
  document.getElementById('new-scanner-device').value = '';

  await logActivity('config', scanner.name, `Scanner baru ditambahkan: ${name} (${type})`);
  showToast(`Scanner "${name}" berhasil ditambahkan!`, 'success');
}

async function removeScanner(scannerId) {
  const scanner = db.scanners.find(s => s.id === scannerId);
  if (!scanner) return;

  const confirmed = await showConfirm('Hapus Scanner', `Yakin ingin menghapus scanner "${scanner.name}"?`);
  if (!confirmed) return;

  await fetch(`/api/scanners/${scannerId}`, {
    method: 'DELETE'
  });
  db.scanners = db.scanners.filter(s => s.id !== scannerId);

  renderScannerConfig();
  renderScannerSelect();
  renderDashboardScanners();
  showToast(`Scanner "${scanner.name}" dihapus.`, 'info');
}

// ============================================================
// SECTION 15: EXPORT / IMPORT / BACKUP
// ============================================================

async function exportDatabase() {
  const exportData = {
    version:   '2.0',
    exportedAt: new Date().toISOString(),
    exportedBy: currentUser?.name,
    documents: db.documents.map(d => {
      const { fileBlob, ...rest } = d;
      return rest; // Don't include blobs in JSON export
    }),
    logs: db.logs,
    scanners: db.scanners,
  };
  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: `scanvault_backup_${Date.now()}.json` });
  link.click();
  URL.revokeObjectURL(url);
  await logActivity('export', 'Backup JSON', `Ekspor ${db.documents.length} dokumen`);
  showToast('Database berhasil diekspor!', 'success');
}

async function importDatabase(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.documents) { showToast('Format file tidak valid!', 'error'); return; }

    for (const doc of data.documents) {
      await saveDocumentToDB(normalizeDocument(doc));
    }
    if (Array.isArray(data.scanners)) {
      for (const s of data.scanners) {
        await fetch('/api/scanners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(s)
        });
      }
    }

    await loadDatabase();
    renderDashboard();
    renderLibrary();
    updateLibBadge();
    renderScannerConfig();
    renderScannerSelect();
    renderDashboardScanners();

    await logActivity('import', 'Backup JSON', `Impor ${data.documents.length} dokumen`);
    showToast(`Berhasil mengimpor ${data.documents.length} dokumen!`, 'success');
  } catch (err) {
    showToast('Gagal mengimpor: ' + err.message, 'error');
  }
}

function exportLogs() {
  if (db.logs.length === 0) { showToast('Tidak ada log untuk diekspor.', 'info'); return; }
  const headers = ['#', 'Waktu', 'Pengguna', 'Aksi', 'Target', 'Detail', 'Status'];
  const rows = db.logs.map((l, i) => [
    i + 1,
    formatDate(l.createdAt),
    l.userName,
    l.action,
    l.target,
    l.details,
    l.status
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: `scanvault_logs_${Date.now()}.csv` });
  link.click();
  URL.revokeObjectURL(url);
  showToast('Log berhasil diekspor sebagai CSV!', 'success');
}

// ============================================================
// SECTION 16: TAB NAVIGATION
// ============================================================

const TAB_META = {
  dashboard: { title: 'Dashboard',     subtitle: 'Selamat datang! Ringkasan sistem dokumen scan Anda.' },
  library:   { title: 'Perpustakaan',  subtitle: 'Kelola semua dokumen yang tersimpan di Vault.' },
  scanner:   { title: 'Scan Dokumen',  subtitle: 'Hubungkan scanner fisik atau gunakan kamera webcam.' },
  upload:    { title: 'Upload PDF',    subtitle: 'Unggah file PDF ke sistem. Maks. 50 MB per file.' },
  logs:      { title: 'Log Aktivitas', subtitle: 'Rekam jejak semua aksi pengguna dalam sistem.' },
  settings:  { title: 'Pengaturan',    subtitle: 'Konfigurasi akun, scanner, dan manajemen data.' },
};

function switchTab(tabName) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));

  const panel = document.getElementById(`tab-${tabName}`);
  if (panel) panel.classList.add('active');

  const menuBtn = document.querySelector(`.menu-item[data-tab="${tabName}"]`);
  if (menuBtn) menuBtn.classList.add('active');

  const meta = TAB_META[tabName];
  if (meta) {
    document.getElementById('page-title').textContent    = meta.title;
    document.getElementById('page-subtitle').textContent = meta.subtitle;
  }

  currentTab = tabName;

  // Tab-specific actions
  if (tabName === 'dashboard') renderDashboard();
  if (tabName === 'library') renderLibrary(
    document.getElementById('library-search').value,
    document.getElementById('library-filter-source').value,
    document.getElementById('library-filter-status').value,
    document.getElementById('library-sort-by').value
  );
  if (tabName === 'logs') renderLogs(activeLogFilter);
  if (tabName === 'settings') { renderScannerConfig(); renderUserAccounts(); }
  if (tabName === 'upload') renderRecentUploadList();
  if (tabName === 'scanner') renderScannerSelect();

  // Start/stop camera
  if (tabName === 'scanner' && inputMode === 'camera') {
    startCamera();
  } else if (tabName !== 'scanner') {
    stopCamera();
  }

  lucide.createIcons();
}

// ============================================================
// SECTION 17: MODAL HELPERS
// ============================================================

function openModal(id) {
  document.getElementById(id).classList.add('open');
  lucide.createIcons();
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// ============================================================
// SECTION 18: GLOBAL SEARCH
// ============================================================

function handleGlobalSearch(query) {
  if (!query) return;
  switchTab('library');
  document.getElementById('library-search').value = query;
  renderLibrary(query);
}

// ============================================================
// SECTION 19: INITIALIZE APP
// ============================================================

async function initApp() {
  await loadDatabase();
  initTheme();
  setupAllEventListeners();
  renderDashboard();
  updateLibBadge();
  updateLogBadge();
  renderScannerSelect();
  document.getElementById('doc-date').valueAsDate = new Date();
  document.getElementById('doc-user').value = currentUser?.name || '';
  document.getElementById('upload-doc-user').value = currentUser?.name || '';
  lucide.createIcons();
}

function initTheme() {
  let saved = 'dark';
  try {
    saved = localStorage.getItem('scanvault_theme') || 'dark';
  } catch (_) {}
  document.body.classList.remove('theme-dark', 'theme-light');
  document.body.classList.add(`theme-${saved}`);
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === saved);
  });
}

function setTheme(theme) {
  document.body.classList.remove('theme-dark', 'theme-light');
  document.body.classList.add(`theme-${theme}`);
  try {
    localStorage.setItem('scanvault_theme', theme);
  } catch (_) {}
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
}

// ============================================================
// SECTION 20: EVENT LISTENERS
// ============================================================

function setupAllEventListeners() {

  // --- Theme ---
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
  });

  // --- Sidebar Toggle ---
  bindElement('sidebar-toggle', 'click', () => {
    const sidebar = document.getElementById('sidebar');
    const main    = document.querySelector('.main-content');
    if (sidebar) sidebar.classList.toggle('collapsed');
    if (main) main.classList.toggle('sidebar-collapsed');
  });

  // --- Navigation ---
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });

  // --- Quick Action Buttons ---
  bindElement('quick-scan-btn', 'click', () => switchTab('scanner'));
  bindElement('view-all-docs-btn', 'click', () => switchTab('library'));
  bindElement('dashboard-scan-btn', 'click', () => switchTab('scanner'));
  bindElement('dashboard-upload-btn', 'click', () => switchTab('upload'));
  bindElement('empty-state-upload-btn', 'click', () => switchTab('upload'));

  // --- Global Search ---
  const globalSearch = document.getElementById('global-search');
  let searchTimer;
  if (globalSearch) {
    globalSearch.addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => handleGlobalSearch(e.target.value), 350);
    });
  }

  // --- Library Filters ---
  ['library-search', 'library-filter-source', 'library-filter-status', 'library-sort-by'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      renderLibrary(
        document.getElementById('library-search')?.value || '',
        document.getElementById('library-filter-source')?.value || '',
        document.getElementById('library-filter-status')?.value || '',
        document.getElementById('library-sort-by')?.value || ''
      );
    });
    el.addEventListener('change', () => {
      renderLibrary(
        document.getElementById('library-search')?.value || '',
        document.getElementById('library-filter-source')?.value || '',
        document.getElementById('library-filter-status')?.value || '',
        document.getElementById('library-sort-by')?.value || ''
      );
    });
  });

  // --- View Toggle ---
  bindElement('view-grid-btn', 'click', () => {
    viewMode = 'grid';
    const gridBtn = document.getElementById('view-grid-btn');
    const listBtn = document.getElementById('view-list-btn');
    if (gridBtn) gridBtn.classList.add('active');
    if (listBtn) listBtn.classList.remove('active');
    renderLibrary(document.getElementById('library-search')?.value || '');
  });

  bindElement('view-list-btn', 'click', () => {
    viewMode = 'list';
    const listBtn = document.getElementById('view-list-btn');
    const gridBtn = document.getElementById('view-grid-btn');
    if (listBtn) listBtn.classList.add('active');
    if (gridBtn) gridBtn.classList.remove('active');
    renderLibrary(document.getElementById('library-search')?.value || '');
  });

  // --- Scanner Mode Tabs ---
  bindElement('tab-mode-hw-scan', 'click', () => {
    inputMode = 'hw-scan';
    const hwBtn = document.getElementById('tab-mode-hw-scan');
    const cameraBtn = document.getElementById('tab-mode-camera');
    const fileBtn = document.getElementById('tab-mode-file');
    const hwZone = document.getElementById('hw-scan-workzone');
    const cameraZone = document.getElementById('camera-workzone');
    const fileZone = document.getElementById('file-workzone');
    
    if (hwBtn) hwBtn.classList.add('active');
    if (cameraBtn) cameraBtn.classList.remove('active');
    if (fileBtn) fileBtn.classList.remove('active');
    
    if (hwZone) hwZone.classList.add('active');
    if (cameraZone) cameraZone.classList.remove('active');
    if (fileZone) fileZone.classList.remove('active');
    stopCamera();
  });

  bindElement('tab-mode-camera', 'click', () => {
    inputMode = 'camera';
    const cameraBtn = document.getElementById('tab-mode-camera');
    const hwBtn = document.getElementById('tab-mode-hw-scan');
    const fileBtn = document.getElementById('tab-mode-file');
    const cameraZone = document.getElementById('camera-workzone');
    const hwZone = document.getElementById('hw-scan-workzone');
    const fileZone = document.getElementById('file-workzone');
    
    if (cameraBtn) cameraBtn.classList.add('active');
    if (hwBtn) hwBtn.classList.remove('active');
    if (fileBtn) fileBtn.classList.remove('active');
    
    if (cameraZone) cameraZone.classList.add('active');
    if (hwZone) hwZone.classList.remove('active');
    if (fileZone) fileZone.classList.remove('active');
    startCamera();
  });

  bindElement('tab-mode-file', 'click', () => {
    inputMode = 'file';
    const cameraBtn = document.getElementById('tab-mode-camera');
    const hwBtn = document.getElementById('tab-mode-hw-scan');
    const fileBtn = document.getElementById('tab-mode-file');
    const cameraZone = document.getElementById('camera-workzone');
    const hwZone = document.getElementById('hw-scan-workzone');
    const fileZone = document.getElementById('file-workzone');
    
    if (fileBtn) fileBtn.classList.add('active');
    if (cameraBtn) cameraBtn.classList.remove('active');
    if (hwBtn) hwBtn.classList.remove('active');
    
    if (fileZone) fileZone.classList.add('active');
    if (cameraZone) cameraZone.classList.remove('active');
    if (hwZone) hwZone.classList.remove('active');
    stopCamera();
  });

  // --- Scanner Controls ---
  bindElement('btn-refresh-scanners', 'click', () => {
    renderScannerSelect();
    showToast('Daftar scanner diperbarui.', 'info');
  });

  bindElement('btn-start-scan', 'click', startHardwareScan);

  // --- Camera Controls ---
  bindElement('capture-btn', 'click', captureFromWebcam);
  bindElement('retry-camera-btn', 'click', startCamera);

  // --- File Scan Controls ---
  const fileDropzone = document.getElementById('file-scan-dropzone');
  const fileScanInput = document.getElementById('file-scan-input');
  if (fileDropzone && fileScanInput) {
    fileDropzone.addEventListener('click', () => fileScanInput.click());
    fileScanInput.addEventListener('change', function(e) {
      handleScanImageFile(e.target.files[0]);
    });
    fileDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      fileDropzone.style.borderColor = 'var(--accent-color)';
      fileDropzone.style.background = 'var(--bg-secondary)';
    });
    fileDropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      fileDropzone.style.borderColor = 'var(--color-border)';
      fileDropzone.style.background = '';
    });
    fileDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      fileDropzone.style.borderColor = 'var(--color-border)';
      fileDropzone.style.background = '';
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      if (files.length > 0) {
        handleScanImageFile(files[0]);
      } else {
        showToast('Hanya berkas gambar (JPG, PNG, WEBP) yang didukung!', 'warning');
      }
    });
  }

  bindElement('camera-select', 'change', async function() {
    if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); }
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: this.value } } });
      const video = document.getElementById('webcam-video');
      if (video) video.srcObject = webcamStream;
    } catch (_) {}
  });

  // --- Image Editor ---
  bindElement('rotate-btn', 'click', () => {
    currentRotation = (currentRotation + 90) % 360;
    renderCanvas();
  });

  bindElement('reset-image-btn', 'click', () => {
    loadedImage = null;
    loadedImageObj = null;
    currentRotation = 0;
    activeFilter = 'original';
    currentBrightness = 0;
    currentContrast = 0;
    document.getElementById('editor-workzone').classList.add('hidden');
    document.getElementById('save-doc-btn').disabled = true;
    document.getElementById('ocr-extract-btn').disabled = true;
    document.getElementById('ocr-extracted-text').value = '';
    document.getElementById('ocr-status-badge').textContent = 'Menunggu Gambar';
    document.getElementById('ocr-status-badge').className = 'ocr-status-badge badge-idle';
  });

  bindElement('add-page-btn', 'click', () => {
    if (!loadedImage) return;
    const canvas  = document.getElementById('editor-canvas');
    pendingPages.push(canvas.toDataURL('image/jpeg', 0.9));
    showToast(`Halaman ${pendingPages.length} ditambahkan. Ambil foto halaman berikutnya.`, 'info');
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderCanvas();
    });
  });

  bindElement('contrast-slider', 'input', function() {
    currentContrast = parseInt(this.value);
    document.getElementById('contrast-val').textContent = this.value;
    renderCanvas();
  });

  bindElement('brightness-slider', 'input', function() {
    currentBrightness = parseInt(this.value);
    document.getElementById('brightness-val').textContent = this.value;
    renderCanvas();
  });

  // --- OCR ---
  bindElement('ocr-extract-btn', 'click', runOCR);

  // --- Metadata Form (Camera/HW Scan) ---
  const metadataForm = document.getElementById('doc-metadata-form');
  if (metadataForm) {
    metadataForm.addEventListener('submit', (e) => {
      if (inputMode === 'hw-scan') {
        e.preventDefault();
        // HW scan form submit is handled by startHardwareScan
      } else {
        saveCameraDocument(e);
      }
    });
  }

  // --- PDF Upload ---
  const pdfFileInput = document.getElementById('pdf-file-input');
  if (pdfFileInput) {
    pdfFileInput.addEventListener('change', function() {
      Array.from(this.files).forEach(f => addToUploadQueue(f));
      this.value = '';
    });
  }

  const pdfDropzone = document.getElementById('pdf-dropzone');
  if (pdfDropzone) {
    pdfDropzone.addEventListener('click', function(e) {
      if (e.target === this || e.target.closest('.dropzone-icon-wrap') || e.target.tagName === 'H3' || e.target.tagName === 'P') {
        document.getElementById('pdf-file-input').click();
      }
    });
  }

  const uploadMetadataForm = document.getElementById('upload-metadata-form');
  if (uploadMetadataForm) {
    uploadMetadataForm.addEventListener('submit', handleUploadSubmit);
  }

  // --- Direct Upload ---
  const directUploadInput = document.getElementById('direct-upload-input');
  if (directUploadInput) {
    directUploadInput.addEventListener('change', async function() {
      if (this.files.length === 0) return;
      
      const category = prompt("Kategori Dokumen (contoh: Kwitansi, Faktur, Laporan, Lainnya):", "Lainnya");
      if (category === null) return; // cancelled

      showToast('Mengupload file...', 'info');

      for (const file of Array.from(this.files)) {
        try {
          const fileBlob = new Blob([await file.arrayBuffer()], { type: file.type || 'application/pdf' });
          const docId    = `doc_${Date.now()}_${Math.random().toString(36).substr(2,8)}`;
          const docNum   = generateDocNumber();
          
          let imagePlaceholder = file.type.startsWith('image/') 
            ? await new Promise((res) => { const reader = new FileReader(); reader.onload = () => res(reader.result); reader.readAsDataURL(file); })
            : pdfPlaceholderSVG(file.name);

          const doc = {
            id:             docId,
            documentNumber: docNum,
            title:          file.name,
            fileName:       file.name,
            fileType:       file.type || 'application/pdf',
            fileSize:       file.size,
            fileBlob:       fileBlob,
            image:          imagePlaceholder,
            pages:          file.type.startsWith('image/') ? [imagePlaceholder] : [],
            source:         'upload',
            category:       category || 'Lainnya',
            status:         'Tersimpan',
            tags:           [],
            description:    'Upload Langsung dari File Manager',
            uploadedBy:     currentUser?.name || 'Sistem',
            extractedText:  '',
            createdAt:      Date.now(),
          };

          await saveDocumentToDB(doc);
          await logActivity('upload', doc.documentNumber, `Upload Langsung: ${file.name}`);
        } catch (err) {
          console.error("Direct upload error:", err);
        }
      }
      this.value = '';
      showToast('File berhasil diupload!', 'success');
      if (typeof renderLibrary === 'function') renderLibrary();
      if (typeof updateLibBadge === 'function') updateLibBadge();
      if (typeof renderDashboard === 'function') renderDashboard();
    });
  }

  // --- Logs ---
  bindElement('log-filter-action', 'change', function() {
    activeLogFilter = this.value;
    renderLogs(activeLogFilter);
  });

  bindElement('export-logs-btn', 'click', exportLogs);

  bindElement('clear-logs-btn', 'click', async () => {
    const confirmed = await showConfirm('Hapus Log', 'Hapus semua log aktivitas yang ditampilkan?');
    if (!confirmed) return;
    const url = activeLogFilter === 'all' ? '/api/logs' : `/api/logs?action=${activeLogFilter}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (response.ok) {
      if (activeLogFilter === 'all') {
        db.logs = [];
      } else {
        db.logs = db.logs.filter(l => l.action !== activeLogFilter);
      }
      renderLogs(activeLogFilter);
      updateLogBadge();
      showToast('Log berhasil dihapus.', 'info');
    } else {
      showToast('Gagal menghapus log dari server.', 'error');
    }
  });

  // --- Modal: Detail ---
  bindElement('close-detail-modal', 'click', closeDetailModal);
  bindElement('doc-detail-modal', 'click', e => {
    if (e.target === e.currentTarget) closeDetailModal();
  });

  bindElement('delete-doc-btn', 'click', () => {
    if (activeDocumentId) deleteDocument(activeDocumentId);
  });

  bindElement('download-pdf-btn', 'click', () => {
    if (activeDocumentId) { downloadDocument(activeDocumentId); closeDetailModal(); }
  });

  bindElement('copy-doc-text-btn', 'click', () => {
    const text = document.getElementById('modal-doc-ocr-text').value;
    if (!text) { showToast('Tidak ada teks untuk disalin.', 'info'); return; }
    navigator.clipboard.writeText(text).then(() => showToast('Teks disalin ke clipboard!', 'success'));
  });

  bindElement('share-doc-btn', 'click', () => {
    const doc = db.documents.find(d => d.id === activeDocumentId);
    if (!doc) return;
    if (navigator.share) {
      navigator.share({ title: doc.title, text: `Dokumen: ${doc.documentNumber}` });
    } else {
      navigator.clipboard.writeText(`${doc.documentNumber} — ${doc.title}`);
      showToast('Info dokumen disalin ke clipboard!', 'info');
    }
  });

  const editOcrBtn = document.getElementById('edit-modal-ocr-btn');
  const ocrTextarea = document.getElementById('modal-doc-ocr-text');
  if (editOcrBtn && ocrTextarea) {
    editOcrBtn.addEventListener('click', async () => {
      if (ocrTextarea.readOnly) {
        ocrTextarea.readOnly = false;
        ocrTextarea.focus();
        const editText = document.getElementById('edit-ocr-btn-text');
        if (editText) editText.textContent = 'Simpan';
        editOcrBtn.querySelector('svg')?.remove();
      } else {
        ocrTextarea.readOnly = true;
        const editText = document.getElementById('edit-ocr-btn-text');
        if (editText) editText.textContent = 'Edit Teks';
        const doc = db.documents.find(d => d.id === activeDocumentId);
        if (doc) {
          doc.extractedText = ocrTextarea.value;
          await saveDocumentToDB(doc);
          showToast('Teks berhasil disimpan.', 'success');
        }
      }
    });
  }

  // --- Add Scanner Modal ---
  bindElement('add-scanner-btn', 'click', () => openModal('add-scanner-modal'));
  bindElement('close-add-scanner-modal', 'click', () => closeModal('add-scanner-modal'));
  bindElement('cancel-add-scanner', 'click', () => closeModal('add-scanner-modal'));
  bindElement('save-add-scanner', 'click', addScanner);

  // --- Settings ---
  bindElement('settings-export-btn', 'click', exportDatabase);

  bindElement('settings-import-trigger-btn', 'click', () => {
    const input = document.getElementById('settings-import-input');
    if (input) input.click();
  });

  bindElement('settings-import-input', 'change', function() {
    if (this.files[0]) importDatabase(this.files[0]);
    this.value = '';
  });

  bindElement('settings-clear-btn', 'click', async () => {
    const confirmed = await showConfirm('Hapus Semua Dokumen', 'Ini akan menghapus SEMUA dokumen secara permanen. Pastikan sudah backup terlebih dahulu!');
    if (!confirmed) return;
    const response = await fetch('/api/documents', { method: 'DELETE' });
    if (response.ok) {
      db.documents = [];
      renderDashboard();
      renderLibrary();
      updateLibBadge();
      showToast('Semua dokumen telah dihapus.', 'warning');
    } else {
      showToast('Gagal menghapus dokumen dari server.', 'error');
    }
  });

  bindElement('clear-all-logs-settings-btn', 'click', async () => {
    const confirmed = await showConfirm('Hapus Semua Log', 'Semua riwayat aktivitas akan dihapus secara permanen.');
    if (!confirmed) return;
    const response = await fetch('/api/logs', { method: 'DELETE' });
    if (response.ok) {
      db.logs = [];
      renderLogs();
      updateLogBadge();
      showToast('Semua log telah dihapus.', 'info');
    } else {
      showToast('Gagal menghapus log dari server.', 'error');
    }
  });

  // --- Confirm Dialog ---
  bindElement('confirm-ok', 'click', () => {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.remove('open');
    if (confirmCallback) { confirmCallback(true); confirmCallback = null; }
  });

  bindElement('confirm-cancel', 'click', () => {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.remove('open');
    if (confirmCallback) { confirmCallback(false); confirmCallback = null; }
  });

  // --- Logout ---
  bindElement('logout-btn', 'click', async () => {
    await logActivity('logout', currentUser?.name || '-', 'Keluar dari sesi');
    clearSession();
    currentUser = null;
    showLoginScreen();
    showToast('Anda telah keluar dari BPKAScan.', 'info');
  });

  // --- Keyboard shortcut ---
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeDetailModal();
      closeModal('add-scanner-modal');
      closeModal('confirm-modal');
    }
  });
}

// ============================================================
// SECTION 21: LOGIN FORM
// ============================================================

function setupLoginListeners() {
  const form = document.getElementById('login-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const identifier = document.getElementById('login-email').value.trim();
    const password   = document.getElementById('login-password').value;
    const errDiv     = document.getElementById('login-error');
    const errText    = document.getElementById('login-error-text');
    const btn        = document.getElementById('login-submit-btn');

    btn.disabled = true;
    btn.innerHTML = '<svg style="width:16px;height:16px;animation:spin 1s linear infinite" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg><span>Masuk...</span>';
    errDiv.classList.add('hidden');

    // Simulate network delay
    await new Promise(r => setTimeout(r, 700));

    const user = login(identifier, password);

    if (user) {
      currentUser = user;
      saveSession(user);
      btn.innerHTML = '<span>Berhasil! Membuka aplikasi...</span>';
      await new Promise(r => setTimeout(r, 400));
      showApp();

      // Log login after app init
      setTimeout(async () => {
        await logActivity('login', user.name, `Login sebagai ${user.role}`);
      }, 500);
    } else {
      errText.textContent = 'Email/username atau password salah. Coba lagi.';
      errDiv.classList.remove('hidden');
      btn.disabled = false;
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg><span>Masuk ke BPKAScan</span>';
    }
  });

  // Password toggle
  document.getElementById('toggle-password').addEventListener('click', () => {
    const input = document.getElementById('login-password');
    const icon  = document.querySelector('#toggle-password svg');
    if (input.type === 'password') {
      input.type = 'text';
      // Replace with "eye-off"
    } else {
      input.type = 'password';
    }
  });

  // Enter key
  document.getElementById('login-email').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-password').focus();
  });
}

// CSS for spinner animation (injected dynamically)
const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
document.head.appendChild(spinStyle);

// ============================================================
// SECTION 22: BOOT
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  setupLoginListeners();
  initAuth();
  lucide.createIcons();
});
