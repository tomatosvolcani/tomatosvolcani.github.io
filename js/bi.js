// js/bi.js  –  לוח Business Intelligence
// ===========================================================
// טעינת כל הניסויים בקריאה אחת (collectionGroup),
// ניתוח הנתונים בצד הלקוח ולא קריאות חוזרות ל-Firestore.
// ===========================================================
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc,
    getDoc,
    collectionGroup,
    query,
    getDocs,
    collection,
    limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from "./toast.js";

let currentUser = null;
/** @type {Array<Object>} - כל הניסויים שנטענו */
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
    if (!user) { window.location.href = "login.html"; return; }
    currentUser = user;
    await loadUserInfo();
    await loadAndRender();
});

// ======================================================
// Sidebar + hamburger
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
            if (icon) {
                icon.classList.toggle('fa-bars');
                icon.classList.toggle('fa-times');
            }
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
// Load User Info + Admin guard
// ======================================================
async function loadUserInfo() {
    const nameEl = document.getElementById('user-display-name');
    try {
        const snap = await getDoc(doc(db, "users", currentUser.uid));
        if (snap.exists()) {
            const d = snap.data();
            if (nameEl) nameEl.textContent = `${d.firstName || ''} ${d.lastName || ''}`.trim() || currentUser.email;
        }
    } catch (e) {
        console.error("loadUserInfo:", e);
    }
}

// ======================================================
// Main: Load all experiments once → analyse client-side
// ======================================================
async function loadAndRender() {
    const loadingEl = document.getElementById('loading-container');
    const contentEl = document.getElementById('bi-content');

    try {
        // ---- One Firestore read ----
        const q          = query(collectionGroup(db, 'experiments'));
        const snapshot   = await getDocs(q);

        allExperiments = [];
        snapshot.forEach(docSnap => {
            const d = docSnap.data();
            allExperiments.push({ id: docSnap.id, ...d });
        });

        // ---- Analyse + render ----
        renderAll();

        // Hide loading, show content
        if (loadingEl) loadingEl.style.display = 'none';
        if (contentEl) contentEl.classList.remove('hidden');

    } catch (err) {
        console.error("loadAndRender:", err);
        if (err.code === 'permission-denied') {
            showToast('אין הרשאות גישה לדף זה. נדרשות הרשאות מנהל.', 'error');
        } else {
            showToast('שגיאה בטעינת נתונים', 'error');
        }
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 2000);
    }
}

// ======================================================
// Orchestrate all renders
// ======================================================
function renderAll() {
    const exps = allExperiments;

    // KPIs
    renderKPIs(exps);

    // Charts
    renderChartByYear(exps);
    renderChartByPackage(exps);
    renderChartBySite(exps);
    renderChartByCrop(exps);

    // Rankings / tables
    renderResearchersRanking(exps);
    renderVarietiesRanking(exps);
    renderKeywordsCloud(exps);

    // Timestamp
    const label = document.getElementById('last-updated-label');
    if (label) label.textContent = `עודכן: ${new Date().toLocaleString('he-IL')}`;
}

// ======================================================
// KPI Cards
// ======================================================
function renderKPIs(exps) {
    setText('kpi-total',       exps.length);
    setText('kpi-researchers', countUnique(exps, e => e.leadResearcher));
    setText('kpi-sites',       countUnique(exps, e => norm(e.experimentSite)));
    setText('kpi-varieties',   countUnique(exps, e => norm(cropField(e, 'variety'))));
    setText('kpi-keywords',    countUniqueFlat(exps, e => Array.isArray(e.keywords) ? e.keywords : []));
}

// ======================================================
// Chart: Experiments per Year
// ======================================================
function renderChartByYear(exps) {
    const freq = freqMap(exps, e => e.experimentYear ? String(e.experimentYear) : 'לא צוין');
    const sorted = Object.entries(freq).sort((a, b) => a[0].localeCompare(b[0]));
    const labels = sorted.map(x => x[0]);
    const data   = sorted.map(x => x[1]);

    drawBarChart('chart-by-year', labels, data, {
        color: '#3b82f6',
        xLabel: 'שנה',
        yLabel: 'ניסויים'
    });
}

// ======================================================
// Chart: Experiments per Work Package
// ======================================================
function renderChartByPackage(exps) {
    const freq = freqMap(exps, e => norm(e.workPackage) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawDoughnutChart('chart-by-package', sorted.map(x => x[0]), sorted.map(x => x[1]));
}

// ======================================================
// Chart: Experiments per Site
// ======================================================
function renderChartBySite(exps) {
    const freq = freqMap(exps, e => norm(e.experimentSite) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-site', sorted.map(x => x[0]), sorted.map(x => x[1]), '#16a34a');
}

// ======================================================
// Chart: Crop Types
// ======================================================
function renderChartByCrop(exps) {
    const freq = freqMap(exps, e => norm(cropField(e, 'cropType')) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-crop', sorted.map(x => x[0]), sorted.map(x => x[1]), '#d97706');
}

// ======================================================
// Ranking: Researchers
// ======================================================
function renderResearchersRanking(exps) {
    const freq = freqMap(exps, e => norm(e.leadResearcher) || 'לא צוין');
    renderRankingList('researchers-ranking', freq);
}

// ======================================================
// Ranking: Varieties
// ======================================================
function renderVarietiesRanking(exps) {
    const freq = freqMap(exps, e => norm(cropField(e, 'variety')) || 'לא צוין');
    renderRankingList('varieties-ranking', freq);
}

// ======================================================
// Keywords Cloud
// ======================================================
function renderKeywordsCloud(exps) {
    const freq = {};
    exps.forEach(e => {
        const kws = Array.isArray(e.keywords) ? e.keywords : [];
        kws.forEach(k => {
            const key = norm(k);
            if (key) freq[key] = (freq[key] || 0) + 1;
        });
    });

    const container = document.getElementById('keywords-cloud');
    if (!container) return;

    if (!Object.keys(freq).length) {
        container.innerHTML = '<span class="no-data">אין מילות מפתח</span>';
        return;
    }

    const maxCount = Math.max(...Object.values(freq));
    const entries  = Object.entries(freq).sort((a, b) => b[1] - a[1]);

    container.innerHTML = entries.map(([word, count]) => {
        const sizeClass = getSizeClass(count, maxCount);
        return `<span class="kw-tag ${sizeClass}" title="${count} ניסויים">${word}</span>`;
    }).join('');
}

function getSizeClass(count, max) {
    const ratio = count / max;
    if (ratio > 0.8) return 'size-5';
    if (ratio > 0.6) return 'size-4';
    if (ratio > 0.4) return 'size-3';
    if (ratio > 0.2) return 'size-2';
    return '';
}

// ======================================================
// Render Helpers
// ======================================================

/** גנרי: מצייר רשימת דירוג עם bars */
function renderRankingList(elId, freq) {
    const ul = document.getElementById(elId);
    if (!ul) return;

    const entries = sortedEntries(freq, 10);
    if (!entries.length) {
        ul.innerHTML = '<li class="no-data">אין נתונים</li>';
        return;
    }

    const max = entries[0][1];
    ul.innerHTML = entries.map(([name, count], i) => {
        const pct = Math.round((count / max) * 100);
        const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
        return `
          <li class="ranking-item">
            <span class="rank-num ${rankClass}">${i + 1}</span>
            <div class="rank-bar-wrap">
              <div class="rank-name">${escHtml(name)}</div>
              <div class="rank-bar">
                <div class="rank-bar-fill" style="width:${pct}%"></div>
              </div>
            </div>
            <span class="rank-count">${count}</span>
          </li>`;
    }).join('');
}

// ======================================================
// Chart Factory Helpers (Chart.js)
// ======================================================

const PALETTE = [
    '#4f46e5','#0ea5e9','#16a34a','#d97706','#e11d48',
    '#7c3aed','#0891b2','#65a30d','#f59e0b','#ef4444',
    '#8b5cf6','#06b6d4','#84cc16','#f97316','#ec4899'
];

function drawBarChart(canvasId, labels, data, opts = {}) {
    const ctx = getCtx(canvasId);
    if (!ctx) return;
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: opts.color || '#4f46e5',
                borderRadius: 6,
                maxBarThickness: 40
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { font: { family: 'Heebo' }, color: '#374151' } },
                y: { beginAtZero: true, ticks: { font: { family: 'Heebo' }, color: '#374151', precision: 0 } }
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
            datasets: [{
                data,
                backgroundColor: color || '#0ea5e9',
                borderRadius: 4,
                maxBarThickness: 28
            }]
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

/** שדה מ-cropDetails.data */
function cropField(exp, field) {
    return exp?.cropDetails?.data?.[field] ?? exp?.[field] ?? '';
}

/** נרמול מחרוזת */
function norm(val) {
    return (val || '').trim() || null;
}

/** תדירות: { שדה → כמות } */
function freqMap(exps, keyFn) {
    const map = {};
    exps.forEach(e => {
        const k = keyFn(e);
        if (k != null) map[k] = (map[k] || 0) + 1;
    });
    return map;
}

/** ממיין ומחזיר topN */
function sortedEntries(freq, topN = 10) {
    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN);
}

/** ספירת ייחודיים לפי key function */
function countUnique(exps, keyFn) {
    return new Set(exps.map(keyFn).filter(Boolean)).size;
}

/** ספירת ייחודיים ברשימות (כמו keywords) */
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
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ======================================================
// Logout
// ======================================================
async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (e) {
        console.error(e);
    }
}
