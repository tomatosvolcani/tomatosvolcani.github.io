// js/my-bi.js  –  לוח BI אישי למשתמש הרגיל
// ==============================================================
// עותק רשמי. לוח BI אישי למשתמש הרגיל.
// הרחבות: KPIs נוספים, תרשימים חדשים (סוג מחקר, חודש, חוקר, משתלה),
// עיצוב מודרני עם פלטת accent מרוסנת.
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

const prefersReducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;


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
// Single-pass aggregation
// ======================================================
// Walk the experiments array ONCE and build every frequency map, unique set
// and running sum the dashboard needs. All KPIs, charts and ranking lists then
// read from this object instead of re-iterating the array ~15 times.
function computeStats(exps) {
    const stats = {
        total: exps.length,
        ownCount: 0,
        fieldCount: 0,
        labCount: 0,
        sumTreatments: 0,
        sumRepetitions: 0,
        sumEvents: 0,
        mapCount: 0,
        // unique-value sets (drive the "distinct X" KPIs)
        siteSet: new Set(),
        packageSet: new Set(),
        varietySet: new Set(),
        keywordSet: new Set(),
        // frequency maps (drive the charts)
        freqYear: {},
        freqSite: {},
        freqPackage: {},
        freqCrop: {},
        freqStudyType: {},
        freqResearcher: {},
        freqNursery: {},
        freqKeyword: {},
        freqVariety: {},
        monthCounts: new Array(12).fill(0),
        effortByPackage: {},   // label -> { treatments, repetitions }
        researcherStats: {},   // name  -> { total, field, lab }
        partnerStats: {}       // name  -> count
    };

    const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };

    exps.forEach(e => {
        // ownership
        if (!e.isShared) stats.ownCount += 1;

        // study type
        const study = norm(e.studyType);
        if (study === 'field') stats.fieldCount += 1;
        if (study === 'lab')   stats.labCount += 1;
        bump(stats.freqStudyType, studyTypeLabel(study));

        // running sums
        const treatments  = num(e.treatmentsCount);
        const repetitions = num(e.repetitionsCount);
        stats.sumTreatments  += treatments;
        stats.sumRepetitions += repetitions;
        stats.sumEvents      += Array.isArray(e.events) ? e.events.length : 0;
        if (e.researchMap && e.researchMap.downloadURL) stats.mapCount += 1;

        // year (missing → 'לא צוין' bucket for the by-year chart)
        bump(stats.freqYear, e.experimentYear ? String(e.experimentYear) : 'לא צוין');

        // site
        const site = siteLabel(e.experimentSite);
        if (site) stats.siteSet.add(site);
        bump(stats.freqSite, site || 'לא צוין');

        // work-package + effort breakdown
        const pkg = packageLabel(norm(e.workPackage));
        if (pkg) stats.packageSet.add(pkg);
        const pkgKey = pkg || 'לא צוין';
        bump(stats.freqPackage, pkgKey);
        if (!stats.effortByPackage[pkgKey]) stats.effortByPackage[pkgKey] = { treatments: 0, repetitions: 0 };
        stats.effortByPackage[pkgKey].treatments  += treatments;
        stats.effortByPackage[pkgKey].repetitions += repetitions;

        // crop + nursery
        bump(stats.freqCrop,    norm(cropField(e, 'cropType')) || 'לא צוין');
        bump(stats.freqNursery, norm(cropField(e, 'nursery'))  || 'לא צוין');

        // month
        const m = num(e.experimentMonth);
        if (m >= 1 && m <= 12) stats.monthCounts[m - 1] += 1;

        // lead researcher
        const researcher = norm(e.leadResearcher);
        bump(stats.freqResearcher, researcher || 'לא צוין');
        if (researcher) {
            if (!stats.researcherStats[researcher]) stats.researcherStats[researcher] = { total: 0, field: 0, lab: 0 };
            const rs = stats.researcherStats[researcher];
            rs.total += 1;
            if (study === 'field') rs.field += 1;
            if (study === 'lab')   rs.lab   += 1;
        }

        // partners
        partnerNames(e).forEach(name => {
            const n = norm(name);
            if (n) bump(stats.partnerStats, n);
        });

        // crop varieties
        cropVarieties(e).forEach(v => {
            const key = norm(v);
            if (key) { stats.varietySet.add(key); bump(stats.freqVariety, key); }
        });

        // keywords
        (Array.isArray(e.keywords) ? e.keywords : []).forEach(k => {
            const key = norm(k);
            if (key) { stats.keywordSet.add(key); bump(stats.freqKeyword, key); }
        });
    });

    return stats;
}

// ======================================================
// Render orchestrator
// ======================================================
function renderAll(ownCount, sharedCount) {
    const exps  = allExperiments;
    const stats = computeStats(exps);   // ← the single pass

    // ownership badges
    animateCount('own-count',    ownCount);
    animateCount('shared-count', sharedCount);

    // KPIs – row 1 (existing metrics)
    animateCount('kpi-total',     stats.total);
    animateCount('kpi-sites',     stats.siteSet.size);
    animateCount('kpi-varieties', stats.varietySet.size);
    animateCount('kpi-keywords',  stats.keywordSet.size);
    animateCount('kpi-packages',  stats.packageSet.size);

    // KPIs – row 2 (NEW metrics)
    animateCount('kpi-field',       stats.fieldCount);
    animateCount('kpi-lab',         stats.labCount);
    animateCount('kpi-researchers', Object.keys(stats.researcherStats).length);
    animateCount('kpi-partners',    Object.keys(stats.partnerStats).length);
    animateCount('kpi-treatments',  stats.sumTreatments);
    animateCount('kpi-repetitions', stats.sumRepetitions);
    animateCount('kpi-events',      stats.sumEvents);
    animateCount('kpi-maps',        stats.mapCount);

    // NEW – derived insight cards
    renderInsightCards(stats);

    // Charts (client-side only)
    renderChartByYear(stats);
    renderChartBySite(stats);
    renderChartByPackage(stats);
    renderChartByCrop(stats);
    renderChartByStudyType(stats);
    renderChartByMonth(stats);
    renderChartByResearcher(stats);
    renderChartByNursery(stats);

    // NEW – trends & insight charts
    renderChartCumulative(stats);
    renderChartEffortByPackage(stats);
    renderChartTopVarieties(stats);

    // Map (needs raw docs for coordinates)
    renderExperimentsMap(exps);

    // Keywords
    renderKeywordsCloud(stats);

    // Tables
    renderExperimentsTable(exps);   // needs raw docs (per-row links, createdAt sort)

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
        const color = exp.isShared ? '#4f46e5' : '#0f7a39';

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
            'כפתור מיקוד מחזיר תצוגה לכל הניסויים'
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
        const div = L.DomUtil.create('div', 'bi-map-control bi-map-help');
        div.innerHTML = `
            <div class="bi-map-ctrl-title">💡 ${escHtml(config.title)}</div>
            <ul class="bi-map-ctrl-list">
                ${config.lines.map(line => `<li>${escHtml(line)}</li>`).join('')}
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
        const div = L.DomUtil.create('div', 'bi-map-control bi-map-legend');
        div.dir = 'rtl';

        const ownershipRows = stats.showOwnership ? `
            <div class="bi-map-legend-row">
                <span class="bi-map-legend-dot bi-dot-shared"></span>
                <span class="bi-map-legend-label">שותף/ה</span>
                <strong class="bi-map-legend-val">${stats.shared}</strong>
            </div>
            <div class="bi-map-legend-row">
                <span class="bi-map-legend-dot bi-dot-own"></span>
                <span class="bi-map-legend-label">שלי</span>
                <strong class="bi-map-legend-val">${stats.own}</strong>
            </div>
        ` : '';

        div.innerHTML = `
            <div class="bi-map-ctrl-title">🧪 מקרא</div>
            <div class="bi-map-legend-row">
                <span class="bi-map-legend-icon">⚗</span>
                <span class="bi-map-legend-label">מיקום ניסוי</span>
            </div>
            <div class="bi-map-legend-row bi-map-legend-total">
                <span class="bi-map-legend-label">סה"כ על המפה</span>
                <strong class="bi-map-legend-val">${stats.total}</strong>
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
        const button = L.DomUtil.create('button', 'bi-map-reset-btn');
        button.type = 'button';
        button.title = 'מיקוד לכל הניסויים';
        button.innerHTML = '<i class="fas fa-bullseye"></i>';
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
// Minimalist BI palette: a single brand navy for all single-series charts,
// with one muted secondary reserved for multi-series (stacked) charts only.
const CHART_NAVY      = '#18408d';   // primary — every single-series chart
const CHART_SECONDARY = '#8aaef5';   // secondary series in stacked charts
// Back-compat aliases (all map to the primary so single-series stay uniform)
const CHART_GREEN = CHART_NAVY;
const CHART_AMBER = CHART_NAVY;
const CHART_TEAL  = CHART_NAVY;

function renderChartByYear(stats) {
    const sorted = Object.entries(stats.freqYear).sort((a, b) => a[0].localeCompare(b[0]));
    drawBarChart('chart-by-year', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_NAVY);
}

function renderChartBySite(stats) {
    const sorted = sortedEntries(stats.freqSite, 8);
    drawHBarChart('chart-by-site', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_AMBER);
}

function renderChartByPackage(stats) {
    const sorted = sortedEntries(stats.freqPackage, 8);
    drawHBarChart('chart-by-package', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_NAVY);
}

function renderChartByCrop(stats) {
    const sorted = sortedEntries(stats.freqCrop, 8);
    drawHBarChart('chart-by-crop', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_GREEN);
}

// NEW – study type (field/lab)
function renderChartByStudyType(stats) {
    const sorted = Object.entries(stats.freqStudyType).sort((a, b) => b[1] - a[1]);
    drawBarChart('chart-by-study-type', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_NAVY);
}

// NEW – experiments by month
function renderChartByMonth(stats) {
    drawBarChart('chart-by-month', MONTH_LABELS, stats.monthCounts, CHART_TEAL);
}

// NEW – experiments by lead researcher
function renderChartByResearcher(stats) {
    const sorted = sortedEntries(stats.freqResearcher, 8);
    drawHBarChart('chart-by-researcher', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_NAVY);
}

// NEW – experiments by nursery
function renderChartByNursery(stats) {
    const sorted = sortedEntries(stats.freqNursery, 8);
    drawHBarChart('chart-by-nursery', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_GREEN);
}

// ======================================================
// NEW – Derived insight cards (from precomputed stats)
// ======================================================
function renderInsightCards(stats) {
    const total = stats.total;

    // Average treatments per experiment
    const avgTreatments = total ? (stats.sumTreatments / total) : 0;
    setText('kpi-avg-treatments', total ? avgTreatments.toFixed(1) : '—');

    // Busiest year (ignore the "not specified" bucket)
    const busiest = Object.entries(stats.freqYear)
        .filter(([year]) => year !== 'לא צוין')
        .sort((a, b) => b[1] - a[1])[0];
    setText('kpi-busiest-year', busiest ? busiest[0] : '—');
    setText('kpi-busiest-year-count', busiest ? `${busiest[1]} ניסויים` : '');

    // Share of own vs shared (percentage of own)
    const ownPct = total ? Math.round((stats.ownCount / total) * 100) : 0;
    setText('kpi-own-share', total ? `${ownPct}%` : '—');
}

// ======================================================
// NEW – Trends & insight charts
// ======================================================
// Cumulative experiments accumulated by year
function renderChartCumulative(stats) {
    const years = Object.keys(stats.freqYear)
        .filter(y => y !== 'לא צוין')
        .sort((a, b) => a.localeCompare(b));
    let running = 0;
    const cumulative = years.map(y => (running += stats.freqYear[y]));
    drawLineChart('chart-cumulative', years, cumulative, CHART_NAVY);
}

// Treatments vs repetitions effort per work-package (stacked HBar)
function renderChartEffortByPackage(stats) {
    const entries = Object.entries(stats.effortByPackage)
        .sort((a, b) => (b[1].treatments + b[1].repetitions) - (a[1].treatments + a[1].repetitions))
        .slice(0, 8);

    drawStackedHBarChart('chart-effort-package',
        entries.map(x => x[0]),
        [
            { label: 'טיפולים', data: entries.map(x => x[1].treatments), color: CHART_NAVY },
            { label: 'חזרות',   data: entries.map(x => x[1].repetitions), color: CHART_SECONDARY }
        ]
    );
}

// Top crop varieties across experiments
function renderChartTopVarieties(stats) {
    const sorted = sortedEntries(stats.freqVariety, 8);
    drawHBarChart('chart-top-varieties', sorted.map(x => x[0]), sorted.map(x => x[1]), CHART_GREEN);
}

// ======================================================
// Keywords Cloud
// ======================================================
function renderKeywordsCloud(stats) {
    const freq = stats.freqKeyword;

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
// The list can be long, so we render in pages: a first batch is shown and a
// "load more" button reveals additional rows on demand. The full sorted list
// is cached on the tbody for incremental appends.
const EXP_TABLE_PAGE_SIZE = 8;
let _expTableSorted = [];
let _expTableShown = 0;

function renderExperimentsTable(exps) {
    const tbody = document.getElementById('experiments-table-body');
    if (!tbody) return;

    const loadMoreBtn = document.getElementById('exp-load-more');
    const countNote   = document.getElementById('exp-count-note');

    if (!exps.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="no-data">אין ניסויים להצגה</td></tr>';
        if (loadMoreBtn) loadMoreBtn.hidden = true;
        if (countNote)   countNote.textContent = '';
        return;
    }

    _expTableSorted = [...exps].sort((a, b) => {
        const da = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(0);
        const db_ = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(0);
        return db_ - da;
    });

    _expTableShown = 0;
    tbody.innerHTML = '';

    appendExpTablePage(tbody);

    if (loadMoreBtn) {
        loadMoreBtn.hidden = _expTableShown >= _expTableSorted.length;
        loadMoreBtn.onclick = () => {
            appendExpTablePage(tbody);
            loadMoreBtn.hidden = _expTableShown >= _expTableSorted.length;
            updateExpCountNote(countNote);
        };
    }
    updateExpCountNote(countNote);
}

function appendExpTablePage(tbody) {
    const slice = _expTableSorted.slice(_expTableShown, _expTableShown + EXP_TABLE_PAGE_SIZE);
    const html = slice.map(e => {
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
    tbody.insertAdjacentHTML('beforeend', html);
    _expTableShown = Math.min(_expTableShown + EXP_TABLE_PAGE_SIZE, _expTableSorted.length);
}

function updateExpCountNote(el) {
    if (!el) return;
    const total = _expTableSorted.length;
    if (_expTableShown >= total) {
        el.textContent = total ? `מציג את כל ${total} הניסויים` : '';
    } else {
        el.textContent = `מציג ${_expTableShown} מתוך ${total}`;
    }
}

// ======================================================
// Chart Factory Helpers – bar charts only, professional styling
// ======================================================
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
// NEW – Line + Stacked chart factories
// ======================================================
function drawLineChart(canvasId, labels, data, color) {
    const ctx = getCtx(canvasId);
    if (!ctx) return;
    new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                data,
                borderColor: color,
                backgroundColor: 'rgba(24, 64, 141, 0.08)',
                borderWidth: 2.5,
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: color,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: prefersReducedMotion ? false : { duration: 800 },
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

function drawStackedHBarChart(canvasId, labels, datasets) {
    const ctx = getCtx(canvasId);
    if (!ctx) return;
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: datasets.map(ds => ({
                label: ds.label,
                data: ds.data,
                backgroundColor: ds.color,
                maxBarThickness: 26
            }))
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: prefersReducedMotion ? false : { duration: 700 },
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { font: { family: FONT_FAM, size: 11 }, color: TICK_COLOR, boxWidth: 12, padding: 12 }
                },
                tooltip: {
                    backgroundColor: '#182230',
                    titleFont: { family: FONT_FAM, weight: '600' },
                    bodyFont: { family: FONT_FAM },
                    padding: 10,
                    cornerRadius: 6
                }
            },
            scales: {
                x: {
                    stacked: true,
                    beginAtZero: true,
                    grid: { color: GRID_COLOR, drawTicks: false },
                    border: { display: false },
                    ticks: { font: { family: FONT_FAM, size: 11 }, color: TICK_COLOR, precision: 0, padding: 6 }
                },
                y: {
                    stacked: true,
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

function norm(val) { return (val || '').trim() || null; }

function sortedEntries(freq, topN = 10) {
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, topN);
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

// Animated count-up for numeric KPIs (respects reduced-motion)
function animateCount(id, target) {
    const el = document.getElementById(id);
    if (!el) return;

    const value = Number(target) || 0;
    if (prefersReducedMotion || value === 0) {
        el.textContent = String(value);
        return;
    }

    const duration = 900;
    const startTime = performance.now();
    const step = (now) => {
        const progress = Math.min((now - startTime) / duration, 1);
        // easeOutCubic
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = String(Math.round(eased * value));
        if (progress < 1) requestAnimationFrame(step);
        else el.textContent = String(value);
    };
    requestAnimationFrame(step);
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
