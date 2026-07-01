// js/my-bi-2-test.js  –  גרסת בדיקה משודרגת – לוח BI אישי למשתמש הרגיל
// ==============================================================
// עותק עצמאי ומשודרג של my-bi.js לבדיקה. לא נוגע בקובץ המקורי.
// הרחבות: KPIs נוספים, תרשימים חדשים (סוג מחקר, חודש, חוקר, משתלה),
// טבלת חוקרים מובילים, רשימת שותפים, עיצוב מודרני.
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
import { siteLabel, packageLabel } from "./labels.js";

let currentUser = null;
let userData    = null;
/** @type {Array<{id:string, ownerUid:string, isShared:boolean, [key:string]:any}>} */
let allExperiments = [];


const STUDY_TYPE_LABELS = {
    field: 'שדה',
    lab: 'מעבדה'
};
function studyTypeLabel(code) { return STUDY_TYPE_LABELS[code] || 'לא צוין'; }

const MONTH_LABELS = [
    'ינואר','פברואר','מרץ','אפריל','מאי','יוני',
    'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'
];

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
            const sharedData = sharedDoc.data();
            const { ownerUid, experimentId, cachedExperiment } = sharedData;
            if (!ownerUid || !experimentId) return null;

            if (cachedExperiment && typeof cachedExperiment === 'object') {
                return {
                    id: experimentId,
                    ownerUid,
                    isShared: true,
                    ...cachedExperiment
                };
            }

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

        if (loadingEl) loadingEl.style.display = 'none';
        if (contentEl) contentEl.classList.remove('hidden');

        // --- Render after content is visible (Leaflet needs visible container) ---
        renderAll(myExperiments.length, sharedResults.length);

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

    // KPIs – row 1 (existing metrics)
    setText('kpi-total',    exps.length);
    setText('kpi-sites',    countUnique(exps, e => siteLabel(e.experimentSite)));
    setText('kpi-varieties',countUniqueFlat(exps, e => cropVarieties(e)));
    setText('kpi-keywords', countUniqueFlat(exps, e => Array.isArray(e.keywords) ? e.keywords : []));
    setText('kpi-packages', countUnique(exps, e => packageLabel(norm(e.workPackage))));

    // KPIs – row 2 (NEW metrics)
    const fieldCount = exps.filter(e => norm(e.studyType) === 'field').length;
    const labCount   = exps.filter(e => norm(e.studyType) === 'lab').length;
    setText('kpi-field', fieldCount);
    setText('kpi-lab',   labCount);
    setText('kpi-researchers', countUnique(exps, e => norm(e.leadResearcher)));
    setText('kpi-partners',     countUniqueFlat(exps, e => partnerNames(e)));
    setText('kpi-treatments',   sumNumber(exps, e => num(e.treatmentsCount)));
    setText('kpi-repetitions',  sumNumber(exps, e => num(e.repetitionsCount)));
    setText('kpi-events',       sumNumber(exps, e => Array.isArray(e.events) ? e.events.length : 0));
    setText('kpi-maps',         exps.filter(e => e.researchMap && e.researchMap.downloadURL).length);

    // Charts (client-side only)
    renderChartByYear(exps);
    renderChartBySite(exps);
    renderChartByPackage(exps);
    renderChartByCrop(exps);
    renderChartByStudyType(exps);
    renderChartByMonth(exps);
    renderChartByResearcher(exps);
    renderChartByNursery(exps);

    // Map
    renderExperimentsMap(exps);

    // Keywords
    renderKeywordsCloud(exps);

    // Tables
    renderExperimentsTable(exps);
    renderResearchersTable(exps);
    renderPartnersTable(exps);

    // Timestamp
    const label = document.getElementById('last-updated-label');
    if (label) label.textContent = `עודכן: ${new Date().toLocaleString('he-IL')}`;
}

// ======================================================
// Render Map – from experiments siteCoordinates
// ======================================================
function renderExperimentsMap(exps) {
    const mapContainer = document.getElementById('experiments-map');
    if (!mapContainer) return;

    mapContainer.innerHTML = '';

    // Parse coordinates from already-loaded experiment docs (no extra Firestore reads)
    const expsWithCoords = exps
        .map(exp => {
            const coordinates = parseExperimentCoordinates(exp);
            return coordinates ? { exp, ...coordinates } : null;
        })
        .filter(Boolean);

    if (expsWithCoords.length === 0) {
        mapContainer.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#9ca3af;font-size:16px;text-align:center;padding:20px;direction:rtl;">
                <div>
                    <div style="font-size:32px;margin-bottom:8px;">📍</div>
                    <strong>לא היתה אפשרות להציג את המפה</strong>
                    <div style="font-size:13px;margin-top:8px;color:#d1d5db;">אין קואורדינטות בניסויים</div>
                </div>
            </div>
        `;
        return;
    }

    // Initialize map centered on Israel
    const map = L.map(mapContainer).setView([31.5, 34.75], 7);

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // Add marker for each experiment
    const markers = [];
    expsWithCoords.forEach(({ exp, lat, lng }) => {
        const color = exp.isShared ? '#3b82f6' : '#16a34a';

        const marker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'experiment-marker',
                html: `<div style="width:32px;height:32px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.25);"><i class="fas fa-flask" style="color:#fff;font-size:13px;"></i></div>`,
                iconSize: [32, 32],
                iconAnchor: [16, 16],
                popupAnchor: [0, -14]
            })
        }).addTo(map);

        // Popup with experiment name and site
        const expName = escHtml(norm(exp.experimentName) || 'ללא שם');
        const siteName = escHtml(siteLabel(exp.experimentSite) || 'לא צוין');
        
        marker.bindPopup(`
            <div style="font-family: 'Heebo', sans-serif; text-align: right; direction: rtl; min-width: 180px;">
                <strong style="font-size: 13px; color: #1a1a1a; display: block; margin-bottom: 4px;">🧪 ${expName}</strong>
                <span style="font-size: 12px; color: #6b7280;">📍 אתר: ${siteName}</span><br/>
                <span style="font-size: 11px; color: #9ca3af;">קואורדינטות: ${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
            </div>
        `);

        markers.push(marker);
    });

    addMapScaleControl(map);
    addMapHelpControl(map, {
        title: 'הוראות מהירות',
        lines: [
            'לחיצה על סמן פותחת פרטי ניסוי',
            'ניתן להתקרב/להתרחק עם גלגלת העכבר',
            'כפתור 🎯 מחזיר תצוגה לכל הניסויים'
        ]
    });

    const ownCount = expsWithCoords.filter(x => !x.exp.isShared).length;
    const sharedCount = expsWithCoords.filter(x => x.exp.isShared).length;
    addMapLegendControl(map, {
        total: expsWithCoords.length,
        own: ownCount,
        shared: sharedCount,
        showOwnership: true
    });

    // Auto-fit map to show all markers
    if (markers.length > 0) {
        const group = new L.featureGroup(markers);
        const bounds = group.getBounds().pad(0.1);
        map.fitBounds(bounds);
        addMapResetViewControl(map, bounds);
    }
}

function addMapScaleControl(map) {
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);
}

function addMapHelpControl(map, config) {
    const control = L.control({ position: 'topleft' });
    control.onAdd = () => {
        const div = L.DomUtil.create('div');
        div.style.background = '#fff';
        div.style.padding = '10px 12px';
        div.style.borderRadius = '10px';
        div.style.boxShadow = '0 1px 6px rgba(0,0,0,.2)';
        div.style.minWidth = '220px';
        div.style.direction = 'rtl';
        div.style.fontFamily = 'Heebo, sans-serif';
        div.innerHTML = `
            <div style="font-weight:700;font-size:13px;color:#1f2937;margin-bottom:6px;">💡 ${escHtml(config.title)}</div>
            <ul style="margin:0;padding:0 16px 0 0;color:#4b5563;font-size:12px;line-height:1.45;">
                ${config.lines.map(line => `<li style="margin-bottom:2px;">${escHtml(line)}</li>`).join('')}
            </ul>
        `;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    control.addTo(map);
}

function addMapLegendControl(map, stats) {
    const control = L.control({ position: 'topright' });
    control.onAdd = () => {
        const div = L.DomUtil.create('div');
        div.style.background = '#fff';
        div.style.padding = '10px 12px';
        div.style.borderRadius = '10px';
        div.style.boxShadow = '0 1px 6px rgba(0,0,0,.2)';
        div.style.minWidth = '180px';
        div.style.direction = 'rtl';
        div.style.fontFamily = 'Heebo, sans-serif';

        const ownershipRows = stats.showOwnership ? `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;font-size:12px;color:#1f2937;">
                <span>🟦 שותף/ה</span><strong>${stats.shared}</strong>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;font-size:12px;color:#1f2937;">
                <span>🟩 שלי</span><strong>${stats.own}</strong>
            </div>
        ` : '';

        div.innerHTML = `
            <div style="font-weight:700;font-size:13px;color:#1f2937;margin-bottom:6px;">🧪 מקרא</div>
            <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#1f2937;">
                <span style="width:22px;height:22px;border-radius:50%;background:#3b82f6;color:#fff;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.2);font-size:11px;">⚗</span>
                <span>מיקום ניסוי</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;font-size:12px;color:#1f2937;">
                <span>סה"כ על המפה</span><strong>${stats.total}</strong>
            </div>
            ${ownershipRows}
        `;

        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    control.addTo(map);
}

function addMapResetViewControl(map, bounds) {
    const control = L.control({ position: 'bottomright' });
    control.onAdd = () => {
        const button = L.DomUtil.create('button');
        button.type = 'button';
        button.title = 'מיקוד לכל הניסויים';
        button.style.width = '38px';
        button.style.height = '38px';
        button.style.border = 'none';
        button.style.borderRadius = '10px';
        button.style.cursor = 'pointer';
        button.style.background = '#2563eb';
        button.style.color = '#fff';
        button.style.fontSize = '18px';
        button.style.boxShadow = '0 1px 6px rgba(0,0,0,.25)';
        button.textContent = '🎯';
        L.DomEvent.disableClickPropagation(button);
        L.DomEvent.on(button, 'click', () => map.fitBounds(bounds));
        return button;
    };
    control.addTo(map);
}

function parseExperimentCoordinates(exp) {
    const direct = parseCoordinatesValue(exp?.siteCoordinates);
    if (direct) return direct;

    const nested = parseCoordinatesValue(exp?.locationCoordinates);
    if (nested) return nested;

    return null;
}

function parseCoordinatesValue(value) {
    if (!value) return null;

    if (typeof value === 'string') {
        const cleaned = value.replace(/[()\[\]]/g, '').replace(';', ',');
        const parts = cleaned.split(',').map(p => parseFloat(p.trim()));
        if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
        return validateLatLng(parts[0], parts[1]);
    }

    if (typeof value === 'object') {
        const rawLat = value.lat ?? value.latitude;
        const rawLng = value.lng ?? value.lon ?? value.longitude;
        const lat = Number(rawLat);
        const lng = Number(rawLng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
        return validateLatLng(lat, lng);
    }

    return null;
}

function validateLatLng(lat, lng) {
    if (lat < -90 || lat > 90) return null;
    if (lng < -180 || lng > 180) return null;
    return { lat, lng };
}

// ======================================================
// Chart Renderers
// ======================================================
// On-brand restrained palette (navy primary + tonal blues + semantic accents)
const CHART_NAVY   = '#18408d';
const CHART_GREEN   = '#0f7a39';
const CHART_AMBER   = '#b45309';
const CHART_TEAL    = '#0d6674';

function renderChartByYear(exps) {
    const freq   = freqMap(exps, e => e.experimentYear ? String(e.experimentYear) : 'לא צוין');
    const sorted = Object.entries(freq).sort((a, b) => a[0].localeCompare(b[0]));
    drawBarChart('chart-by-year', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_NAVY);
}

function renderChartBySite(exps) {
    const freq   = freqMap(exps, e => siteLabel(e.experimentSite) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-site', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_AMBER);
}

function renderChartByPackage(exps) {
    const freq   = freqMap(exps, e => packageLabel(norm(e.workPackage)) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-package', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_NAVY);
}

function renderChartByCrop(exps) {
    const freq   = freqMap(exps, e => norm(cropField(e, 'cropType')) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-crop', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_GREEN);
}

// NEW – study type (field/lab)
function renderChartByStudyType(exps) {
    const freq   = freqMap(exps, e => studyTypeLabel(norm(e.studyType)));
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    drawBarChart('chart-by-study-type', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_NAVY);
}

// NEW – experiments by month
function renderChartByMonth(exps) {
    const freq = {};
    MONTH_LABELS.forEach(m => freq[m] = 0);
    exps.forEach(e => {
        const m = num(e.experimentMonth);
        if (m >= 1 && m <= 12) freq[MONTH_LABELS[m - 1]] += 1;
    });
    const entries = MONTH_LABELS.map(m => [m, freq[m]]);
    drawBarChart('chart-by-month', entries.map(x => x[0]), entries.map(x => x[1]), CHART_TEAL);
}

// NEW – experiments by lead researcher
function renderChartByResearcher(exps) {
    const freq   = freqMap(exps, e => norm(e.leadResearcher) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-researcher', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_NAVY);
}

// NEW – experiments by nursery
function renderChartByNursery(exps) {
    const freq   = freqMap(exps, e => norm(cropField(e, 'nursery')) || 'לא צוין');
    const sorted = sortedEntries(freq, 8);
    drawHBarChart('chart-by-nursery', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_GREEN);
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
// Experiments Table (expanded with more columns)
// ======================================================
function renderExperimentsTable(exps) {
    const tbody = document.getElementById('experiments-table-body');
    if (!tbody) return;

    if (!exps.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="no-data">אין ניסויים להצגה</td></tr>';
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
        const studyBadge = norm(e.studyType) === 'lab'
            ? '<span class="tag-lab">מעבדה</span>'
            : norm(e.studyType) === 'field'
                ? '<span class="tag-field">שדה</span>'
                : '<span class="tag-muted">—</span>';
        const treatments = num(e.treatmentsCount);
        const reps = num(e.repetitionsCount);
        const researcher = escHtml(norm(e.leadResearcher) || '-');
        return `
          <tr>
            <td><a class="exp-link" href="${href}">${escHtml(e.experimentName || 'ללא שם')}</a></td>
            <td>${e.experimentYear || '-'}</td>
            <td>${escHtml(siteLabel(e.experimentSite) || '-')}</td>
            <td>${researcher}</td>
            <td>${escHtml(packageLabel(norm(e.workPackage)) || '-')}</td>
            <td>${treatments ? treatments : '-'}</td>
            <td>${studyBadge}</td>
            <td>${badge}</td>
          </tr>`;
    }).join('');
}

// ======================================================
// NEW – Researchers Ranking (rank-bar list, matches bi.html pattern)
// ======================================================
function renderResearchersTable(exps) {
    const list = document.getElementById('researchers-ranking');
    if (!list) return;

    const freq = {};
    exps.forEach(e => {
        const name = norm(e.leadResearcher);
        if (!name) return;
        if (!freq[name]) freq[name] = { total: 0, field: 0, lab: 0 };
        freq[name].total += 1;
        if (norm(e.studyType) === 'field') freq[name].field += 1;
        if (norm(e.studyType) === 'lab')   freq[name].lab   += 1;
    });

    const entries = Object.entries(freq).sort((a, b) => b[1].total - a[1].total);

    if (!entries.length) {
        list.innerHTML = '<li class="no-data">אין חוקרים מובילים להצגה</li>';
        return;
    }

    const max = entries[0][1].total;
    list.innerHTML = entries.map(([name, stats], i) => {
        const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
        const pct = Math.round((stats.total / max) * 100);
        return `
          <li class="ranking-item">
            <span class="rank-num ${medal}">${i + 1}</span>
            <div class="rank-bar-wrap">
                <div class="rank-name">${escHtml(name)}</div>
                <div class="rank-bar"><div class="rank-bar-fill" style="width:${pct}%"></div></div>
            </div>
            <span class="rank-count">${stats.total}</span>
          </li>`;
    }).join('');
}

// ======================================================
// NEW – Partners Ranking (rank-bar list)
// ======================================================
function renderPartnersTable(exps) {
    const list = document.getElementById('partners-ranking');
    if (!list) return;

    const freq = {};
    exps.forEach(e => {
        partnerNames(e).forEach(name => {
            const n = norm(name);
            if (!n) return;
            freq[n] = (freq[n] || 0) + 1;
        });
    });

    const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);

    if (!entries.length) {
        list.innerHTML = '<li class="no-data">אין שותפים להצגה</li>';
        return;
    }

    const max = entries[0][1];
    list.innerHTML = entries.map(([name, count], i) => {
        const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
        const pct = Math.round((count / max) * 100);
        return `
          <li class="ranking-item">
            <span class="rank-num ${medal}">${i + 1}</span>
            <div class="rank-bar-wrap">
                <div class="rank-name">${escHtml(name)}</div>
                <div class="rank-bar"><div class="rank-bar-fill" style="width:${pct}%"></div></div>
            </div>
            <span class="rank-count">${count}</span>
          </li>`;
    }).join('');
}

// ======================================================
// Chart Factory Helpers – bar charts only, professional styling
// ======================================================
// Tonal navy/blue palette – professional, on-brand (no rainbow)
const PALETTE = [
    '#18408d', '#2e6bd6', '#5b8def', '#8aaef5', '#b4cef9',
    '#0a2f72', '#1d4ed8', '#4f46e5', '#0d6674', '#0e7490',
    '#0f7a39', '#15803d', '#b45309', '#9a3412', '#475569'
];

const FONT_FAM   = "'Heebo', sans-serif";
const GRID_COLOR = 'rgba(180, 192, 210, 0.35)';
const TICK_COLOR = '#607089';

function drawBarChart(canvasId, labels, data, color) {
    const ctx = getCtx(canvasId);
    if (!ctx) return;
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: color,
                maxBarThickness: 44
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#182230',
                    titleFont: { family: FONT_FAM, weight: '600' },
                    bodyFont: { family: FONT_FAM },
                    padding: 10,
                    cornerRadius: 6,
                    displayColors: false
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    border: { color: GRID_COLOR },
                    ticks: { font: { family: FONT_FAM, size: 11 }, color: TICK_COLOR }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: GRID_COLOR, drawTicks: false },
                    border: { display: false },
                    ticks: { font: { family: FONT_FAM, size: 11 }, color: TICK_COLOR, precision: 0, padding: 6 }
                }
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
                backgroundColor: color,
                maxBarThickness: 26
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#182230',
                    titleFont: { family: FONT_FAM, weight: '600' },
                    bodyFont: { family: FONT_FAM },
                    padding: 10,
                    cornerRadius: 6,
                    displayColors: false
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: GRID_COLOR, drawTicks: false },
                    border: { display: false },
                    ticks: { font: { family: FONT_FAM, size: 11 }, color: TICK_COLOR, precision: 0, padding: 6 }
                },
                y: {
                    grid: { display: false },
                    border: { color: GRID_COLOR },
                    ticks: { font: { family: FONT_FAM, size: 11 }, color: '#344054', autoSkip: false }
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

function cropVarieties(exp) {
    const cropData = exp?.cropDetails?.data || exp || {};
    const fromArray = Array.isArray(cropData.varieties) ? cropData.varieties : [];
    if (fromArray.length) return fromArray.map((v) => String(v || '').trim()).filter(Boolean);
    const single = String(cropData.variety || '').trim();
    return single ? [single] : [];
}

function partnerNames(exp) {
    const arr = Array.isArray(exp?.partners) ? exp.partners : [];
    return arr.map(p => String(p?.name || '').trim()).filter(Boolean);
}

function num(val) {
    const n = Number(val);
    return Number.isFinite(n) ? n : 0;
}

function sumNumber(exps, valFn) {
    return exps.reduce((acc, e) => acc + valFn(e), 0);
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
