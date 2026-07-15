// Throwaway dev harness UI (NOT the product). Loads Firebase from the gstatic
// CDN, does auth + free-scan against the emulator, streams findings live.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js';
import {
  getFirestore, connectFirestoreEmulator, doc, collection, query, where, orderBy, getDocs, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, GithubAuthProvider,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js';

const $ = (id) => document.getElementById(id);
let db, auth, lastScanId = null;

const ready = (async () => {
  const cfg = await (await fetch('/dev-config')).json();
  const app = initializeApp({ projectId: cfg.projectId, apiKey: 'demo-key' });
  db = getFirestore(app);
  connectFirestoreEmulator(db, cfg.emulatorHost, cfg.emulatorPort);
  auth = getAuth(app);
  connectAuthEmulator(auth, cfg.authEmulatorUrl, { disableWarnings: true });

  onAuthStateChanged(auth, async (user) => {
    $('signedout').style.display = user ? 'none' : 'block';
    $('signedin').style.display = user ? 'block' : 'none';
    if (user) {
      const me = await api('/me', {});
      $('who').textContent = user.email || user.uid;
      $('plan').textContent = me?.plan || 'free';
      refreshMyScans(user.uid);
    }
  });
})();

async function token() {
  return auth.currentUser ? await auth.currentUser.getIdToken() : null;
}

async function api(path, body) {
  const t = await token();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.ok ? res.json() : null;
}

/* ---- auth controls ---- */
const err = (e) => ($('status').textContent = `auth error: ${e.code || e.message}`);
$('signup').onclick = () => ready.then(() => createUserWithEmailAndPassword(auth, $('email').value, $('password').value).catch(err));
$('login').onclick = () => ready.then(() => signInWithEmailAndPassword(auth, $('email').value, $('password').value).catch(err));
$('google').onclick = () => ready.then(() => signInWithPopup(auth, new GoogleAuthProvider()).catch(err));
$('github').onclick = () => ready.then(() => signInWithPopup(auth, new GithubAuthProvider()).catch(err));
$('logout').onclick = () => signOut(auth);

/* ---- my scans (client query — rules enforce ownerUid == me) ---- */
async function refreshMyScans(uid) {
  try {
    const snap = await getDocs(query(collection(db, 'scans'), where('ownerUid', '==', uid), orderBy('createdAt', 'desc')));
    $('myscans').innerHTML =
      '<strong>My scans:</strong>' +
      (snap.empty ? ' none yet' : snap.docs.map((d) => `<div>· ${d.data().target?.value} — ${d.data().status} ${d.data().grade || ''}</div>`).join(''));
  } catch (e) {
    $('myscans').textContent = `my scans error: ${e.code}`;
  }
}

/* ---- scan rendering ---- */
function reset() { $('grade').textContent = ''; $('grade').removeAttribute('data-done'); $('counts').innerHTML = ''; $('findings').innerHTML = ''; $('claimbox').innerHTML = ''; }
function renderCounts(c) { $('counts').innerHTML = ['critical','high','medium','low','info'].map((s) => `<span class="${s}">${c[s]||0} ${s}</span>`).join(''); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function addFinding(f) {
  const el = document.createElement('div');
  el.className = `finding ${f.severity}`;
  const loc = f.location?.file ? `${f.location.file}${f.location.line ? ':' + f.location.line : ''}` : f.location?.url || '';
  el.innerHTML = `<div class="sev">${f.severity} · ${f.category}</div><div class="title">${escapeHtml(f.title)}</div>` +
    `<div>${escapeHtml(f.whyItMatters || '')}</div>` + (loc ? `<div class="loc">${escapeHtml(loc)}</div>` : '') +
    `<div class="locked">🔒 Fix locked — upgrade to unlock</div>`;
  $('findings').appendChild(el);
}

function subscribe(scanId) {
  const seen = new Set(); const counts = {};
  onSnapshot(doc(db, 'scans', scanId), (snap) => {
    const d = snap.data(); if (!d) return;
    const p = d.progress ? ` — phase: ${d.progress.phase}… ${d.progress.done}/${d.progress.total}` : '';
    $('status').textContent = `status: ${d.status}${p}`;
    if (d.status === 'done') { $('grade').textContent = `Grade ${d.grade}`; $('grade').setAttribute('data-done', '1'); if (auth?.currentUser) refreshMyScans(auth.currentUser.uid); }
    else if (d.status === 'error') $('status').textContent = `error: ${d.error}`;
  });
  onSnapshot(collection(db, 'scans', scanId, 'findings'), (snap) => {
    snap.docChanges().forEach((chg) => {
      if (chg.type !== 'added' || seen.has(chg.doc.id)) return;
      seen.add(chg.doc.id); const f = chg.doc.data();
      counts[f.severity] = (counts[f.severity] || 0) + 1; renderCounts(counts); addFinding(f);
    });
  });
}

async function runScan() {
  await ready;
  const url = $('url').value.trim(); if (!url) return;
  reset();
  $('status').textContent = 'creating scan…';
  const body = await api('/createScan', { target: { type: 'url', value: url } });
  if (!body?.scanId) { $('status').textContent = 'createScan failed (rate limit / bad url?)'; return; }
  lastScanId = body.scanId;
  $('status').textContent = `scanId=${body.scanId} — queued`;
  subscribe(body.scanId);
  // If signed in, offer to claim (useful when the scan was run anonymously).
  if (auth?.currentUser) {
    $('claimbox').innerHTML = '<button id="claim">Claim this scan to my account</button>';
    $('claim').onclick = async () => { await api('/claimScan', { scanId: lastScanId }); refreshMyScans(auth.currentUser.uid); $('claimbox').textContent = 'claimed ✓'; };
  }
}

$('scan').addEventListener('click', runScan);
const auto = new URLSearchParams(location.search).get('auto');
if (auto) { $('url').value = auto; runScan(); }
