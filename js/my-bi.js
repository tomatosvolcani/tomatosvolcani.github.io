// js/my-bi.js  –  לוח BI אישי למשתמש הרגיל
// ==============================================================
// 2 קריאות Firestore קבועות (ניסויים שלי + רשימת שיתופים),
// + קריאות מקבילות לניסויים המשותפים (Promise.all).
// כל ניתוח הנתונים – בצד הלקוח בלבד.
// ==============================================================
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc,
    getDoc,
    collection,
    getDocs,
    query,
    orderBy,
    limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from "./toast.js";

let currentUser = null;
let userData    = null;
/** @type {Array<{id:string, ownerUid:string, isShared:boolean, [key:string]:any}>} */
let allExperiments = [];

// ======================================================
// Bootstrap
// ======================================================
document.addEventListener('DOMContentLoaded', () => {
    initSidebarListeners();
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
});

onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;

    const approved = await checkApproval();
    if (!approved) return;

    await loadUserInfo();
    await loadAndRender();
});

// ======================================================
// Approval check
// ======================================================
async function checkApproval() {
    try {
        const snap = await getDoc(doc(db, 'users', currentUser.uid));
        if (snap.exists() && snap.data().isApproved === true) return true;
        await signOut(auth);
        window.location.href = 'login.html';
        return false;
    } catch {
        window.location.href = 'login.html';
        return false;
    }
}

// ======================================================
// Sidebar
// ======================================================
function initSidebarListeners() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebar      = document.querySelector('.sidebar');
    const overlay      = document.getElementById('sidebar-overlay');

    if (hamburgerBtn && sidebar) {
        hamburgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            if (overlay) overlay.classList.toggle('active');
            const icon = hamburgerBtn.querySelector('i');
            if (icon) { icon.classList.toggle('fa-bars'); icon.classList.toggle('fa-times'); }
        });
    }

    if (overlay) {
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
            const icon = hamburgerBtn?.querySelector('i');
            if (icon) { icon.classList.add('fa-bars'); icon.classList.remove('fa-times'); }
        });
    }
}

// ======================================================
// Load user info + optional admin menu
// ======================================================
async function loadUserInfo() {
    const nameEl = document.getElementById('user-display-name');
    try {
        const snap = await getDoc(doc(db, 'users', currentUser.uid));
        if (snap.exists()) {
            userData = snap.data();
            if (nameEl) {
                nameEl.textContent = `${userData.firstName || ''} ${userData.lastName || ''}`.trim() || currentUser.email;
            }
            await checkAndDisplayAdminMenu();
        }
    } catch (e) {
        console.error('loadUserInfo:', e);
    }
}

async function checkAndDisplayAdminMenu() {
    try {
        const q    = query(collection(db, 'users'), limit(2));
        const snap = await getDocs(q);
        if (snap.size > 1) displayAdminMenu();
    } catch {
        // no admin rights – fine
    }
}

function displayAdminMenu() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || nav.querySelector('.admin-menu-section')) return;
    nav.insertAdjacentHTML('beforeend', `
        <div class="admin-menu-section">
            <div class="nav-separator"></div>
            <div class="nav-section-title">ניהול מערכת</div>
            <a href="admin-users.html" class="nav-item">
                <i class="fas fa-users-cog"></i>
                <span>ניהול משתמשים</span>
            </a>
            <a href="admin-experiments.html" class="nav-item">
                <i class="fas fa-flask"></i>
                <span>כל הניסויים</span>
            </a>
            <a href="bi.html" class="nav-item">
                <i class="fas fa-chart-bar"></i>
                <span>לוח BI</span>
            </a>
        </div>
    `);
}

// ======================================================
// Main: load experiments → analyse → render
// ======================================================
async function loadAndRender() {
    const loadingEl = document.getElementById('loading-container');
    const contentEl = document.getElementById('bi-content');

    try {
        // --- קריאה 1: ניסויים שלי ---
        const myRef  = collection(db, 'users', currentUser.uid, 'experiments');
        const mySnap = await getDocs(query(myRef, orderBy('createdAt', 'desc')));

        const myExperiments = mySnap.docs.map(d => ({
            id: d.id,
            ownerUid: currentUser.uid,
            isShared: false,
            ...d.data()
        }));

        // --- קריאה 2: רשימת ניסויים משותפים ---
        const sharedRef  = collection(db, 'users', currentUser.uid, 'sharedExperiments');
        const sharedSnap = await getDocs(sharedRef);

        // --- קריאות מקבילות לניסויים המשותפים ---
        const sharedFetches = sharedSnap.docs.map(async sharedDoc => {
            const { ownerUid, experimentId } = sharedDoc.data();
            if (!ownerUid || !experimentId) return null;
            try {
                const expSnap = await getDoc(doc(db, 'users', ownerUid, 'experiments', experimentId));
                if (!expSnap.exists()) return null;
                return { id: experimentId, ownerUid, isShared: true, ...expSnap.data() };
            } catch {
                return null;
            }
        });

        const sharedResults = (await Promise.all(sharedFetches)).filter(Boolean);

        allExperiments = [...myExperiments, ...sharedResults];

        // --- Render ---
        renderAll(myExperiments.length, sharedResults.length);

        if (loadingEl) loadingEl.style.display = 'none';
        if (contentEl) contentEl.classList.remove('hidden');

    } catch (err) {
        console.error('loadAndRender:', err);
        showToast('שגיאה בטעינת הנתונים', 'error');
        if (loadingEl) loadingEl.style.display = 'none';
    }
}

// ======================================================
// Render orchestrator
// ======================================================
function renderAll(ownCount, sharedCount) {
    const exps = allExperiments;

    // ownership badges
    setText('own-count',    ownCount);
    setText('shared-count', sharedCount);

    // KPIs
    setText('kpi-total',    exps.length);
    setText('kpi-sites',    countUnique(exps, e => norm(e.experimentSite)));
    setText('kpi-varieties',countUnique(exps, e => norm(cropField(e, 'variety'))));
    setText('kpi-keywords', countUniqueFlat(exps, e => Array.isArray(e.keywords) ? e.keywords : []));
    setText('kpi-packages', countUnique(exps, e => norm(e.workPackage)));

    // Charts (client-side only)
    renderChartByYear(exps);
    renderChartBySite(exps);
    renderChartByPackage(exps);
    renderChartByCrop(exps);

    // Keywords
    renderKeywordsCloud(exps);

    // Table
    renderExperimentsTable(exps);

    // Timestamp
    const label = document.getElementById('last-updated-label');
    if (label) label.textContent = `עודכן: ${new Date().toLocaleString('he-IL')}`;
}

// ======================================================
// Charts
// ======================================================
function renderChartByYear(exps) {
    const freq   = freqMap(exps, e => e.experimentYear ? String(e.experimentYear) : 'לא צוין');
    const sorted = Object.entries(freq).sort((a, b) => a[0].localeCompare(b[0]));
    drawBarChart('chart-by-year', sorted.map(x => x[0]), sorted.map(x => x[1]), '#3b82f6');
}

function renderChartBySite(exps) {
    const freq   = freqMap(exps, e => norm(e.experimentSite) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-site', sorted.map(x => x[0]), sorted.map(x => x[1]), '#d97706');
}

function renderChartByPackage(exps) {
    const freq   = freqMap(exps, e => norm(e.workPackage) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawDoughnutChart('chart-by-package', sorted.map(x => x[0]), sorted.map(x => x[1]));
}

function renderChartByCrop(exps) {
    const freq   = freqMap(exps, e => norm(cropField(e, 'cropType')) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-crop', sorted.map(x => x[0]), sorted.map(x => x[1]), '#16a34a');
}

// ======================================================
// Keywords Cloud
// ======================================================
function renderKeywordsCloud(exps) {
    const freq = {};
    exps.forEach(e => {
        (Array.isArray(e.keywords) ? e.keywords : []).forEach(k => {
            const key = norm(k);
            if (key) freq[key] = (freq[key] || 0) + 1;
        });
    });

    const container = document.getElementById('keywords-cloud');
    if (!container) return;

    if (!Object.keys(freq).length) {
        container.innerHTML = '<span class="no-data">אין מילות מפתח עדיין</span>';
        return;
    }

    const max     = Math.max(...Object.values(freq));
    const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);

    container.innerHTML = entries.map(([word, count]) => {
        const cls = getSizeClass(count, max);
        return `<span class="kw-tag ${cls}" title="${count} ניסויים">${escHtml(word)}</span>`;
    }).join('');
}

function getSizeClass(count, max) {
    const r = count / max;
    if (r > 0.8) return 'size-5';
    if (r > 0.6) return 'size-4';
    if (r > 0.4) return 'size-3';
    if (r > 0.2) return 'size-2';
    return '';
}

// ======================================================
// Experiments Table
// ======================================================
function renderExperimentsTable(exps) {
    const tbody = document.getElementById('experiments-table-body');
    if (!tbody) return;

    if (!exps.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="no-data">אין ניסויים להצגה</td></tr>';
        return;
    }

    const sorted = [...exps].sort((a, b) => {
        const da = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(0);
        const db_ = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(0);
        return db_ - da;
    });

    tbody.innerHTML = sorted.map(e => {
        const href = e.isShared
            ? `experiment.html?id=${e.id}&owner=${e.ownerUid}`
            : `experiment.html?id=${e.id}`;
        const badge = e.isShared
            ? '<span class="tag-shared">שותף/ה</span>'
            : '<span class="tag-own">שלי</span>';
        return `
          <tr>
            <td><a class="exp-link" href="${href}">${escHtml(e.experimentName || 'ללא שם')}</a></td>
            <td>${e.experimentYear || '-'}</td>
            <td>${escHtml(norm(e.experimentSite) || '-')}</td>
            <td>${escHtml(norm(e.workPackage) || '-')}</td>
            <td>${badge}</td>
          </tr>`;
    }).join('');
}

// ======================================================
// Chart Factory Helpers
// ======================================================
const PALETTE = [
    '#4f46e5','#0ea5e9','#16a34a','#d97706','#e11d48',
    '#7c3aed','#0891b2','#65a30d','#f59e0b','#ef4444',
    '#8b5cf6','#06b6d4','#84cc16','#f97316','#ec4899'
];

function drawBarChart(canvasId, labels, data, color) {
    const ctx = getCtx(canvasId);
    if (!ctx) return;
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data, backgroundColor: color, borderRadius: 6, maxBarThickness: 40 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { font: { family: 'Heebo' }, color: '#374151' } },
                y: { beginAtZero: true, ticks: { font: { family: 'Heebo' }, precision: 0 } }
            }
        }
    });
}

function drawHBarChart(canvasId, labels, data, color) {
    const ctx = getCtx(canvasId);
    if (!ctx) return;
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data, backgroundColor: color, borderRadius: 4, maxBarThickness: 26 }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, ticks: { font: { family: 'Heebo' }, precision: 0 } },
                y: { ticks: { font: { family: 'Heebo' }, color: '#374151' } }
            }
        }
    });
}

function drawDoughnutChart(canvasId, labels, data) {
    const ctx = getCtx(canvasId);
    if (!ctx) return;
    new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: PALETTE.slice(0, labels.length),
                borderWidth: 2,
                borderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: { font: { family: 'Heebo', size: 12 }, padding: 10, boxWidth: 14 }
                }
            }
        }
    });
}

// ======================================================
// Data Helpers
// ======================================================
function cropField(exp, field) {
    return exp?.cropDetails?.data?.[field] ?? exp?.[field] ?? '';
}

function norm(val) { return (val || '').trim() || null; }

function freqMap(exps, keyFn) {
    const map = {};
    exps.forEach(e => {
        const k = keyFn(e);
        if (k != null) map[k] = (map[k] || 0) + 1;
    });
    return map;
}

function sortedEntries(freq, topN = 10) {
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, topN);
}

function countUnique(exps, keyFn) {
    return new Set(exps.map(keyFn).filter(Boolean)).size;
}

function countUniqueFlat(exps, listFn) {
    const set = new Set();
    exps.forEach(e => listFn(e).forEach(k => { const n = norm(k); if (n) set.add(n); }));
    return set.size;
}

// ======================================================
// DOM Helpers
// ======================================================
function getCtx(id) {
    const el = document.getElementById(id);
    return el ? el.getContext('2d') : null;
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function escHtml(str) {
    return String(str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ======================================================
// Logout
// ======================================================
async function handleLogout() {
    try { await signOut(auth); window.location.href = 'login.html'; }
    catch (e) { console.error(e); }
}
