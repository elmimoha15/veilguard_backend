// Throwaway dev harness UI. Loads Firebase from the gstatic CDN, subscribes to
// the emulator, and streams a free scan's findings live. NOT the product UI.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  collection,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

const dbPromise = (async () => {
  const cfg = await (await fetch('/dev-config')).json();
  const app = initializeApp({ projectId: cfg.projectId, apiKey: 'demo-key' });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, cfg.emulatorHost, cfg.emulatorPort);
  return db;
})();

function reset() {
  $('grade').textContent = '';
  $('grade').removeAttribute('data-done');
  $('counts').innerHTML = '';
  $('findings').innerHTML = '';
}

function renderCounts(c) {
  $('counts').innerHTML = ['critical', 'high', 'medium', 'low', 'info']
    .map((s) => `<span class="${s}">${c[s] || 0} ${s}</span>`)
    .join('');
}

function addFinding(f) {
  const el = document.createElement('div');
  el.className = `finding ${f.severity}`;
  const loc = f.location?.file
    ? `${f.location.file}${f.location.line ? ':' + f.location.line : ''}`
    : f.location?.url || '';
  el.innerHTML =
    `<div class="sev">${f.severity} · ${f.category}</div>` +
    `<div class="title">${escapeHtml(f.title)}</div>` +
    `<div>${escapeHtml(f.whyItMatters || '')}</div>` +
    (loc ? `<div class="loc">${escapeHtml(loc)}</div>` : '') +
    // fix / fixPrompt are NOT in the client-readable doc — they're locked at the
    // data layer. We can only show the upgrade placeholder.
    `<div class="locked">🔒 Fix locked — upgrade to unlock</div>`;
  $('findings').appendChild(el);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function subscribe(db, scanId) {
  const seen = new Set();
  const counts = {};
  onSnapshot(doc(db, 'scans', scanId), (snap) => {
    const d = snap.data();
    if (!d) return;
    const p = d.progress ? ` — phase: ${d.progress.phase}… ${d.progress.done}/${d.progress.total}` : '';
    $('status').textContent = `status: ${d.status}${p}`;
    if (d.status === 'done') {
      $('grade').textContent = `Grade ${d.grade}`;
      $('grade').setAttribute('data-done', '1');
    } else if (d.status === 'error') {
      $('status').textContent = `error: ${d.error}`;
    }
  });
  onSnapshot(collection(db, 'scans', scanId, 'findings'), (snap) => {
    snap.docChanges().forEach((chg) => {
      if (chg.type !== 'added' || seen.has(chg.doc.id)) return;
      seen.add(chg.doc.id);
      const f = chg.doc.data();
      counts[f.severity] = (counts[f.severity] || 0) + 1;
      renderCounts(counts);
      addFinding(f);
    });
  });
}

async function runScan() {
  const db = await dbPromise;
  const url = $('url').value.trim();
  if (!url) return;
  reset();
  $('status').textContent = 'creating scan…';
  const res = await fetch('/createScan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { type: 'url', value: url } }),
  });
  const body = await res.json();
  if (res.status !== 202) {
    $('status').textContent = `error: ${body.error || res.status}`;
    return;
  }
  $('status').textContent = `scanId=${body.scanId} — queued`;
  subscribe(db, body.scanId);
}

$('scan').addEventListener('click', runScan);

// Convenience for manual/headless verification: /?auto=<url> auto-runs a scan.
const auto = new URLSearchParams(location.search).get('auto');
if (auto) {
  $('url').value = auto;
  runScan();
}
