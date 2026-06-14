// js/smart-export.js
// Smart Multi-Export — Flat Excel (13 sheets) + ZIP with attachments
// ══════════════════════════════════════════════════════════════════

import { auth, db, storage } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc, getDoc, collection, getDocs, query, limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    ref, listAll, getBlob
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { showToast } from "./toast.js";
import { initServerTime, getTrustedNow } from "./server-time.js";
import { canRead, timestampToDate } from "./permissions-utils.js";

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════
const SESSION_KEY = 'smart-export-selections';

const SHEET_ORDER = [
    'metadata', 'cropDetails', 'structure', 'soilTreatment', 'dripLayout',
    'irrigationFert', 'growth', 'climateSensors', 'agrotechPoll',
    'plantProtection', 'yieldData', 'eventLog', 'financialAnalysis'
];

const SHEET_DISPLAY = {
    metadata:           'מטה-דאטה',
    cropDetails:        'פרטי הגידול',
    structure:          'מבנה',
    soilTreatment:      'טיפול בקרקע',
    dripLayout:         'סוג ופריסת הטפטוף',
    irrigationFert:     'השקיה ודשן',
    growth:             'צימוח',
    climateSensors:     'אקלים וסנסורים',
    agrotechPoll:       'אגרוטכניקה והאבקה',
    plantProtection:    'הגנת הצומח',
    yieldData:          'נתוני יבול',
    eventLog:           'יומן אירועים',
    financialAnalysis:  'ניתוחים פיננסיים'
};

const HEADERS = {
    metadata: [
        'מזהה ניסוי', 'שם הניסוי', 'מזהה בעלים', 'חוקר מוביל', 'שותפים לניסוי',
        'מקים הניסוי', 'חשיפת הניסוי', 'תאריך חסיון עד', 'שנת הניסוי', 'חודש הניסוי',
        'תקופת המחקר', 'סוג המחקר', 'חבילת עבודה', 'אתר הניסוי', 'קורדינטות אתר הניסוי',
        'מטרת הניסוי', 'תקציר הניסוי', 'מספר הטיפולים', 'מספר החזרות לטיפול',
        'פרטי טיפולים', 'משתנה בלתי תלוי', 'מספר רמות', 'ערכי רמות',
        'משתנה תלוי', 'מילות מפתח', 'תאריך יצירה', 'תאריך עדכון אחרון', 'תאריך שליפה'
    ],
    cropDetails: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'מועד שתילה', 'סוג גידול', 'זן / זנים', 'מועד הדבקה 1', 'מועד הדבקה 2',
        'צמח מורכב', 'סוג הזן', 'שם הכנה', 'צמח מפוצל', 'משתלה',
        'כמות שתילים', 'עומד שתילה', 'מספר עציצים', 'מספר שתילים בעציץ',
        'מבנה שתילה', 'שטח הניסוי בדונם', 'הערות'
    ],
    structure: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'סוג המבנה', 'גודל מבנה במטר', 'חיפוי גג', 'טמפ׳ תא', 'טמפ׳',
        'טמפ׳ מינימום לילה', 'טמפ׳ מקסימום יום', 'מפנה המבנה',
        'פעולות חריגות חשובות הנדרשות בהמשך'
    ],
    soilTreatment: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'מספר רשומה', 'סוג רשומת קרקע',
        'מצע מנותק', 'סוג החברה', 'סוג המצע', 'נפח המצע לעציץ',
        'חיטוי בהמטרה אדיגן', 'כמות אדיגן',
        'תאריך קומפוסט', 'כמות קומפוסט', 'אופן יישום קומפוסט',
        'תאריך חיטוי קרקע', 'חומר החיטוי', 'כמות חיטוי', 'אופן יישום חיטוי',
        'תאריך עיבוד קרקע', 'פעולת עיבוד קרקע', 'הערות'
    ],
    dripLayout: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'שלוחה בודדת / כפולה', 'קוטר צינור טפטוף', 'סוג טפטפת',
        'מרחק בין טפטפות בס״מ', 'ספיקה בליטר לשעה', 'משך השקיה בדקות',
        'מספר השקיות ביום', 'מספר שלוחות', 'הערות'
    ],
    irrigationFert: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'מספר רשומה', 'סוג רשומה',
        'שם הקובץ', 'תאריך העלאה', 'תאריך התחלה', 'תאריך סיום',
        'סה״כ כמות מים בליטר', 'סוג הדשן', 'חברה', 'סה״כ כמות דשן',
        'קישור לקובץ', 'נתיב הקובץ בתוך ZIP', 'הערות'
    ],
    growth: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'מספר רשומה', 'נתון צימוח', 'שם נתון אחר', 'ערך', 'יחידת מידה',
        'תאריך מדידה', 'הערות'
    ],
    climateSensors: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'מספר רשומה', 'נתון', 'מיקום מדידה', 'מיקום חיישן במרחב',
        'גובה / עומק חיישן', 'תאריך התחלה', 'תאריך סיום',
        'שם קובץ מצורף', 'קישור לקובץ', 'נתיב הקובץ בתוך ZIP', 'הערות'
    ],
    agrotechPoll: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'מספר רשומה', 'סוג רשומה', 'פעולה', 'פירוט פעולה',
        'תאריך ביצוע הפעולה', 'כמות שעות לפעולה', 'כמות עובדים לפעולה',
        'תאריך האבקה', 'כמות כוורות', 'הערות'
    ],
    plantProtection: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'מספר רשומה', 'סוג רשומה', 'מפגע', 'תאריך מפגע',
        'סוג האילוח', 'שיטת האילוח', 'כמות האילוח',
        'חומר', 'תאריך טיפול', 'מינון לטיפול', 'משולב עם חומרים נוספים', 'הערות'
    ],
    yieldData: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר טיפול', 'שם טיפול', 'נתונים זהים לכלל הטיפולים',
        'מספר רשומה', 'סוג רשומה', 'תאריך מדידה', 'חזרה', 'קומת הפרי',
        'איכות לק״ג', 'כמות בק״ג', 'תיאור הפרי', 'הערות מדידת יבול',
        'הפגע הנמדד', 'מדד נזק', 'ערך הנזק', 'תיאור הנזק'
    ],
    eventLog: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר רשומה', 'תאריך אירוע', 'תיאור האירוע',
        'שם קובץ', 'קישור לקובץ', 'נתיב הקובץ בתוך ZIP',
        'תאריך יצירה', 'נוצר על ידי', 'הערות'
    ],
    financialAnalysis: [
        'מזהה ניסוי', 'שם הניסוי', 'מספר רשומה', 'תאריך נתון פיננסי', 'תיאור הנתון',
        'שם קובץ', 'קישור לקובץ', 'נתיב הקובץ בתוך ZIP',
        'תאריך יצירה', 'נוצר על ידי', 'הערות'
    ]
};

const STORAGE_FOLDER_MAP = {
    'events': 'יומן אירועים',
    'irrigation': 'השקיה ודשן',
    'fertilization': 'השקיה ודשן',
    'growth': 'צימוח',
    'climate': 'אקלים וסנסורים',
    'agrotechnics': 'אגרוטכניקה והאבקה',
    'protection': 'הגנת הצומח',
    'yield': 'נתוני יבול',
    'financial': 'ניתוחים פיננסים'
};

// ═══════════════════════════════════════
// State
// ═══════════════════════════════════════
let currentUser = null;
let userData = null;
let isAdmin = false;
let isExportActive = false;

// ═══════════════════════════════════════
// DOM Ready
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    initSidebar();
    document.getElementById('btn-back-search')?.addEventListener('click', () => {
        window.location.href = 'smart-search.html';
    });

    // Prevent accidental navigation
    window.addEventListener('beforeunload', (e) => {
        if (isExportActive) {
            e.preventDefault();
            e.returnValue = 'תהליך השליפה עדיין בעיצומו. יציאה מהעמוד תפסיק את התהליך ותאלץ להתחיל אותו מחדש.';
            return e.returnValue;
        }
    });
});

function initSidebar() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
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
            sidebar?.classList.remove('open');
            overlay?.classList.remove('active');
        });
    }
    document.getElementById('btn-logout')?.addEventListener('click', async () => {
        await signOut(auth);
        window.location.href = 'login.html';
    });
}

// ═══════════════════════════════════════
// Auth
// ═══════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;

    try {
        const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
        if (!userSnap.exists() || !userSnap.data().isApproved) {
            await signOut(auth);
            window.location.href = 'login.html';
            return;
        }
        userData = userSnap.data();

        const displayName = document.getElementById('user-display-name');
        if (displayName) displayName.textContent = `${userData.firstName || ''} ${userData.lastName || ''}`.trim() || currentUser.email;

        await initServerTime(db, currentUser);
        isAdmin = await checkAdmin();

        // Start the export flow
        await runSmartExport();
    } catch (error) {
        console.error('Smart export init error:', error);
        setStepError('שגיאה באתחול הייצוא');
        showToast('שגיאה באתחול עמוד הייצוא', 'error');
    }
});

async function checkAdmin() {
    try {
        const snap = await getDocs(query(collection(db, 'users'), limit(2)));
        return snap.size > 1;
    } catch (_) { return false; }
}

// ═══════════════════════════════════════
// Main Export Flow
// ═══════════════════════════════════════
async function runSmartExport() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) {
        setStepError('לא נמצאו ניסויים לייצוא. חזור לשליפה חכמה ובחר ניסויים.');
        return;
    }

    let selections;
    try { selections = JSON.parse(raw); } catch { selections = []; }
    if (!selections.length) {
        setStepError('לא נמצאו ניסויים לייצוא.');
        return;
    }

    isExportActive = true;
    renderExperimentList(selections);

    // Step 1: Check permissions & load data
    activateStep(1);
    setProgressText(`בודק הרשאות ל-${selections.length} ניסויים...`);

    const experiments = [];
    const denied = [];

    for (let i = 0; i < selections.length; i++) {
        const sel = selections[i];
        setProgressText(`טוען ניסוי ${i + 1} מתוך ${selections.length}: ${sel.name || sel.id}...`);
        try {
            const expSnap = await getDoc(doc(db, 'users', sel.ownerUid, 'experiments', sel.id));
            if (!expSnap.exists()) { denied.push(sel); continue; }

            const data = expSnap.data();
            if (!canRead(data, currentUser, userData, getTrustedNow(), sel.ownerUid)) {
                denied.push(sel);
                continue;
            }
            experiments.push({ id: sel.id, ownerUid: sel.ownerUid, data });
        } catch (err) {
            console.warn(`Cannot load experiment ${sel.id}:`, err);
            denied.push(sel);
        }
    }

    if (denied.length > 0) {
        showToast(`${denied.length} ניסויים לא נכללו בשליפה עקב חוסר הרשאה`, 'warning');
    }
    if (experiments.length === 0) {
        setStepError('אין ניסויים עם הרשאת גישה לייצוא.');
        return;
    }

    completeStep(1);
    setProgressText(`נטענו ${experiments.length} ניסויים בהצלחה`);

    // Step 2: Flatten data
    activateStep(2);
    setProgressText('מנרמל נתונים למבנה שטוח...');

    const workbookRows = {};
    SHEET_ORDER.forEach(key => { workbookRows[key] = []; });

    const now = new Date();
    const exportDateStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;

    for (const exp of experiments) {
        workbookRows.metadata.push(...flattenMetadata(exp, exportDateStr));
        workbookRows.cropDetails.push(...flattenCropDetails(exp));
        workbookRows.structure.push(...flattenStructure(exp));
        workbookRows.soilTreatment.push(...flattenSoilTreatment(exp));
        workbookRows.dripLayout.push(...flattenDripLayout(exp));
        workbookRows.irrigationFert.push(...flattenIrrigationFert(exp));
        workbookRows.growth.push(...flattenGrowth(exp));
        workbookRows.climateSensors.push(...flattenClimateSensors(exp));
        workbookRows.agrotechPoll.push(...flattenAgrotechPoll(exp));
        workbookRows.plantProtection.push(...flattenPlantProtection(exp));
        workbookRows.yieldData.push(...flattenYieldData(exp));
        workbookRows.eventLog.push(...flattenEventLog(exp));
        workbookRows.financialAnalysis.push(...flattenFinancialAnalysis(exp));
    }

    completeStep(2);

    // Step 3: Build Excel
    activateStep(3);
    setProgressText('בונה קובץ Excel...');
    const wb = buildFlatWorkbook(workbookRows);
    completeStep(3);

    // Step 4: Download attachments + build ZIP
    activateStep(4);
    setProgressText('מכין קובץ ZIP...');
    const zip = new JSZip();
    const xlsxData = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    zip.file('experiments_flat_export.xlsx', xlsxData);

    setProgressText('מוריד קבצים מצורפים מ-Storage...');
    await downloadAllAttachments(experiments, zip);
    completeStep(4);

    // Step 5: Generate & download ZIP
    activateStep(5);
    setProgressText('יוצר קובץ ZIP...');
    const zipBlob = await zip.generateAsync({ type: 'blob' }, (meta) => {
        setProgressText(`יוצר ZIP... ${Math.round(meta.percent)}%`);
    });

    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    saveAs(zipBlob, `smart_export_${ts}.zip`);

    completeStep(5);
    isExportActive = false; // Disable page unload prompt
    const warningNote = document.getElementById('export-warning-note');
    if (warningNote) warningNote.classList.add('hidden');

    const area = document.getElementById('progress-area');
    if (area) area.classList.add('success');
    setProgressText('הייצוא הושלם בהצלחה!');
    showToast('קובץ ZIP הורד בהצלחה!', 'success');

    document.getElementById('export-complete-message')?.classList.add('visible');

    // Cleanup
    sessionStorage.removeItem(SESSION_KEY);
}

// ═══════════════════════════════════════
// Section State Resolver (from export.js pattern)
// ═══════════════════════════════════════
function resolveSectionState(data, sectionId, legacyShared, legacyData) {
    const treatmentsCount = Math.max(1, parseInt(data.treatmentsCount) || 0, Array.isArray(data.treatments) ? data.treatments.length : 0);
    const model = data.sectionSharedState?.[sectionId];
    let shared = legacyShared !== false;
    let sharedData = deepClone(legacyData || {});
    let byTreatment = [];

    if (model) {
        shared = model.shared !== false;
        sharedData = deepClone(model.sharedData || model.data || sharedData || {});
        byTreatment = Array.isArray(model.byTreatment) ? deepClone(model.byTreatment) : [];
    }

    while (byTreatment.length < treatmentsCount) {
        byTreatment.push(deepClone(sharedData || {}));
    }

    return { shared, sharedData, byTreatment, treatmentsCount };
}

function getTreatmentInfo(data, index) {
    const t = data.treatments?.[index] || {};
    return {
        number: index + 1,
        name: t.name || `טיפול ${index + 1}`
    };
}

// ═══════════════════════════════════════
// Helper to iterate treatments or single
// ═══════════════════════════════════════
function forEachTreatment(exp, sectionId, legacyShared, legacyData, callback) {
    const state = resolveSectionState(exp.data, sectionId, legacyShared, legacyData);
    const base = { expId: exp.id, expName: s(exp.data.experimentName) };

    if (state.shared) {
        const sectionData = state.sharedData || state.byTreatment[0] || {};
        callback(sectionData, {
            ...base,
            treatmentNum: 'כללי',
            treatmentName: 'כללי',
            sameForAll: 'כן'
        });
    } else {
        for (let i = 0; i < state.treatmentsCount; i++) {
            const info = getTreatmentInfo(exp.data, i);
            const sectionData = state.byTreatment[i] || {};
            callback(sectionData, {
                ...base,
                treatmentNum: String(info.number),
                treatmentName: info.name,
                sameForAll: 'לא'
            });
        }
    }
}

// ═══════════════════════════════════════
// FLATTEN FUNCTIONS
// ═══════════════════════════════════════

// ── 1. מטה-דאטה ──
function flattenMetadata(exp, exportDateStr) {
    const d = exp.data;
    const partners = (d.partners || []).map(p => {
        if (typeof p === 'string') return p;
        return [p.name, p.email, p.role].filter(Boolean).join(' ');
    }).join('; ');

    const treatments = (d.treatments || []).map((t, i) => `${i + 1}: ${t.name || ''}`).join('; ');
    const studyLabel = d.studyType === 'lab' ? 'מעבדה' : d.studyType === 'field' ? 'שדה' : s(d.studyType);
    const visLabel = d.visibility === 'private' ? 'חסוי' : 'חשוף';

    return [[
        exp.id,
        s(d.experimentName),
        exp.ownerUid,
        s(d.leadResearcher),
        partners,
        s(d.experimentCreator || d.leadResearcher),
        visLabel,
        fmtDate(d.privateUntil),
        s(d.experimentYear),
        s(d.experimentMonth),
        s(d.researchPeriod || d.startDate),
        studyLabel,
        s(d.workPackage),
        s(d.experimentSite),
        s(d.siteCoordinates),
        s(d.experimentGoal),
        s(d.experimentSummary),
        s(d.treatmentsCount),
        s(d.repetitionsCount),
        treatments,
        arrJoin(d.independentVariables),
        s(d.levelsCount),
        s(d.levelValue),
        arrJoin(d.dependentVariables),
        arrJoin(d.keywords),
        fmtDate(d.createdAt),
        fmtDate(d.updatedAt),
        exportDateStr
    ]];
}

// ── 2. פרטי הגידול ──
function flattenCropDetails(exp) {
    const rows = [];
    forEachTreatment(exp, 'crop', exp.data.cropDetails?.shared, exp.data.cropDetails?.data || {},
        (crop, ctx) => {
            const varieties = Array.isArray(crop.varieties)
                ? crop.varieties.map(v => String(v || '').trim()).filter(Boolean).join('; ')
                : s(crop.variety);
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                s(crop.plantingDate),
                s(crop.cropType),
                varieties,
                s(crop.inoculationDate1),
                s(crop.inoculationDate2),
                s(crop.graftedPlant),
                s(crop.varietyType),
                s(crop.preparationName),
                s(crop.splitPlant),
                s(crop.nursery),
                s(crop.seedlingsCount),
                s(crop.plantingDensity),
                s(crop.potsCount),
                s(crop.seedlingsPerPot),
                s(crop.plantingStructure),
                s(crop.experimentArea),
                s(crop.notes)
            ]);
        });
    return rows;
}

// ── 3. מבנה ──
function flattenStructure(exp) {
    const rows = [];
    forEachTreatment(exp, 'structure', exp.data.structureDetails?.shared, exp.data.structureDetails?.data || {},
        (st, ctx) => {
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                s(st.type),
                s(st.size),
                s(st.roofCovering),
                s(st.cellTempMode),
                s(st.cellTempFixed),
                s(st.cellTempMinNight),
                s(st.cellTempMaxDay),
                s(st.direction),
                s(st.notes)
            ]);
        });
    return rows;
}

// ── 4. טיפול בקרקע ──
function flattenSoilTreatment(exp) {
    const rows = [];
    forEachTreatment(exp, 'soil', exp.data.soilDetails?.shared, exp.data.soilDetails?.data || {},
        (soil, ctx) => {
            let recordNum = 0;

            // General row
            recordNum++;
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'כללי',
                s(soil.detachedSubstrate), s(soil.substrateCompany), s(soil.substrateType), s(soil.substrateVolume),
                s(soil.disinfectionAdigan), s(soil.adiganAmount),
                '', '', '', '', '', '', '', '', '', s(soil.notes)
            ]);

            // Compost rows
            (soil.compostRows || []).forEach(r => {
                recordNum++;
                rows.push([
                    ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                    recordNum, 'קומפוסט',
                    '', '', '', '', '', '',
                    s(r.date), s(r.amount), s(r.method),
                    '', '', '', '', '', '', ''
                ]);
            });

            // Disinfection rows
            (soil.disinfectRows || []).forEach(r => {
                recordNum++;
                rows.push([
                    ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                    recordNum, 'חיטוי קרקע',
                    '', '', '', '', '', '',
                    '', '', '',
                    s(r.date), s(r.material), s(r.amount), s(r.method),
                    '', '', ''
                ]);
            });

            // Soil work rows
            (soil.soilWorkRows || soil.workRows || []).forEach(r => {
                recordNum++;
                rows.push([
                    ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                    recordNum, 'עיבוד קרקע',
                    '', '', '', '', '', '',
                    '', '', '',
                    '', '', '', '',
                    s(r.date), s(r.action), ''
                ]);
            });
        });
    return rows;
}

// ── 5. סוג ופריסת הטפטוף ──
function flattenDripLayout(exp) {
    const rows = [];
    forEachTreatment(exp, 'drip', exp.data.dripDetails?.shared, exp.data.dripDetails?.data || {},
        (drip, ctx) => {
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                s(drip.singleDouble),
                s(drip.pipeDiameter),
                s(drip.type),
                s(drip.emitterSpacing),
                s(drip.flowRate),
                s(drip.irrigationDurationMinutes),
                s(drip.irrigationsPerDay),
                s(drip.linesCount),
                s(drip.notes)
            ]);
        });
    return rows;
}

// ── 6. השקיה ודשן ──
function flattenIrrigationFert(exp) {
    const rows = [];
    forEachTreatment(exp, 'irrigation', true, {
        irrigationData: exp.data.irrigationData || [],
        fertilizationData: exp.data.fertilizationData || []
    }, (section, ctx) => {
        let recordNum = 0;

        // Irrigation records
        (section.irrigationData || []).forEach(r => {
            recordNum++;
            const zipPath = r.fileUrl ? `attachments/${ctx.expId}/השקיה ודשן/${r.fileName || 'file'}` : '';
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'השקיה',
                s(r.fileName), s(r.uploadDate), s(r.startDate || r.measureDates), s(r.endDate),
                s(r.totalWater), '', '', '',
                s(r.fileUrl), zipPath, s(r.notes)
            ]);
        });

        // Fertilization records
        (section.fertilizationData || []).forEach(r => {
            recordNum++;
            const zipPath = r.fileUrl ? `attachments/${ctx.expId}/השקיה ודשן/${r.fileName || 'file'}` : '';
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'דישון',
                s(r.fileName), s(r.uploadDate), s(r.startDate || r.measureDates), s(r.endDate),
                '', s(r.fertType || r.type), s(r.company), s(r.totalFert || r.totalAmount),
                s(r.fileUrl), zipPath, s(r.notes)
            ]);
        });
    });
    return rows;
}

// ── 7. צימוח ──
function flattenGrowth(exp) {
    const rows = [];
    forEachTreatment(exp, 'growth', true, { growthData: exp.data.growthData || [] },
        (section, ctx) => {
            (section.growthData || []).forEach((r, i) => {
                const measureType = s(r.name || r.measurementType);
                rows.push([
                    ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                    i + 1,
                    measureType,
                    measureType === 'אחר' ? s(r.otherName) : '',
                    s(r.value),
                    s(r.unit),
                    s(r.measureDate),
                    s(r.notes)
                ]);
            });
        });
    return rows;
}

// ── 8. אקלים וסנסורים ──
function flattenClimateSensors(exp) {
    const rows = [];
    forEachTreatment(exp, 'climate', true, { climateData: exp.data.climateData || [] },
        (section, ctx) => {
            let recordNum = 0;

            // Sensor records
            (section.climateData || []).forEach(r => {
                recordNum++;
                rows.push([
                    ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                    recordNum,
                    s(r.name || r.sensorType),
                    s(r.location || r.measurementLocation),
                    s(r.sensorPosition),
                    s(r.sensorDepth || r.sensorHeight),
                    s(r.startDate || r.measureDates),
                    s(r.endDate),
                    '', '', '', s(r.notes)
                ]);
            });

            // Climate sensor files
            const files = section.climateSensorFiles || exp.data.climateSensorFiles || [];
            files.forEach(f => {
                recordNum++;
                const zipPath = f.fileURL || f.fileUrl
                    ? `attachments/${ctx.expId}/אקלים וסנסורים/${f.fileName || 'file'}`
                    : '';
                rows.push([
                    ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                    recordNum,
                    'קובץ נתונים', '', '', '', s(f.startDate), s(f.endDate),
                    s(f.fileName), s(f.fileURL || f.fileUrl), zipPath, ''
                ]);
            });
        });
    return rows;
}

// ── 9. אגרוטכניקה והאבקה ──
function flattenAgrotechPoll(exp) {
    const rows = [];
    forEachTreatment(exp, 'agrotechnics', true, {
        agrotechnicsData: exp.data.agrotechnicsData || [],
        pollinationData: exp.data.pollinationData || []
    }, (section, ctx) => {
        let recordNum = 0;

        // Agrotechnics operations
        (section.agrotechnicsData || []).forEach(r => {
            recordNum++;
            const action = r.action === 'אחר' ? `${r.action} - ${r.actionOther || ''}` : s(r.action);
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'אגרוטכניקה',
                action, s(r.detail || r.actionOther),
                s(r.actionDate || r.date),
                s(r.hours || r.hoursPerAction),
                s(r.workers || r.workersPerAction),
                '', '', s(r.notes)
            ]);
        });

        // Pollination records
        (section.pollinationData || []).forEach(r => {
            recordNum++;
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'האבקה',
                '', '',
                '', '', '',
                s(r.date), s(r.hiveCount), s(r.notes)
            ]);
        });
    });
    return rows;
}

// ── 10. הגנת הצומח ──
function flattenPlantProtection(exp) {
    const rows = [];
    forEachTreatment(exp, 'plantProtection', true, {
        plantProtectionData: exp.data.plantProtectionData || {}
    }, (section, ctx) => {
        const pp = section.plantProtectionData || {};
        let recordNum = 0;

        // Pests
        (pp.pests || []).forEach(r => {
            recordNum++;
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'מזיק',
                s(r.pest), s(r.date),
                s(r.inoculationType), s(r.inoculationMethod), s(r.inoculationAmount),
                '', '', '', '', s(r.notes)
            ]);
        });

        // Diseases
        (pp.diseases || []).forEach(r => {
            recordNum++;
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'מחלה',
                s(r.pest || r.disease), s(r.date),
                s(r.inoculationType), s(r.inoculationMethod), s(r.inoculationAmount),
                '', '', '', '', s(r.notes)
            ]);
        });

        // Sprays
        (pp.sprays || []).forEach(r => {
            recordNum++;
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'ריסוס',
                '', '',
                '', '', '',
                s(r.material), s(r.date), s(r.dosage), s(r.combined), s(r.notes)
            ]);
        });

        // Drenches
        (pp.drenches || []).forEach(r => {
            recordNum++;
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'הגמעה',
                '', '',
                '', '', '',
                s(r.material), s(r.date), s(r.dosage), s(r.combined), s(r.notes)
            ]);
        });
    });
    return rows;
}

// ── 11. נתוני יבול ──
function flattenYieldData(exp) {
    const rows = [];
    const legacyYield = exp.data.yieldData || {};

    // Check for legacy byTreatment format
    let useLegacy = false;
    if (!exp.data.sectionSharedState?.yield && Array.isArray(legacyYield.byTreatment) && legacyYield.byTreatment.length > 0) {
        useLegacy = true;
    }

    if (useLegacy) {
        legacyYield.byTreatment.forEach((entry, i) => {
            const info = getTreatmentInfo(exp.data, i);
            const yd = normalizeYieldData(entry?.yieldData || entry || {});
            emitYieldRows(yd, { expId: exp.id, expName: s(exp.data.experimentName), treatmentNum: String(info.number), treatmentName: info.name, sameForAll: 'לא' }, rows);
        });
    } else {
        forEachTreatment(exp, 'yield', true, { yieldData: normalizeYieldData(legacyYield) },
            (section, ctx) => {
                const yd = normalizeYieldData(section.yieldData || section || {});
                emitYieldRows(yd, ctx, rows);
            });
    }
    return rows;
}

function emitYieldRows(yd, ctx, rows) {
    let recordNum = 0;

    (yd.measures || []).forEach(r => {
        recordNum++;
        rows.push([
            ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
            recordNum, 'מדידת יבול',
            s(r.measureDate), s(r.repeatCount), s(r.fruitFloor),
            s(r.quality), s(r.quantity), s(r.fruitDesc), s(r.notes),
            '', '', '', ''
        ]);
    });

    (yd.damages || []).forEach(r => {
        recordNum++;
        rows.push([
            ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
            recordNum, 'פגע יבול',
            s(r.measureDate), s(r.repeatCount), '',
            '', '', '', '',
            s(r.damage), s(r.damageIndex), s(r.damageValue), s(r.damageDesc)
        ]);
    });
}

function normalizeYieldData(raw = {}) {
    return {
        measures: Array.isArray(raw.measures) ? raw.measures : [],
        damages: Array.isArray(raw.damages) ? raw.damages : []
    };
}

// ── 12. יומן אירועים ──
function flattenEventLog(exp) {
    const events = exp.data.events || [];
    return events.map((e, i) => {
        const zipPath = (e.fileUrl || e.fileURL)
            ? `attachments/${exp.id}/יומן אירועים/${e.fileName || 'file'}`
            : '';
        return [
            exp.id, s(exp.data.experimentName),
            i + 1,
            s(e.date), s(e.description),
            s(e.fileName), s(e.fileUrl || e.fileURL), zipPath,
            fmtDate(e.createdAt), s(e.createdBy),
            s(e.notes)
        ];
    });
}

// ── 13. ניתוחים פיננסיים ──
function flattenFinancialAnalysis(exp) {
    const files = exp.data.financialFiles || exp.data.financialAnalysis?.financialFiles || [];
    return files.map((f, i) => {
        const zipPath = (f.fileURL || f.fileUrl)
            ? `attachments/${exp.id}/ניתוחים פיננסים/${f.fileName || 'file'}`
            : '';
        return [
            exp.id, s(exp.data.experimentName),
            i + 1,
            s(f.date), s(f.description),
            s(f.fileName), s(f.fileURL || f.fileUrl), zipPath,
            fmtDate(f.createdAt), s(f.createdBy),
            s(f.notes)
        ];
    });
}

// ═══════════════════════════════════════
// Build Flat Workbook
// ═══════════════════════════════════════
function buildFlatWorkbook(workbookRows) {
    const wb = XLSX.utils.book_new();

    SHEET_ORDER.forEach(key => {
        const headers = HEADERS[key];
        const dataRows = workbookRows[key] || [];
        const aoa = [headers, ...dataRows];

        const ws = XLSX.utils.aoa_to_sheet(aoa);

        // Set column widths
        ws['!cols'] = headers.map(h => ({ wch: Math.max(14, Math.min(40, h.length * 2)) }));

        // RTL
        if (!ws['!sheetViews']) ws['!sheetViews'] = [{}];
        ws['!sheetViews'][0].rightToLeft = true;

        XLSX.utils.book_append_sheet(wb, ws, SHEET_DISPLAY[key]);
    });

    // Workbook RTL
    if (!wb.Workbook) wb.Workbook = {};
    if (!wb.Workbook.Views) wb.Workbook.Views = [{}];
    wb.Workbook.Views[0].RTL = true;

    return wb;
}

// ═══════════════════════════════════════
// Download Attachments into ZIP
// ═══════════════════════════════════════
async function downloadAllAttachments(experiments, zip) {
    const attachmentsFolder = zip.folder('attachments');
    let totalFiles = 0;
    let errorCount = 0;

    for (const exp of experiments) {
        const storagePath = `users/${exp.ownerUid}/experiments/${exp.id}`;
        const storageRef = ref(storage, storagePath);

        try {
            await scanStorageFolder(storageRef, attachmentsFolder.folder(exp.id), exp.id);
        } catch (err) {
            console.warn(`Cannot scan storage for ${exp.id}:`, err.message);
        }
    }

    async function scanStorageFolder(storageRef, zipFolder, expId) {
        let result;
        try {
            result = await listAll(storageRef);
        } catch (err) {
            return;
        }

        for (const itemRef of result.items) {
            try {
                totalFiles++;
                setProgressText(`מוריד קובץ ${totalFiles}: ${itemRef.name}`);
                const blob = await getBlob(itemRef);
                zipFolder.file(itemRef.name, blob);
            } catch (err) {
                errorCount++;
                console.error(`Failed to download ${itemRef.fullPath}:`, err.message);
            }
        }

        for (const prefixRef of result.prefixes) {
            const hebrewName = STORAGE_FOLDER_MAP[prefixRef.name] || prefixRef.name;
            await scanStorageFolder(prefixRef, zipFolder.folder(hebrewName), expId);
        }
    }

    if (errorCount > 0) {
        showToast(`${errorCount} קבצים לא הורדו — בדוק הרשאות`, 'warning');
    }
    if (totalFiles === 0) {
        setProgressText('אין קבצים מצורפים ב-Storage');
    } else {
        setProgressText(`${totalFiles - errorCount}/${totalFiles} קבצים הורדו`);
    }
}

// ═══════════════════════════════════════
// UI Helpers
// ═══════════════════════════════════════
function activateStep(stepNum) {
    document.querySelectorAll('.progress-step').forEach(el => {
        const n = parseInt(el.dataset.step);
        if (n === stepNum) el.classList.add('active');
    });
}

function completeStep(stepNum) {
    document.querySelectorAll('.progress-step').forEach(el => {
        const n = parseInt(el.dataset.step);
        if (n === stepNum) {
            el.classList.remove('active');
            el.classList.add('completed');
        }
    });
}

function setProgressText(text) {
    const el = document.getElementById('progress-status-text');
    if (el) el.textContent = text;
}

function setStepError(text) {
    isExportActive = false; // Disable page unload prompt
    const warningNote = document.getElementById('export-warning-note');
    if (warningNote) warningNote.classList.add('hidden');

    setProgressText(text);
    const area = document.getElementById('progress-area');
    if (area) area.classList.add('error');
    document.getElementById('export-error-message')?.classList.add('visible');
}

function renderExperimentList(selections) {
    const list = document.getElementById('selected-experiments-list');
    if (!list) return;

    list.innerHTML = selections.map((sel, i) => `
        <div class="exp-list-item">
            <span class="exp-list-num">${i + 1}</span>
            <span class="exp-list-name">${escapeHtml(sel.name || sel.id)}</span>
            ${sel.researcher ? `<span class="exp-list-researcher">${escapeHtml(sel.researcher)}</span>` : ''}
        </div>
    `).join('');

    const countEl = document.getElementById('selected-count');
    if (countEl) countEl.textContent = selections.length;
}

// ═══════════════════════════════════════
// Utility Helpers
// ═══════════════════════════════════════
function s(val) {
    if (val === null || val === undefined) return '';
    return String(val).trim();
}

function arrJoin(arr) {
    if (!Array.isArray(arr)) return s(arr);
    return arr.map(v => s(v)).filter(Boolean).join('; ');
}

function fmtDate(val) {
    if (!val) return '';
    const d = timestampToDate(val);
    if (d && !isNaN(d.getTime())) {
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    }
    return s(val);
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function deepClone(value) {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
}

function sanitizeFileName(name) {
    return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').substring(0, 100);
}

function escapeHtml(val) {
    return s(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
