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
const EXTRACT_FILES_KEY = 'smart-export-extract-files';

// Tag appended to record-type cells for values pulled from an attached CSV/Excel file
const FILE_SOURCE_TAG = '(נשלף מתוך קובץ מצורף)';

// Columns in the "השקיה ודשן" sheet that can be filled from an attached file.
// `header` is the exact XLSX header (used to resolve the target column index);
// `accepted` is the list of file-column header names (normalized) that map to it.
const IRRIGATION_EXTRACT_TARGETS = [
    { header: 'סה״כ כמות מים בליטר', accepted: ['סהכ כמות מים', 'כמות מים', 'סהכ כמות מים בליטר', 'סהכ מים'], recordTypes: ['השקיה'] },
    { header: 'סוג הדשן', accepted: ['סוג הדשן'], recordTypes: ['דישון'] },
    { header: 'חברה', accepted: ['חברה'], recordTypes: ['דישון'] },
    { header: 'סה״כ כמות דשן', accepted: ['סהכ כמות דשן', 'כמות דשן'], recordTypes: ['דישון'] }
];

// Columns in the "אקלים וסנסורים" sheet that can be filled from an attached file.
const CLIMATE_EXTRACT_TARGETS = [
    { header: 'נתון', accepted: ['נתון', 'סוג נתון'] },
    { header: 'מיקום מדידה', accepted: ['מיקום מדידה'] },
    { header: 'מיקום חיישן במרחב', accepted: ['מיקום חיישן במרחב', 'מיקום חיישן'] },
    { header: 'גובה / עומק חיישן', accepted: ['גובה / עומק חיישן', 'גובה עומק חיישן', 'גובה חיישן', 'עומק חיישן'] },
    { header: 'תאריך התחלה', accepted: ['תאריך התחלה'] },
    { header: 'תאריך סיום', accepted: ['תאריך סיום'] },
    { header: 'הערות', accepted: ['הערות'] }
];

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

// Storage folder -> flat sheet key. Used only for optional extraction from CSV/Excel attachments.
const STORAGE_SECTION_MAP = {
    irrigation: 'irrigationFert',
    fertilization: 'irrigationFert',
    climate: 'climateSensors'
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

    let extractFromFiles = false;
    try {
        extractFromFiles = JSON.parse(sessionStorage.getItem(EXTRACT_FILES_KEY) || 'false') === true;
    } catch { extractFromFiles = false; }
    console.log('[extract] enabled:', extractFromFiles);

    isExportActive = true;
    renderExperimentList(selections);

    // Step 1: Check permissions & load data
    activateStep(1);
    setProgressText(`בודק הרשאות ל-${selections.length} ניסויים...`);

    const experiments = [];
    const denied = [];
    const usedNames = new Set();

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

            // Generate unique folder name based on experiment name
            const rawName = data.experimentName || '';
            let folderName = rawName ? sanitizeFileName(rawName) : sel.id;
            if (usedNames.has(folderName)) {
                let counter = 2;
                let candidate = `${folderName}_${counter}`;
                while (usedNames.has(candidate)) {
                    counter++;
                    candidate = `${folderName}_${counter}`;
                }
                folderName = candidate;
            }
            usedNames.add(folderName);

            experiments.push({ id: sel.id, ownerUid: sel.ownerUid, folderName, data });
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

    // Create the ZIP container up-front — attachments may need to be downloaded
    // before flattening (when extracting data from attached files).
    const zip = new JSZip();

    // Step 2: Flatten data (optionally pre-download + parse attachments for extraction)
    activateStep(2);

    let parsedAttachments = null;
    if (extractFromFiles) {
        setProgressText('מוריד קבצים מצורפים לצורך חילוץ נתונים...');
        const attachmentBlobs = await downloadAllAttachments(experiments, zip);
        setProgressText('מנתח קבצי CSV/Excel מצורפים...');
        parsedAttachments = await parseAttachmentsForExtraction(attachmentBlobs);
    }

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
        workbookRows.irrigationFert.push(...flattenIrrigationFert(exp, parsedAttachments));
        workbookRows.growth.push(...flattenGrowth(exp));
        workbookRows.climateSensors.push(...flattenClimateSensors(exp, parsedAttachments));
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
    const xlsxData = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    zip.file('experiments_flat_export.xlsx', xlsxData);
    completeStep(3);

    // Step 4: Download attachments into ZIP (skip if already downloaded for extraction)
    activateStep(4);
    if (extractFromFiles) {
        setProgressText('הקבצים המצורפים כבר הורדו');
    } else {
        setProgressText('מוריד קבצים מצורפים מ-Storage...');
        await downloadAllAttachments(experiments, zip);
    }
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
    sessionStorage.removeItem(EXTRACT_FILES_KEY);
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
    const base = { expId: exp.id, expName: s(exp.data.experimentName), folderName: exp.folderName || exp.id };

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
function flattenIrrigationFert(exp, parsedAttachments) {
    const rows = [];
    const parsedFiles = parsedAttachments?.get(exp.id) || [];
    forEachTreatment(exp, 'irrigation', true, {
        irrigationData: exp.data.irrigationData || [],
        fertilizationData: exp.data.fertilizationData || []
    }, (section, ctx) => {
        let recordNum = 0;

        // Irrigation records
        (section.irrigationData || []).forEach(r => {
            recordNum++;
            const zipPath = r.fileUrl
                ? `attachments/${ctx.folderName}/השקיה ודשן/${r.fileName || getFileNameFromUrl(r.fileUrl) || 'file'}`
                : '';
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
            const fileUrl = r.fileUrl || r.fileURL || r.downloadUrl || '';
            const zipPath = fileUrl
                ? `attachments/${ctx.folderName}/השקיה ודשן/${r.fileName || getFileNameFromUrl(fileUrl) || 'file'}`
                : '';
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'דישון',
                s(r.fileName), s(r.uploadDate), s(r.startDate || r.measureDates), s(r.endDate),
                '', s(r.fertType || r.type), s(r.company), s(r.totalFert || r.totalAmount),
                s(fileUrl), zipPath, s(r.notes)
            ]);
        });

        // Extract matching columns from attached CSV/Excel files (opt-in).
        // Important: do not match only by display name; uploaded Storage file names are often encoded/technical.
        if (parsedFiles.length) {
            const fileRecords = [
                ...(section.irrigationData || [])
                    .filter(hasAttachmentRef)
                    .map(r => ({ rec: r, label: 'השקיה', folderKey: 'irrigation' })),
                ...(section.fertilizationData || [])
                    .filter(hasAttachmentRef)
                    .map(r => ({ rec: r, label: 'דישון', folderKey: 'fertilization' }))
            ];

            let addedRows = 0;
            fileRecords.forEach(({ rec, label, folderKey }) => {
                const parsed = findParsedFile(parsedFiles, rec, { sectionKey: 'irrigationFert', folderKey });
                if (!parsed) return;

                const targets = IRRIGATION_EXTRACT_TARGETS.filter(t =>
                    !Array.isArray(t.recordTypes) || t.recordTypes.includes(label)
                );
                const fileUrl = rec.fileUrl || rec.fileURL || rec.downloadUrl || '';
                const extracted = buildExtractedRows({
                    parsed,
                    sheetKey: 'irrigationFert',
                    targets,
                    ctx,
                    nextRecordNum: () => ++recordNum,
                    fileNameCol: 7,   // 'שם הקובץ'
                    tagCol: 6,        // 'סוג רשומה'
                    tagPrefix: label, // 'השקיה' / 'דישון'
                    sourceFileName: rec.fileName || rec.name || parsed.displayName || parsed.name,
                    sourceFileUrl: fileUrl,
                    sourceZipPath: parsed.zipPath,
                    fileUrlCol: 15,
                    zipPathCol: 16
                });
                addedRows += extracted.length;
                rows.push(...extracted);
            });
            if (addedRows) console.log(`[extract][irrigationFert] ${ctx.expId}: added ${addedRows} rows from attached files`);
        }
    });
    return rows;
}

// Build XLSX rows from a parsed attachment whose column headers match a sheet's
// extractable fields. One XLSX row per file data row.
//   sheetKey      — key into HEADERS / SHEET_ORDER
//   targets       — *_EXTRACT_TARGETS describing which columns are fillable
//   ctx           — identity context (expId/expName/treatment…) from forEachTreatment
//   nextRecordNum — () => number, continues the section's record counter
//   fileNameCol   — column index to stamp the source file name into (optional)
//   tagCol        — column index to carry the "(נשלף מתוך קובץ מצורף)" tag
//   tagPrefix     — when set, tagCol = `${tagPrefix} ${TAG}`; otherwise the tag is
//                   appended to whatever already sits in tagCol
function buildExtractedRows({
    parsed,
    sheetKey,
    targets,
    ctx,
    nextRecordNum,
    fileNameCol,
    tagCol,
    tagPrefix,
    sourceFileName,
    sourceFileUrl,
    sourceZipPath,
    fileUrlCol,
    zipPathCol
}) {
    const headerLen = HEADERS[sheetKey].length;

    const colMatches = [];
    parsed.headers.forEach((header, fileColIndex) => {
        const targetIndex = matchColumnIndex(header, targets, sheetKey);
        if (targetIndex !== -1) colMatches.push({ targetIndex, fileColIndex, header });
    });
    if (!colMatches.length) return [];

    const out = [];
    parsed.rows.forEach(fileRow => {
        const hasValue = colMatches.some(m => s(fileRow[m.fileColIndex]) !== '');
        if (!hasValue) return;

        const row = new Array(headerLen).fill('');
        row[0] = ctx.expId;
        row[1] = ctx.expName;
        row[2] = ctx.treatmentNum;
        row[3] = ctx.treatmentName;
        row[4] = ctx.sameForAll;
        row[5] = nextRecordNum();

        colMatches.forEach(m => { row[m.targetIndex] = s(fileRow[m.fileColIndex]); });

        if (fileNameCol != null && !row[fileNameCol]) row[fileNameCol] = s(sourceFileName || parsed.displayName || parsed.name);
        if (fileUrlCol != null && !row[fileUrlCol]) row[fileUrlCol] = s(sourceFileUrl || parsed.fileUrl || parsed.downloadUrl || '');
        if (zipPathCol != null && !row[zipPathCol]) row[zipPathCol] = s(sourceZipPath || parsed.zipPath || '');

        if (tagCol != null) {
            row[tagCol] = tagPrefix != null
                ? `${tagPrefix} ${FILE_SOURCE_TAG}`
                : (row[tagCol] ? `${row[tagCol]} ` : '') + FILE_SOURCE_TAG;
        }
        out.push(row);
    });
    return out;
}

// Resolve a file column header to a target column index in HEADERS[sheetKey],
// or -1 if it doesn't match any extractable field (exact match, punctuation-insensitive).
function matchColumnIndex(rawHeader, targets, sheetKey) {
    const norm = normalizeHeader(rawHeader);
    if (!norm) return -1;
    for (const target of targets) {
        if (target.accepted.some(name => normalizeHeader(name) === norm)) {
            const wanted = normalizeHeader(target.header);
            return HEADERS[sheetKey].findIndex(h => normalizeHeader(h) === wanted);
        }
    }
    return -1;
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
function flattenClimateSensors(exp, parsedAttachments) {
    const rows = [];
    const parsedFiles = parsedAttachments?.get(exp.id) || [];
    forEachTreatment(exp, 'climate', true, { climateData: exp.data.climateData || [] },
        (section, ctx) => {
            let recordNum = 0;

            // Sensor records. Some schemas store the attachment directly on the sensor row.
            (section.climateData || []).forEach(r => {
                recordNum++;
                const fileUrl = r.fileUrl || r.fileURL || r.downloadUrl || '';
                const zipPath = fileUrl
                    ? `attachments/${ctx.folderName}/אקלים וסנסורים/${r.fileName || getFileNameFromUrl(fileUrl) || 'file'}`
                    : '';
                rows.push([
                    ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                    recordNum,
                    s(r.name || r.sensorType),
                    s(r.location || r.measurementLocation),
                    s(r.sensorPosition),
                    s(r.sensorDepth || r.sensorHeight),
                    s(r.startDate || r.measureDates),
                    s(r.endDate),
                    s(r.fileName || r.nameOfFile), s(fileUrl), zipPath, s(r.notes)
                ]);
            });

            // Climate sensor files saved as a separate collection/array.
            const files = [
                ...(section.climateSensorFiles || []),
                ...(exp.data.climateSensorFiles || [])
            ];
            const seen = new Set();
            const uniqueFiles = files.filter(f => {
                const key = s(f.filePath || f.storagePath || f.fileUrl || f.fileURL || f.downloadUrl || f.fileName || f.name);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            uniqueFiles.forEach(f => {
                recordNum++;
                const fileUrl = f.fileURL || f.fileUrl || f.downloadUrl || '';
                const zipPath = fileUrl
                    ? `attachments/${ctx.folderName}/אקלים וסנסורים/${f.fileName || getFileNameFromUrl(fileUrl) || 'file'}`
                    : '';
                rows.push([
                    ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                    recordNum,
                    'קובץ נתונים', '', '', '', s(f.startDate), s(f.endDate),
                    s(f.fileName || f.name), s(fileUrl), zipPath, ''
                ]);
            });

            // Extract matching columns from attached CSV/Excel files (opt-in).
            if (parsedFiles.length) {
                const extractionRecords = [
                    ...(section.climateData || []).filter(hasAttachmentRef),
                    ...uniqueFiles.filter(hasAttachmentRef)
                ];
                let addedRows = 0;
                extractionRecords.forEach(f => {
                    const parsed = findParsedFile(parsedFiles, f, { sectionKey: 'climateSensors', folderKey: 'climate' });
                    if (!parsed) return;
                    const fileUrl = f.fileURL || f.fileUrl || f.downloadUrl || '';
                    const extracted = buildExtractedRows({
                        parsed,
                        sheetKey: 'climateSensors',
                        targets: CLIMATE_EXTRACT_TARGETS,
                        ctx,
                        nextRecordNum: () => ++recordNum,
                        fileNameCol: 12,  // 'שם קובץ מצורף'
                        tagCol: 15,       // 'הערות' (tag appended)
                        sourceFileName: f.fileName || f.name || parsed.displayName || parsed.name,
                        sourceFileUrl: fileUrl,
                        sourceZipPath: parsed.zipPath,
                        fileUrlCol: 13,
                        zipPathCol: 14
                    });
                    addedRows += extracted.length;
                    rows.push(...extracted);
                });
                if (addedRows) console.log(`[extract][climateSensors] ${ctx.expId}: added ${addedRows} rows from attached files`);
            }
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
        const folderName = exp.folderName || exp.id;
        const zipPath = (e.fileUrl || e.fileURL)
            ? `attachments/${folderName}/יומן אירועים/${e.fileName || 'file'}`
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
        const folderName = exp.folderName || exp.id;
        const zipPath = (f.fileURL || f.fileUrl)
            ? `attachments/${folderName}/ניתוחים פיננסים/${f.fileName || 'file'}`
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
    const blobMap = new Map();
    let totalFiles = 0;
    let errorCount = 0;

    for (const exp of experiments) {
        const storagePath = `users/${exp.ownerUid}/experiments/${exp.id}`;
        const storageRef = ref(storage, storagePath);

        const folderName = exp.folderName || exp.id;
        const expFiles = [];
        blobMap.set(exp.id, expFiles);
        try {
            await scanStorageFolder(storageRef, attachmentsFolder.folder(folderName), exp.id, expFiles, {
                zipParts: ['attachments', folderName],
                folderKey: '',
                sectionKey: ''
            });
        } catch (err) {
            console.warn(`Cannot scan storage for ${exp.id}:`, err.message);
        }
    }

    async function scanStorageFolder(storageRef, zipFolder, expId, expFiles, meta) {
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

                const zipPath = [...(meta.zipParts || []), itemRef.name].join('/');
                expFiles.push({
                    name: itemRef.name,
                    displayName: itemRef.name,
                    blob,
                    fullPath: itemRef.fullPath,
                    storagePath: itemRef.fullPath,
                    folderKey: meta.folderKey || '',
                    sectionKey: meta.sectionKey || '',
                    zipPath
                });
            } catch (err) {
                errorCount++;
                console.error(`Failed to download ${itemRef.fullPath}:`, err.message);
            }
        }

        for (const prefixRef of result.prefixes) {
            const hebrewName = STORAGE_FOLDER_MAP[prefixRef.name] || prefixRef.name;
            const nextFolderKey = meta.folderKey || prefixRef.name;
            const nextSectionKey = meta.sectionKey || STORAGE_SECTION_MAP[prefixRef.name] || '';
            await scanStorageFolder(prefixRef, zipFolder.folder(hebrewName), expId, expFiles, {
                zipParts: [...(meta.zipParts || []), hebrewName],
                folderKey: nextFolderKey,
                sectionKey: nextSectionKey
            });
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

    return blobMap;
}

// ═══════════════════════════════════════
// Attachment Parsing (in-file extraction)
// ═══════════════════════════════════════

// Parse every CSV/Excel attachment to { name, headers, rows }. Non-tabular files
// (images, PDFs, etc.) and unreadable files are skipped silently.
async function parseAttachmentsForExtraction(blobMap) {
    const parsedMap = new Map();
    let parsedCount = 0;
    for (const [expId, files] of blobMap.entries()) {
        const parsedFiles = [];
        for (const f of files) {
            const parsed = await parseAttachmentToRows(f.blob, f.name);
            if (parsed) {
                parsedCount++;
                parsedFiles.push({
                    ...f,
                    headers: parsed.headers,
                    rows: parsed.rows
                });
                console.log('[extract] parsed file:', {
                    expId,
                    name: f.name,
                    folderKey: f.folderKey,
                    sectionKey: f.sectionKey,
                    headers: parsed.headers,
                    rows: parsed.rows.length
                });
            }
        }
        if (parsedFiles.length) parsedMap.set(expId, parsedFiles);
    }
    console.log('[extract] parsed files count:', parsedCount);
    return parsedMap;
}

// Read a CSV/Excel blob into a header row + data rows using the already-loaded
// SheetJS (XLSX) library. Returns null when the file isn't tabular or has no data.
async function parseAttachmentToRows(blob, fileName) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(ext)) return null;
    try {
        const buf = await blob.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheetName = wb.SheetNames[0];
        if (!sheetName) return null;
        const ws = wb.Sheets[sheetName];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        const nonEmpty = aoa.filter(row => Array.isArray(row) && row.some(c => s(c) !== ''));
        if (nonEmpty.length < 2) return null; // need a header row + at least one data row
        const headers = (nonEmpty[0] || []).map(h => s(h));
        const rows = nonEmpty.slice(1);
        return { headers, rows };
    } catch (err) {
        console.warn(`Cannot parse attachment ${fileName}:`, err.message);
        return null;
    }
}

// Find the parsed file that belongs to a record by its stored fileName.
// Tries an exact match first, then a suffix/contains match (storage names may
// carry prefixes or be URL-encoded).
function findParsedFile(parsedFiles, fileRef, options = {}) {
    if (!Array.isArray(parsedFiles) || !parsedFiles.length) return null;

    const refObj = typeof fileRef === 'object' && fileRef !== null ? fileRef : { fileName: fileRef };
    const wantedSection = options.sectionKey || '';
    const wantedFolder = options.folderKey || '';

    const candidates = parsedFiles.filter(f => {
        if (wantedSection && f.sectionKey && f.sectionKey !== wantedSection) return false;
        if (wantedFolder && f.folderKey && f.folderKey !== wantedFolder) return false;
        return true;
    });
    const pool = candidates.length ? candidates : parsedFiles;

    const wantedValues = [
        refObj.filePath,
        refObj.storagePath,
        refObj.fullPath,
        refObj.fileUrl,
        refObj.fileURL,
        refObj.downloadUrl,
        refObj.url,
        refObj.fileName,
        refObj.name,
        typeof fileRef === 'string' ? fileRef : ''
    ].map(normalizeFileRef).filter(Boolean);

    if (wantedValues.length) {
        const exact = pool.find(f => {
            const fileValues = [f.fullPath, f.storagePath, f.filePath, f.fileUrl, f.downloadUrl, f.name, f.displayName, f.zipPath]
                .map(normalizeFileRef)
                .filter(Boolean);
            return wantedValues.some(w => fileValues.some(v => v === w || v.endsWith('/' + w) || w.endsWith('/' + v)));
        });
        if (exact) return exact;

        const contained = pool.find(f => {
            const fileValues = [f.fullPath, f.storagePath, f.filePath, f.fileUrl, f.downloadUrl, f.name, f.displayName, f.zipPath]
                .map(normalizeFileRef)
                .filter(Boolean);
            return wantedValues.some(w => fileValues.some(v => v.includes(w) || w.includes(v)));
        });
        if (contained) return contained;
    }

    // Safe fallback: if there is exactly one parsed table file in the relevant section/folder, use it.
    if (pool.length === 1) return pool[0];
    return null;
}

// Normalize a column header for exact-but-punctuation-insensitive comparison
// (so 'סה"כ כמות דשן' and 'סה״כ כמות דשן' are treated as equal).
function normalizeHeader(value) {
    return s(value)
        .replace(/["'״׳`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeFileRef(value) {
    let out = s(value);
    if (!out) return '';
    try { out = decodeURIComponent(out); } catch { /* keep raw */ }
    out = out.replace(/^https?:\/\/[^/]+\/[^/]+\/o\//, '');
    out = out.split('?')[0];
    return out.toLowerCase().trim();
}

function hasAttachmentRef(value) {
    if (!value || typeof value !== 'object') return false;
    return Boolean(value.fileName || value.name || value.fileUrl || value.fileURL || value.downloadUrl || value.filePath || value.storagePath || value.fullPath);
}

function getFileNameFromUrl(value) {
    const normalized = normalizeFileRef(value);
    if (!normalized) return '';
    const parts = normalized.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
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
 
 
----- js\smart-search.js ----- 
// js/smart-search.js
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    collectionGroup,
    doc,
    getDoc,
    getDocs,
    limit,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from "./toast.js";
import { initServerTime, getTrustedNow } from "./server-time.js";
import { timestampToDate } from "./permissions-utils.js";

const ACTIVE_EXPERIMENT_CONTEXT_KEY = "research-map-active-experiment-context";
const BOOT_LOADER_MIN_MS = 5000;
const BOOT_STATUSES = [
    "בודק הרשאות גישה...",
    "אוסף ניסויים שיש לך הרשאה אליהם...",
    "מכין חיפוש חכם..."
];

const bootStartedAt = Date.now();
let bootStatusIndex = 0;
let bootStatusTimer = null;
let bootRevealStarted = false;

const SOURCE_PRIORITY = {
    own: 4,
    shared: 3,
    admin: 2,
    public: 1
};

const SEARCH_FIELDS = [
    { key: "searchBlocks.value", label: "כל תוכן הניסוי", checked: true },
    { key: "experimentName", label: "שם הניסוי", checked: true },
    { key: "leadResearcher", label: "חוקר מוביל", checked: true },
    { key: "experimentSite", label: "אתר", checked: true },
    { key: "experimentYear", label: "שנה", checked: true },
    { key: "workPackage", label: "חבילת עבודה", checked: true },
    { key: "keywordsText", label: "מילות מפתח", checked: true },
    { key: "partnersText", label: "שותפים", checked: true },
    { key: "studyType", label: "סוג מחקר", checked: false }
];

const DIRECT_SEARCH_LABELS = {
    experimentName: "שם הניסוי",
    leadResearcher: "חוקר מוביל",
    experimentSite: "אתר",
    experimentYear: "שנה",
    workPackage: "חבילת עבודה",
    keywordsText: "מילות מפתח",
    partnersText: "שותפים",
    studyType: "סוג מחקר",
    "searchBlocks.value": "כל תוכן הניסוי"
};

const PATH_LABELS = {
    experimentName: "שם הניסוי",
    leadResearcher: "חוקר מוביל",
    partners: "שותפים",
    name: "שם",
    email: "אימייל",
    role: "תפקיד",
    experimentYear: "שנה",
    experimentMonth: "חודש",
    startDate: "תאריך התחלה",
    studyType: "סוג מחקר",
    workPackage: "חבילת עבודה",
    experimentSite: "אתר הניסוי",
    siteCoordinates: "קורדינטות",
    labCellNumber: "תא מעבדה",
    treatmentsCount: "מספר טיפולים",
    repetitionsCount: "מספר חזרות",
    independentVariables: "משתנים בלתי תלויים",
    dependentVariables: "משתנים תלויים",
    keywords: "מילות מפתח",
    events: "אירועים",
    date: "תאריך",
    description: "תיאור",
    fileName: "שם קובץ",
    researchMap: "מפת מחקר",
    cropDetails: "פרטי גידול",
    structureDetails: "מבנה",
    soilDetails: "קרקע",
    dripDetails: "מערכת טפטוף",
    irrigationData: "השקיה",
    fertilizationData: "דישון",
    climateData: "אקלים",
    agrotechnicsData: "אגרוטכניקה",
    plantProtectionData: "הגנת הצומח",
    growthData: "מדדי צימוח",
    yieldData: "יבול",
    data: "",
    sharedData: "נתונים משותפים",
    byTreatment: "לפי טיפול",
    treatmentName: "שם טיפול",
    cropType: "סוג גידול",
    variety: "זן",
    varieties: "זנים",
    varietyType: "סוג זן",
    nursery: "משתלה",
    notes: "הערות",
    plantingDate: "מועד שתילה",
    inoculationDate1: "מועד הדבקה 1",
    inoculationDate2: "מועד הדבקה 2",
    graftedPlant: "צמח מורכב",
    splitPlant: "צמח מפוצל",
    seedlingsCount: "כמות שתילים",
    plantingDensity: "עומד שתילה",
    potsCount: "מספר עציצים",
    seedlingsPerPot: "שתילים בעציץ",
    plantingStructure: "מבנה שתילה",
    experimentArea: "שטח הניסוי",
    preparationName: "שם הכנה"
};

const SEARCH_BLOCK_SKIP_KEYS = new Set([
    "fileUrl",
    "fileURL",
    "downloadURL",
    "filePath",
    "path",
    "url"
]);

let currentUser = null;
let userData = null;
let currentView = "all";
let isAdminUser = false;
let allExperiments = [];
let sharedOnlyExperiments = [];
let filteredExperiments = [];
let currentFuseResultsByKey = new Map();
let selectedExperiments = new Map();

document.addEventListener("DOMContentLoaded", () => {
    initEventListeners();
    initBootStatusRotator();
    renderSearchFieldCheckboxes();
    updateThresholdLabel();
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }

    currentUser = user;

    try {
        const isApproved = await verifyApprovedUser();
        if (!isApproved) return;

        await initServerTime(db, currentUser);
        setUserDisplayName();
        isAdminUser = await checkAndDisplayAdminMenu();
        await loadSmartSearchExperiments();
    } catch (error) {
        console.error("Smart search initialization failed:", error);
        showToast("שגיאה בטעינת עמוד השליפה החכמה", "error");
        hideLoading();
        showEmptyState();
    }
});

function initEventListeners() {
    const hamburgerBtn = document.getElementById("hamburger-btn");
    const sidebar = document.querySelector(".sidebar");
    const overlay = document.getElementById("sidebar-overlay");

    if (hamburgerBtn && sidebar) {
        hamburgerBtn.addEventListener("click", () => {
            sidebar.classList.toggle("open");
            if (overlay) overlay.classList.toggle("active");

            const icon = hamburgerBtn.querySelector("i");
            if (icon) {
                icon.classList.toggle("fa-bars");
                icon.classList.toggle("fa-times");
            }
        });
    }

    if (overlay) {
        overlay.addEventListener("click", () => {
            sidebar?.classList.remove("open");
            overlay.classList.remove("active");
            const icon = hamburgerBtn?.querySelector("i");
            if (icon) {
                icon.classList.add("fa-bars");
                icon.classList.remove("fa-times");
            }
        });
    }

    document.getElementById("btn-logout")?.addEventListener("click", handleLogout);

    document.querySelectorAll(".view-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            const nextView = tab.dataset.view || "all";
            if (nextView === currentView) return;
            currentView = nextView;
            setActiveTab();
            populateFilterOptions();
            applyFiltersAndSearch();
        });
    });

    document.getElementById("smart-search-input")?.addEventListener("input", () => {
        updateClearButtonVisibility();
        applyFiltersAndSearch();
    });

    document.getElementById("btn-clear-search")?.addEventListener("click", () => {
        const input = document.getElementById("smart-search-input");
        if (input) input.value = "";
        updateClearButtonVisibility();
        applyFiltersAndSearch();
    });

    ["filter-year", "filter-work-package", "filter-researcher"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", applyFiltersAndSearch);
    });

    document.getElementById("btn-reset-filters")?.addEventListener("click", () => {
        setSelectValue("filter-year", "");
        setSelectValue("filter-work-package", "");
        setSelectValue("filter-researcher", "");
        applyFiltersAndSearch();
    });

    document.getElementById("fuse-options-toggle")?.addEventListener("click", () => {
        document.getElementById("fuse-options-panel")?.classList.toggle("open");
        document.getElementById("fuse-options-toggle")?.classList.toggle("expanded");
    });

    document.getElementById("fuse-threshold")?.addEventListener("input", () => {
        updateThresholdLabel();
        applyFiltersAndSearch();
    });

    document.querySelectorAll('input[name="logical-mode"]').forEach((radio) => {
        radio.addEventListener("change", () => {
            updateLogicalModeLabels();
            applyFiltersAndSearch();
        });
    });

    // Selection controls
    document.getElementById("select-all-checkbox")?.addEventListener("change", toggleSelectAll);
    document.getElementById("btn-clear-selection")?.addEventListener("click", clearSelection);
    document.getElementById("btn-prepare-export")?.addEventListener("click", showExportSummaryModal);
    document.getElementById("btn-modal-back")?.addEventListener("click", hideExportModal);
    document.getElementById("btn-modal-confirm")?.addEventListener("click", proceedToSmartExport);

    // Close modal on overlay click
    document.getElementById("export-modal-overlay")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) hideExportModal();
    });
}

function initBootStatusRotator() {
    const wrapper = document.getElementById("status-wrapper");
    const statusElement = document.getElementById("dynamic-status");
    if (!wrapper || !statusElement) return;

    statusElement.textContent = BOOT_STATUSES[0];

    bootStatusTimer = window.setInterval(() => {
        wrapper.classList.add("exit");

        window.setTimeout(() => {
            bootStatusIndex = (bootStatusIndex + 1) % BOOT_STATUSES.length;
            statusElement.textContent = BOOT_STATUSES[bootStatusIndex];
            wrapper.classList.remove("exit");
            wrapper.classList.add("enter");

            window.setTimeout(() => {
                wrapper.classList.remove("enter");
            }, 450);
        }, 300);
    }, 2000);
}

function revealSmartSearchWhenReady() {
    if (bootRevealStarted) return;
    bootRevealStarted = true;

    const elapsed = Date.now() - bootStartedAt;
    const remaining = Math.max(0, BOOT_LOADER_MIN_MS - elapsed);

    window.setTimeout(() => {
        if (bootStatusTimer) {
            window.clearInterval(bootStatusTimer);
            bootStatusTimer = null;
        }

        document.body.classList.remove("smart-search-booting");
        document.body.classList.add("smart-search-ready");
    }, remaining);
}

async function verifyApprovedUser() {
    const userSnap = await getDoc(doc(db, "users", currentUser.uid));
    if (!userSnap.exists() || userSnap.data()?.isApproved !== true) {
        await signOut(auth);
        window.location.href = "login.html";
        return false;
    }

    userData = userSnap.data();
    return true;
}

function setUserDisplayName() {
    const displayName = document.getElementById("user-display-name");
    if (!displayName) return;

    const fullName = `${userData?.firstName || ""} ${userData?.lastName || ""}`.trim();
    displayName.textContent = fullName || currentUser.email || "משתמש";
}

async function checkAndDisplayAdminMenu() {
    try {
        const usersQuery = query(collection(db, "users"), limit(2));
        const snapshot = await getDocs(usersQuery);

        if (snapshot.size > 1) {
            displayAdminMenu();
            return true;
        }
    } catch (_) {
        return false;
    }

    return false;
}

function displayAdminMenu() {
    const sidebar = document.querySelector(".sidebar-nav");
    if (!sidebar || sidebar.querySelector('a[href="admin-users.html"]')) return;

    sidebar.insertAdjacentHTML("beforeend", `
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
    `);
}

async function loadSmartSearchExperiments() {
    showLoading();

    try {
        const sharedExperiments = await fetchSharedExperiments();
        const sharedKeys = new Set(sharedExperiments.map((exp) => getExperimentKey(exp.ownerUid, exp.id)));
        const loadedExperiments = [...sharedExperiments];

        if (isAdminUser) {
            loadedExperiments.push(...await fetchAdminExperiments(sharedKeys));
        } else {
            loadedExperiments.push(...await fetchOwnExperiments());
            loadedExperiments.push(...await fetchPublicExperiments(sharedKeys));
        }

        allExperiments = dedupeExperiments(loadedExperiments);
        sharedOnlyExperiments = allExperiments.filter((exp) => exp.source === "shared");

        updateTabCounts();
        populateFilterOptions();
        applyFiltersAndSearch();
    } catch (error) {
        console.error("Error loading smart search experiments:", error);
        showToast("שגיאה בטעינת הניסויים", "error");
        showEmptyState();
    } finally {
        hideLoading();
        revealSmartSearchWhenReady();
    }
}

async function fetchOwnExperiments() {
    const ownSnap = await getDocs(collection(db, "users", currentUser.uid, "experiments"));

    return ownSnap.docs.map((docSnap) => normalizeExperiment({
        id: docSnap.id,
        ownerUid: currentUser.uid,
        data: docSnap.data(),
        source: "own"
    }));
}

async function fetchSharedExperiments() {
    const sharedSnap = await getDocs(collection(db, "users", currentUser.uid, "sharedExperiments"));

    const results = await Promise.all(sharedSnap.docs.map(async (sharedDoc) => {
        const sharedData = sharedDoc.data();
        const ownerUid = sharedData.ownerUid;
        const experimentId = sharedData.experimentId || sharedDoc.id;

        if (!ownerUid || !experimentId) return null;

        if (sharedData.cachedExperiment && typeof sharedData.cachedExperiment === "object") {
            return normalizeExperiment({
                id: experimentId,
                ownerUid,
                data: sharedData.cachedExperiment,
                source: "shared"
            });
        }

        try {
            const originalSnap = await getDoc(doc(db, "users", ownerUid, "experiments", experimentId));
            if (!originalSnap.exists()) return null;

            return normalizeExperiment({
                id: experimentId,
                ownerUid,
                data: originalSnap.data(),
                source: "shared"
            });
        } catch (error) {
            console.warn("Could not load shared experiment", experimentId, error);
            return null;
        }
    }));

    return results.filter(Boolean);
}

async function fetchPublicExperiments(sharedKeys) {
    const publicQuery = query(
        collectionGroup(db, "experiments"),
        where("visibility", "==", "public")
    );
    const publicSnap = await getDocs(publicQuery);

    return publicSnap.docs
        .map((docSnap) => {
            const ownerUid = getOwnerUidFromExperimentPath(docSnap.ref.path);
            if (!ownerUid || ownerUid === currentUser.uid) return null;

            const key = getExperimentKey(ownerUid, docSnap.id);
            if (sharedKeys.has(key)) return null;

            return normalizeExperiment({
                id: docSnap.id,
                ownerUid,
                data: docSnap.data(),
                source: "public"
            });
        })
        .filter(Boolean);
}

async function fetchAdminExperiments(sharedKeys) {
    const allSnap = await getDocs(collectionGroup(db, "experiments"));

    return allSnap.docs
        .map((docSnap) => {
            const ownerUid = getOwnerUidFromExperimentPath(docSnap.ref.path);
            if (!ownerUid) return null;

            let source = "admin";
            const key = getExperimentKey(ownerUid, docSnap.id);
            const data = docSnap.data();

            if (ownerUid === currentUser.uid) {
                source = "own";
            } else if (sharedKeys.has(key)) {
                source = "shared";
            } else if (data.visibility === "public") {
                source = "public";
            }

            return normalizeExperiment({
                id: docSnap.id,
                ownerUid,
                data,
                source
            });
        })
        .filter(Boolean);
}

function dedupeExperiments(experiments) {
    const byKey = new Map();

    experiments.forEach((experiment) => {
        const key = getExperimentKey(experiment.ownerUid, experiment.id);
        const existing = byKey.get(key);
        if (!existing || SOURCE_PRIORITY[experiment.source] > SOURCE_PRIORITY[existing.source]) {
            byKey.set(key, experiment);
        }
    });

    return Array.from(byKey.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function normalizeExperiment({ id, ownerUid, data, source }) {
    const safeData = data || {};
    const partners = Array.isArray(safeData.partners) ? safeData.partners : [];
    const keywords = Array.isArray(safeData.keywords) ? safeData.keywords : [];

    const normalized = {
        id,
        ownerUid,
        source,
        data: safeData,
        experimentName: stringValue(safeData.experimentName),
        leadResearcher: stringValue(safeData.leadResearcher),
        experimentSite: stringValue(safeData.experimentSite || safeData.labCellNumber),
        experimentYear: stringValue(safeData.experimentYear),
        workPackage: stringValue(safeData.workPackage),
        studyType: getStudyTypeLabel(safeData.studyType),
        keywordsText: keywords.map(stringValue).filter(Boolean).join(" "),
        partnersText: partners.map(formatPartnerForSearch).filter(Boolean).join(" "),
        createdAtMs: timestampToDate(safeData.createdAt)?.getTime() || 0
    };

    normalized.searchBlocks = buildSearchBlocks(safeData);
    normalized.fullText = normalized.searchBlocks.map((block) => block.value).join(" ");
    normalized.searchKey = getExperimentKey(ownerUid, id);

    return normalized;
}

function renderSearchFieldCheckboxes() {
    const grid = document.getElementById("search-fields-grid");
    if (!grid) return;

    grid.innerHTML = SEARCH_FIELDS.map((field) => `
        <label class="search-field-check ${field.checked ? "checked" : ""}">
            <input type="checkbox" value="${field.key}" ${field.checked ? "checked" : ""}>
            <span>${escapeHtml(field.label)}</span>
        </label>
    `).join("");

    grid.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
            checkbox.closest(".search-field-check")?.classList.toggle("checked", checkbox.checked);
            applyFiltersAndSearch();
        });
    });
}

function populateFilterOptions() {
    const base = getCurrentViewExperiments();

    populateSelect("filter-year", uniqueSortedValues(base, "experimentYear", true));
    populateSelect("filter-work-package", uniqueSortedValues(base, "workPackage"));
    populateSelect("filter-researcher", uniqueSortedValues(base, "leadResearcher"));
}

function populateSelect(id, values) {
    const select = document.getElementById(id);
    if (!select) return;

    const previousValue = select.value;
    select.innerHTML = '<option value="">הכל</option>';

    values.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    });

    select.value = values.includes(previousValue) ? previousValue : "";
}

function applyFiltersAndSearch() {
    const base = getCurrentViewExperiments();
    const year = document.getElementById("filter-year")?.value || "";
    const workPackage = document.getElementById("filter-work-package")?.value || "";
    const researcher = document.getElementById("filter-researcher")?.value || "";

    const filtered = base.filter((experiment) => {
        return (!year || experiment.experimentYear === year)
            && (!workPackage || experiment.workPackage === workPackage)
            && (!researcher || experiment.leadResearcher === researcher);
    });

    filteredExperiments = runFuseSearch(filtered);
    renderResults();
}

function runFuseSearch(experiments) {
    currentFuseResultsByKey = new Map();

    const searchInput = document.getElementById("smart-search-input");
    const searchTerm = searchInput?.value.trim() || "";
    if (!searchTerm) {
        return experiments;
    }

    const FuseCtor = window.Fuse;
    if (!FuseCtor) {
        console.warn("Fuse.js is not available");
        return experiments;
    }

    const selectedFields = getSelectedSearchFields();
    if (selectedFields.length === 0) {
        selectFallbackSearchField();
        showToast("יש לבחור לפחות שדה אחד לחיפוש", "warning");
        return runFuseSearch(experiments);
    }

    const fuse = new FuseCtor(experiments, {
        keys: selectedFields,
        includeScore: true,
        includeMatches: true,
        ignoreLocation: true,
        threshold: getFuseThreshold(),
        minMatchCharLength: 1
    });

    const words = splitSearchTerms(searchTerm);
    const logicalMode = document.querySelector('input[name="logical-mode"]:checked')?.value || "and";
    const queryExpression = buildLogicalQuery(words, selectedFields, logicalMode);
    const results = fuse.search(queryExpression);

    results.forEach((result) => {
        currentFuseResultsByKey.set(result.item.searchKey, result);
    });

    return results.map((result) => result.item);
}

function buildLogicalQuery(words, selectedFields, logicalMode) {
    const clauses = words.map((word) => {
        const fieldClauses = selectedFields.map((fieldKey) => ({ [fieldKey]: word }));
        return fieldClauses.length === 1 ? fieldClauses[0] : { $or: fieldClauses };
    });

    if (clauses.length === 1) return clauses[0];
    return logicalMode === "or" ? { $or: clauses } : { $and: clauses };
}

function renderResults() {
    const tbody = document.getElementById("results-table-body");
    if (!tbody) return;

    updateResultsStats();

    if (filteredExperiments.length === 0) {
        document.getElementById("results-table-wrapper").style.display = "none";
        showEmptyState();
        tbody.innerHTML = "";
        return;
    }

    document.getElementById("empty-state").style.display = "none";
    document.getElementById("results-table-wrapper").style.display = "block";

    const searchWords = splitSearchTerms(document.getElementById("smart-search-input")?.value || "");

    tbody.innerHTML = filteredExperiments.map((experiment) => {
        const fuseResult = currentFuseResultsByKey.get(experiment.searchKey);
        const score = fuseResult?.score;
        const matchToggle = renderMatchInsights(experiment, fuseResult, searchWords);
        const matchDetailsRow = renderMatchDetailsRow(experiment, fuseResult, searchWords);
        const expKey = getExperimentKey(experiment.ownerUid, experiment.id);
        const isSelected = selectedExperiments.has(expKey);

        return `
            <tr class="result-row${isSelected ? ' selected-row' : ''}" data-experiment-id="${escapeHtml(experiment.id)}" data-owner-uid="${escapeHtml(experiment.ownerUid)}" data-exp-key="${escapeHtml(expKey)}">
                <td class="td-checkbox">
                    <input type="checkbox" class="exp-checkbox" data-exp-key="${escapeHtml(expKey)}" ${isSelected ? 'checked' : ''}>
                </td>
                <td data-label="שם הניסוי">
                    <strong>${highlightText(experiment.experimentName || "ניסוי ללא שם", searchWords)}</strong>
                    ${matchToggle}
                </td>
                <td data-label="חוקר מוביל">${highlightText(experiment.leadResearcher || "לא צוין", searchWords)}</td>
                <td data-label="אתר">${highlightText(experiment.experimentSite || "לא צוין", searchWords)}</td>
                <td data-label="שנה">${highlightText(experiment.experimentYear || "-", searchWords)}</td>
                <td data-label="חבילת עבודה">${highlightText(experiment.workPackage || "-", searchWords)}</td>
                <td data-label="מקור">${renderSourceBadge(experiment.source)}</td>
                <td data-label="חשיפה">${renderVisibilityBadge(experiment.data)}</td>
                <td data-label="פעולות">
                    <button class="btn-view-exp" type="button" data-experiment-id="${escapeHtml(experiment.id)}" data-owner-uid="${escapeHtml(experiment.ownerUid)}">
                        <i class="fas fa-eye"></i>
                        צפייה
                    </button>
                </td>
            </tr>
            ${matchDetailsRow}
        `;
    }).join("");

    // Checkbox event listeners
    tbody.querySelectorAll(".exp-checkbox").forEach((checkbox) => {
        checkbox.addEventListener("change", (event) => {
            event.stopPropagation();
            const key = checkbox.dataset.expKey;
            toggleExperimentSelection(key);
            const row = checkbox.closest("tr.result-row");
            if (row) row.classList.toggle("selected-row", checkbox.checked);
            updateSelectAllState();
        });
    });

    tbody.querySelectorAll("tr.result-row").forEach((row) => {
        row.addEventListener("click", (event) => {
            if (event.target.closest(".btn-view-exp") || event.target.closest(".match-toggle-btn") || event.target.closest(".td-checkbox")) return;
            viewExperiment(row.dataset.experimentId, row.dataset.ownerUid);
        });
    });

    tbody.querySelectorAll(".match-toggle-btn").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            const targetId = button.dataset.target;
            const detailsRow = document.getElementById(targetId);
            if (!detailsRow) return;
            const isOpen = detailsRow.hidden;
            detailsRow.hidden = !isOpen;
            detailsRow.classList.toggle("open", isOpen);
            button.classList.toggle("open", isOpen);
            button.setAttribute("aria-expanded", String(isOpen));
        });
    });

    updateSelectionUI();
    updateSelectAllState();
}

function updateResultsStats() {
    const stats = document.getElementById("results-stats");
    if (stats) stats.style.display = "flex";

    setText("results-count", filteredExperiments.length);

    const searchTerm = document.getElementById("smart-search-input")?.value.trim() || "";
    const termDisplay = document.getElementById("search-term-display");
    if (termDisplay) {
        termDisplay.textContent = searchTerm ? ` עבור "${searchTerm}"` : "";
    }

    const ownCount = filteredExperiments.filter((exp) => exp.source === "own").length;
    const sharedCount = filteredExperiments.filter((exp) => exp.source === "shared").length;
    const publicCount = filteredExperiments.filter((exp) => exp.source === "public" || exp.source === "admin").length;

    updateStatBadge("stat-own", "stat-own-count", ownCount);
    updateStatBadge("stat-shared", "stat-shared-count", sharedCount);
    updateStatBadge("stat-public", "stat-public-count", publicCount);
}

function updateStatBadge(wrapperId, countId, count) {
    const wrapper = document.getElementById(wrapperId);
    setText(countId, count);
    if (wrapper) wrapper.style.display = count > 0 ? "inline-flex" : "none";
}

function renderSourceBadge(source) {
    const config = {
        own: { className: "own", icon: "fa-user-check", label: "שלי" },
        shared: { className: "shared", icon: "fa-users", label: "שותף/ה" },
        public: { className: "public-exp", icon: "fa-globe", label: "ציבורי" },
        admin: { className: "public-exp", icon: "fa-shield-halved", label: "ניהול" }
    }[source] || { className: "public-exp", icon: "fa-globe", label: "ציבורי" };

    return `
        <span class="source-badge ${config.className}">
            <i class="fas ${config.icon}"></i>
            ${config.label}
        </span>
    `;
}

function renderVisibilityBadge(data) {
    const isPrivate = data?.visibility === "private" && isPrivateStillActive(data.privateUntil);
    const className = isPrivate ? "private" : "public";
    const icon = isPrivate ? "fa-lock" : "fa-globe";
    const label = isPrivate ? "חסוי" : "חשוף";

    return `
        <span class="vis-badge ${className}">
            <i class="fas ${icon}"></i>
            ${label}
        </span>
    `;
}

function renderScore(score) {
    if (typeof score !== "number") {
        return '<span class="score-indicator"><span class="score-dot excellent"></span>מלאה</span>';
    }

    const percentage = Math.max(0, Math.min(100, Math.round((1 - score) * 100)));
    let level = "fair";
    if (score <= 0.25) level = "excellent";
    else if (score <= 0.55) level = "good";

    return `
        <span class="score-indicator">
            <span class="score-dot ${level}"></span>
            ${percentage}%
        </span>
    `;
}

function renderMatchInsights(experiment, fuseResult, searchWords) {
    if (!searchWords.length || !fuseResult?.matches?.length) return "";
    const insights = getMatchInsights(experiment, fuseResult);
    if (!insights.length) return "";
    const detailsRowId = getMatchDetailsRowId(experiment);
    const totalCount = insights.length;
    return `
        <div class="match-insights-wrapper">
            <button type="button" class="match-toggle-btn" data-target="${detailsRowId}" aria-expanded="false" aria-controls="${detailsRowId}">
                <i class="fas fa-location-dot"></i>
                <span>${totalCount} מקורות התאמה</span>
                <i class="fas fa-chevron-down match-toggle-chevron"></i>
            </button>
        </div>
    `;
}

function renderMatchDetailsRow(experiment, fuseResult, searchWords) {
    if (!searchWords.length || !fuseResult?.matches?.length) return "";

    const insights = getMatchInsights(experiment, fuseResult);
    if (!insights.length) return "";

    const detailsRowId = getMatchDetailsRowId(experiment);

    return `
        <tr class="match-details-row" id="${detailsRowId}" hidden>
            <td class="match-details-cell" colspan="10">
                <div class="match-details-list" role="region" aria-label="מקורות התאמה עבור ${escapeHtml(experiment.experimentName || 'ניסוי ללא שם')}">
                    ${insights.map((insight) => `
                        <div class="match-source-card">
                            <div class="match-source-icon" aria-hidden="true">
                                <i class="fas fa-location-dot"></i>
                            </div>
                            <div class="match-source-content">
                                <div class="match-source-label">נמצא ב: ${escapeHtml(insight.label)}</div>
                                <div class="match-source-snippet">${insight.snippet}</div>
                            </div>
                        </div>
                    `).join("")}
                </div>
            </td>
        </tr>
    `;
}

function getMatchDetailsRowId(experiment) {
    const rawKey = experiment.searchKey || `${experiment.ownerUid || ''}-${experiment.id || ''}`;
    const safeKey = String(rawKey).replace(/[^a-zA-Z0-9_-]/g, "-");
    return `match-details-${safeKey}`;
}

function getMatchInsights(experiment, fuseResult) {
    const insights = [];
    const seen = new Set();

    fuseResult.matches.forEach((match) => {
        const insight = buildInsightFromMatch(experiment, match);
        if (!insight) return;

        const dedupeKey = `${insight.label}:${stripHtml(insight.snippet)}`;
        if (seen.has(dedupeKey)) return;

        seen.add(dedupeKey);
        insights.push(insight);
    });

    return insights.sort((a, b) => b.specificity - a.specificity);
}

function buildInsightFromMatch(experiment, match) {
    const key = String(match.key || "");

    if (key === "searchBlocks.value") {
        const block = typeof match.refIndex === "number"
            ? experiment.searchBlocks?.[match.refIndex]
            : experiment.searchBlocks?.find((item) => item.value === match.value);
        if (!block?.value) return null;

        return {
            label: block.label || DIRECT_SEARCH_LABELS[key],
            snippet: renderIndexedSnippet(block.value, match.indices || []),
            specificity: 3
        };
    }

    const rawValue = match.value || experiment[key];
    if (!rawValue) return null;

    return {
        label: DIRECT_SEARCH_LABELS[key] || key,
        snippet: renderIndexedSnippet(rawValue, match.indices || []),
        specificity: key === "fullText" ? 1 : 2
    };
}

function renderIndexedSnippet(value, indices) {
    const text = stringValue(value).replace(/\s+/g, " ");
    if (!text) return "";

    if (!indices?.length) {
        return escapeHtml(text.length > 110 ? `${text.slice(0, 110)}...` : text);
    }

    const normalizedRanges = normalizeRanges(indices);
    if (!normalizedRanges.length) {
        return escapeHtml(text.length > 110 ? `${text.slice(0, 110)}...` : text);
    }

    const firstRange = normalizedRanges[0];
    const lastRange = normalizedRanges[Math.min(normalizedRanges.length - 1, 2)];
    const snippetStart = Math.max(0, firstRange[0] - 38);
    const snippetEnd = Math.min(text.length, lastRange[1] + 48);
    const snippet = text.slice(snippetStart, snippetEnd);
    const relativeRanges = normalizedRanges
        .map(([start, end]) => [
            Math.max(0, start - snippetStart),
            Math.min(snippet.length - 1, end - snippetStart)
        ])
        .filter(([start, end]) => start <= end);

    return `${snippetStart > 0 ? "..." : ""}${highlightByRanges(snippet, relativeRanges)}${snippetEnd < text.length ? "..." : ""}`;
}

function normalizeRanges(indices) {
    const sorted = indices
        .filter((range) => Array.isArray(range) && range.length === 2)
        .map(([start, end]) => [Number(start), Number(end)])
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start <= end)
        .sort((a, b) => a[0] - b[0]);

    return sorted.reduce((merged, range) => {
        const last = merged[merged.length - 1];
        if (!last || range[0] > last[1] + 1) {
            merged.push(range);
        } else {
            last[1] = Math.max(last[1], range[1]);
        }
        return merged;
    }, []);
}

function highlightByRanges(text, ranges) {
    if (!ranges.length) return escapeHtml(text);

    let html = "";
    let cursor = 0;

    ranges.forEach(([start, end]) => {
        if (start > cursor) html += escapeHtml(text.slice(cursor, start));
        html += `<mark class="fuse-highlight">${escapeHtml(text.slice(start, end + 1))}</mark>`;
        cursor = end + 1;
    });

    if (cursor < text.length) html += escapeHtml(text.slice(cursor));
    return html;
}

function viewExperiment(experimentId, ownerUid) {
    if (!experimentId) return;

    try {
        localStorage.setItem(
            ACTIVE_EXPERIMENT_CONTEXT_KEY,
            JSON.stringify({ experimentId, ownerUid: ownerUid || currentUser.uid })
        );
    } catch (error) {
        console.warn("Could not persist active experiment context", error);
    }

    if (!ownerUid || ownerUid === currentUser.uid) {
        window.location.href = `experiment.html?id=${encodeURIComponent(experimentId)}`;
        return;
    }

    window.location.href = `experiment.html?id=${encodeURIComponent(experimentId)}&owner=${encodeURIComponent(ownerUid)}`;
}

function getCurrentViewExperiments() {
    return currentView === "shared" ? sharedOnlyExperiments : allExperiments;
}

function setActiveTab() {
    document.querySelectorAll(".view-tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.view === currentView);
    });
}

function updateTabCounts() {
    setText("count-all", allExperiments.length);
    setText("count-shared", sharedOnlyExperiments.length);
}

function showLoading() {
    const loading = document.getElementById("loading-state");
    if (loading) loading.style.display = "flex";
    const table = document.getElementById("results-table-wrapper");
    if (table) table.style.display = "none";
    const empty = document.getElementById("empty-state");
    if (empty) empty.style.display = "none";
}

function hideLoading() {
    const loading = document.getElementById("loading-state");
    if (loading) loading.style.display = "none";
}

function showEmptyState() {
    const empty = document.getElementById("empty-state");
    if (empty) empty.style.display = "block";
}

function updateClearButtonVisibility() {
    const input = document.getElementById("smart-search-input");
    const button = document.getElementById("btn-clear-search");
    if (!button) return;
    button.classList.toggle("visible", Boolean(input?.value));
}

function updateThresholdLabel() {
    const range = document.getElementById("fuse-threshold");
    const label = document.getElementById("fuse-threshold-value");
    if (!range || !label) return;
    label.textContent = getFuseThreshold().toFixed(2).replace(/0$/, "");
}

function updateLogicalModeLabels() {
    // Function to update labels dynamically if needed in the future
    // Currently labels are static in HTML
}

function getFuseThreshold() {
    const value = Number(document.getElementById("fuse-threshold")?.value || 40);
    return Math.max(0, Math.min(1, value / 100));
}

function getSelectedSearchFields() {
    return Array.from(document.querySelectorAll('#search-fields-grid input[type="checkbox"]:checked'))
        .map((input) => input.value)
        .filter(Boolean);
}

function selectFallbackSearchField() {
    const checkbox = document.querySelector('#search-fields-grid input[value="searchBlocks.value"]');
    if (!checkbox) return;
    checkbox.checked = true;
    checkbox.closest(".search-field-check")?.classList.add("checked");
}

function splitSearchTerms(value) {
    return String(value || "")
        .trim()
        .split(/\s+/)
        .map((word) => word.trim())
        .filter(Boolean);
}

function highlightText(value, words) {
    const text = stringValue(value) || "";
    if (!words.length) return escapeHtml(text);

    const escapedWords = words
        .map(escapeRegExp)
        .filter(Boolean);
    if (!escapedWords.length) return escapeHtml(text);

    const pattern = new RegExp(`(${escapedWords.join("|")})`, "gi");
    return escapeHtml(text).replace(pattern, '<mark class="fuse-highlight">$1</mark>');
}

function uniqueSortedValues(items, key, numericDesc = false) {
    const values = Array.from(new Set(items.map((item) => item[key]).filter(Boolean)));
    return values.sort((a, b) => {
        if (numericDesc) return Number(b) - Number(a);
        return a.localeCompare(b, "he");
    });
}

function buildSearchBlocks(value, path = [], seen = new WeakSet()) {
    if (value === null || value === undefined) return [];

    if (isPrimitiveSearchValue(value) || isTimestampLike(value)) {
        const displayValue = formatSearchValue(value);
        if (!displayValue || path.length === 0) return [];

        return [{
            path: path.join("."),
            label: buildPathLabel(path),
            value: displayValue
        }];
    }

    if (Array.isArray(value)) {
        if (value.every((item) => isPrimitiveSearchValue(item) || isTimestampLike(item))) {
            const displayValue = value.map(formatSearchValue).filter(Boolean).join(", ");
            if (!displayValue || path.length === 0) return [];

            return [{
                path: path.join("."),
                label: buildPathLabel(path),
                value: displayValue
            }];
        }

        return value.flatMap((item, index) => buildSearchBlocks(item, path.concat(`[${index + 1}]`), seen));
    }

    if (typeof value === "object") {
        if (seen.has(value)) return [];
        seen.add(value);

        return Object.entries(value).flatMap(([key, item]) => {
            if (SEARCH_BLOCK_SKIP_KEYS.has(key) || /url|downloadURL|filePath/i.test(key)) return [];
            return buildSearchBlocks(item, path.concat(key), seen);
        });
    }

    return [];
}

function isPrimitiveSearchValue(value) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function formatSearchValue(value) {
    if (value === null || value === undefined) return "";

    if (isTimestampLike(value)) {
        const date = timestampToDate(value);
        return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString("he-IL") : "";
    }

    if (typeof value === "boolean") return value ? "כן" : "לא";
    return stringValue(value);
}

function buildPathLabel(path) {
    const labels = path.map((segment, index) => {
        const arrayMatch = String(segment).match(/^\[(\d+)\]$/);
        if (arrayMatch) {
            const previous = path[index - 1];
            return previous === "byTreatment" ? `טיפול ${arrayMatch[1]}` : `פריט ${arrayMatch[1]}`;
        }

        if (PATH_LABELS[segment] !== undefined) return PATH_LABELS[segment];
        return formatUnknownFieldLabel(segment);
    }).filter(Boolean);

    return labels.filter((label, index) => label !== labels[index - 1]).join(" > ");
}

function formatUnknownFieldLabel(key) {
    return stringValue(key)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim();
}

function collectPrimitiveText(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return "";

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    const date = timestampToDate(value);
    if (date && !Number.isNaN(date.getTime()) && isTimestampLike(value)) {
        return date.toLocaleDateString("he-IL");
    }

    if (Array.isArray(value)) {
        return value.map((item) => collectPrimitiveText(item, seen)).filter(Boolean).join(" ");
    }

    if (typeof value === "object") {
        if (seen.has(value)) return "";
        seen.add(value);

        return Object.entries(value)
            .filter(([key]) => !/url|downloadURL|filePath/i.test(key))
            .map(([, item]) => collectPrimitiveText(item, seen))
            .filter(Boolean)
            .join(" ");
    }

    return "";
}

function isTimestampLike(value) {
    return Boolean(value && typeof value === "object" && (
        typeof value.toDate === "function"
        || typeof value.seconds === "number"
        || value instanceof Date
    ));
}

function formatPartnerForSearch(partner) {
    if (!partner || typeof partner !== "object") return stringValue(partner);
    return [partner.name, partner.email, partner.role].map(stringValue).filter(Boolean).join(" ");
}

function getStudyTypeLabel(value) {
    if (value === "field") return "שדה";
    if (value === "lab") return "מעבדה";
    return stringValue(value);
}

function isPrivateStillActive(privateUntil) {
    const until = timestampToDate(privateUntil);
    return Boolean(until && until > getTrustedNow());
}

function getOwnerUidFromExperimentPath(path) {
    const parts = String(path || "").split("/");
    const usersIndex = parts.indexOf("users");
    if (usersIndex === -1) return "";
    return parts[usersIndex + 1] || "";
}

function getExperimentKey(ownerUid, experimentId) {
    return `${ownerUid || ""}:${experimentId || ""}`;
}

function setSelectValue(id, value) {
    const select = document.getElementById(id);
    if (select) select.value = value;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
}

function stringValue(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function escapeHtml(value) {
    return stringValue(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeRegExp(value) {
    return stringValue(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHtml(value) {
    return stringValue(value).replace(/<[^>]*>/g, "");
}

// ═══════════════════════════════════════
// Selection Management for Smart Export
// ═══════════════════════════════════════
const SMART_EXPORT_SESSION_KEY = 'smart-export-selections';
const SMART_EXPORT_EXTRACT_FILES_KEY = 'smart-export-extract-files';

function toggleExperimentSelection(expKey) {
    if (selectedExperiments.has(expKey)) {
        selectedExperiments.delete(expKey);
    } else {
        const experiment = findExperimentByKey(expKey);
        if (experiment) {
            selectedExperiments.set(expKey, experiment);
        }
    }
    updateSelectionUI();
}

function toggleSelectAll() {
    const selectAllCheckbox = document.getElementById("select-all-checkbox");
    if (!selectAllCheckbox) return;

    if (selectAllCheckbox.checked) {
        filteredExperiments.forEach((exp) => {
            const key = getExperimentKey(exp.ownerUid, exp.id);
            selectedExperiments.set(key, exp);
        });
    } else {
        filteredExperiments.forEach((exp) => {
            const key = getExperimentKey(exp.ownerUid, exp.id);
            selectedExperiments.delete(key);
        });
    }
    updateSelectionUI();
    updateRowCheckboxes();
}

function clearSelection() {
    selectedExperiments.clear();
    updateSelectionUI();
    updateRowCheckboxes();
    const selectAllCheckbox = document.getElementById("select-all-checkbox");
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
}

function updateSelectionUI() {
    const bar = document.getElementById("selection-action-bar");
    const countEl = document.getElementById("selection-bar-count");
    const count = selectedExperiments.size;

    if (countEl) countEl.textContent = count;
    if (bar) bar.classList.toggle("visible", count > 0);
}

function updateRowCheckboxes() {
    document.querySelectorAll(".exp-checkbox").forEach((checkbox) => {
        const key = checkbox.dataset.expKey;
        const isSelected = selectedExperiments.has(key);
        checkbox.checked = isSelected;
        const row = checkbox.closest("tr.result-row");
        if (row) row.classList.toggle("selected-row", isSelected);
    });
    updateSelectAllState();
}

function updateSelectAllState() {
    const selectAllCheckbox = document.getElementById("select-all-checkbox");
    if (!selectAllCheckbox) return;

    const visibleCheckboxes = document.querySelectorAll(".exp-checkbox");
    const allChecked = visibleCheckboxes.length > 0 && Array.from(visibleCheckboxes).every((cb) => cb.checked);
    selectAllCheckbox.checked = allChecked;
}

function findExperimentByKey(key) {
    return allExperiments.find((exp) => getExperimentKey(exp.ownerUid, exp.id) === key) || null;
}

function showExportSummaryModal() {
    const overlay = document.getElementById("export-modal-overlay");
    if (overlay) {
        // Update the zip header label with the count of selected experiments
        const zipLabel = document.getElementById("modal-zip-name-label");
        if (zipLabel) {
            zipLabel.textContent = `שליפה_חכמה_חץ.zip (${selectedExperiments.size} ניסויים)`;
        }

        // Dynamically build the folder structure representing selected experiments inside the ZIP
        const foldersContainer = document.getElementById("modal-experiment-folders-list");
        if (foldersContainer) {
            const selectedList = Array.from(selectedExperiments.values());
            const visibleCount = 4;
            
            const usedNames = new Set();
            let html = "";
            selectedList.slice(0, visibleCount).forEach((exp) => {
                const rawName = exp.experimentName || exp.data?.experimentName || "ניסוי ללא שם";
                
                // Sanitize exactly as done in smart-export.js
                let sanitizedName = String(rawName).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').substring(0, 100);
                if (usedNames.has(sanitizedName)) {
                    let counter = 2;
                    let candidate = `${sanitizedName}_${counter}`;
                    while (usedNames.has(candidate)) {
                        counter++;
                        candidate = `${sanitizedName}_${counter}`;
                    }
                    sanitizedName = candidate;
                }
                usedNames.add(sanitizedName);
                
                html += `
                    <div class="explorer-item folder" title="${escapeHtml(rawName)}">
                        <i class="fas fa-folder"></i>
                        <span class="folder-name">${escapeHtml(sanitizedName)}/</span>
                    </div>
                `;
            });
            
            if (selectedList.length > visibleCount) {
                const remaining = selectedList.length - visibleCount;
                html += `
                    <div class="explorer-item folder-more" title="עוד ${remaining} תיקיות ניסויים">
                        <i class="fas fa-folder-plus"></i>
                        <span class="folder-name">עוד ${remaining} ניסויים...</span>
                    </div>
                `;
            }
            
            foldersContainer.innerHTML = html || `<div style="grid-column: 1 / -1; color: var(--neutral-400); font-size:12px; text-align:center; padding: 10px;">לא נבחרו ניסויים</div>`;
        }

        overlay.classList.add("visible");
    }
}

function hideExportModal() {
    const overlay = document.getElementById("export-modal-overlay");
    if (overlay) overlay.classList.remove("visible");
}

function proceedToSmartExport() {
    const selections = Array.from(selectedExperiments.values()).map((exp) => ({
        id: exp.id,
        ownerUid: exp.ownerUid,
        name: exp.experimentName || exp.data?.experimentName || '',
        researcher: exp.leadResearcher || exp.data?.leadResearcher || ''
    }));

    const extractFromFiles = document.getElementById('chk-extract-from-files')?.checked || false;

    sessionStorage.setItem(SMART_EXPORT_SESSION_KEY, JSON.stringify(selections));
    sessionStorage.setItem(SMART_EXPORT_EXTRACT_FILES_KEY, JSON.stringify(extractFromFiles));
    window.location.href = 'smart-export.html';
}

async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Error signing out:", error);
        showToast("שגיאה בהתנתקות", "error");
    }
} 
 
----- js\system-tour.js ----- 
// js/system-tour.js
// מודול מדריך למשתמש (System Tour) - מבוסס Driver.js
// ניתן לשנות ולהרחיב קובץ זה בלבד מבלי לגעת בקבצים אחרים

export function initSystemTour() {
    if (!window.driver || !window.driver.js) {
        console.warn('Driver.js is not loaded');
        return;
    }

    const driver = window.driver.js.driver;

    // ===== עיצוב מותאם לסיור =====
    if (!document.getElementById('tour-custom-style')) {
        const style = document.createElement('style');
        style.id = 'tour-custom-style';
        style.innerHTML = `
            /* ---- פופאובר כללי ---- */
            .driver-popover {
                border-radius: 14px !important;
                box-shadow: 0 8px 32px rgba(10, 47, 114, 0.22), 0 2px 8px rgba(0,0,0,0.12) !important;
                border: 1.5px solid rgba(37, 99, 235, 0.15) !important;
                padding: 0 !important;
                overflow: hidden !important;
                max-width: 380px !important;
                font-family: 'Heebo', sans-serif !important;
                direction: rtl !important;
            }

            /* ---- כותרת הפופאובר ---- */
            .driver-popover-title {
                background: linear-gradient(135deg, #1e40af 0%, #2563eb 100%) !important;
                color: #fff !important;
                padding: 14px 18px 12px !important;
                font-size: 1.05rem !important;
                font-weight: 700 !important;
                letter-spacing: 0.01em !important;
                border-bottom: none !important;
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                text-align: right !important;
            }

            /* ---- תוכן הפופאובר ---- */
            .driver-popover-description {
                padding: 14px 18px !important;
                font-size: 0.92rem !important;
                color: #1e293b !important;
                line-height: 1.7 !important;
                text-align: right !important;
                direction: rtl !important;
            }

            /* ---- כפתורי ניווט ---- */
            .driver-popover-footer {
                padding: 10px 18px 14px !important;
                border-top: 1px solid #e2e8f0 !important;
                display: flex !important;
                gap: 8px !important;
                justify-content: flex-start !important;
                direction: rtl !important;
            }
            .driver-popover-next-btn,
            .driver-popover-prev-btn,
            .driver-popover-done-btn {
                border-radius: 8px !important;
                font-family: 'Heebo', sans-serif !important;
                font-size: 0.88rem !important;
                font-weight: 600 !important;
                padding: 7px 16px !important;
                border: none !important;
                cursor: pointer !important;
                transition: opacity 0.2s !important;
            }
            .driver-popover-next-btn,
            .driver-popover-done-btn {
                background: #2563eb !important;
                color: #fff !important;
            }
            .driver-popover-next-btn:hover,
            .driver-popover-done-btn:hover {
                opacity: 0.88 !important;
            }
            .driver-popover-prev-btn {
                background: #f1f5f9 !important;
                color: #334155 !important;
            }
            .driver-popover-prev-btn:hover {
                background: #e2e8f0 !important;
            }

            /* ---- מונה שלבים ---- */
            .driver-popover-progress-text {
                font-size: 0.8rem !important;
                color: #94a3b8 !important;
                margin-right: auto !important;
                align-self: center !important;
            }

            /* ---- כפתור סגירה ---- */
            .driver-popover-close-btn {
                color: rgba(255,255,255,0.7) !important;
                top: 10px !important;
                left: 12px !important;
                right: auto !important;
                font-size: 1.1rem !important;
            }
            .driver-popover-close-btn:hover {
                color: #fff !important;
            }

            /* ---- שלט הבדגש ---- */
            .tour-badge {
                display: inline-block;
                background: rgba(255,255,255,0.22);
                color: #fff;
                font-size: 0.78rem;
                font-weight: 600;
                padding: 2px 9px;
                border-radius: 20px;
                margin-right: 6px;
                vertical-align: middle;
            }

            /* ---- רשימת נקודות בתיאור ---- */
            .tour-list {
                margin: 6px 0 0 0;
                padding-right: 18px;
                list-style: none;
            }
            .tour-list li {
                margin-bottom: 4px;
                padding-right: 2px;
                position: relative;
            }
            .tour-list li::before {
                content: "←";
                position: absolute;
                right: -16px;
                color: #2563eb;
                font-size: 0.8rem;
                top: 2px;
            }

            /* ---- צבע הדגשה בטקסט ---- */
            .tour-accent {
                color: #1d4ed8;
                font-weight: 700;
            }

            /* ---- קו הפרדה קל ---- */
            .tour-divider {
                border: none;
                border-top: 1px solid #e2e8f0;
                margin: 8px 0;
            }
        `;
        document.head.appendChild(style);
    }

    // ===== שלבי הסיור =====
    const tourDriver = driver({
        showProgress: true,
        animate: true,
        allowClose: true,
        overlayColor: 'rgba(15, 35, 90, 0.65)',
        nextBtnText: 'הבא ←',
        prevBtnText: '→ הקודם',
        doneBtnText: '✓ סיום הסיור',
        progressText: 'שלב {{current}} מתוך {{total}}',

        steps: [
            // ── שלב 1: ברכה ──
            {
                element: '.dashboard-main h1',
                popover: {
                    title: '👋 ברוכים הבאים למערכת איגום נתונים - למיזם ח"ץ!',
                    description: `
                        זהו <span class="tour-accent">מסך הבית</span> שלכם — כאן מוצגים כל הניסויים שלכם,
                        גם אלו שיצרתם וגם כאלו שחוקרים אחרים שיתפו איתכם.
                        <hr class="tour-divider">
                        הסיור הקצר הבא ינחה אתכם בכל חלקי המערכת 🚀
                    `,
                    side: 'bottom',
                    align: 'start'
                }
            },

            // ── שלב 2: תפריט ניווט ──
            {
                element: '.sidebar-nav',
                popover: {
                    title: '🗂️ תפריט ניווט',
                    description: `
                        מהתפריט הצדדי תוכלו לגשת לכל חלקי המערכת:
                        <ul class="tour-list">
                            <li><span class="tour-accent">בית</span> — רשימת הניסויים שלכם</li>
                            <li><span class="tour-accent">שליפת ניסוי</span> — ייצוא נתונים לאקסל</li>
                            <li><span class="tour-accent">הסטטיסטיקה שלי</span> — גרפים וניתוחי BI אישיים</li>
                        </ul>
                    `,
                    side: 'left',
                    align: 'center'
                }
            },

            // ── שלב 3: מקרא ──
            {
                element: '.experiments-legend',
                popover: {
                    title: '🏷️ זיהוי סוג הניסוי',
                    description: `
                        כל ניסוי מסומן בצבע שונה כדי להבחין בקלות:
                        <ul class="tour-list">
                            <li>סמל <span class="tour-accent">ירוק (✔️)</span> — ניסוי שאתם הקמתם</li>
                            <li>סמל <span class="tour-accent">כחול (👥)</span> — ניסוי שחוקר אחר שיתף אתכם בו</li>
                        </ul>
                        <hr class="tour-divider">
                        בניסויים משותפים תוכלו לראות וגם לערוך נתונים (בהתאם להרשאות).
                    `,
                    side: 'bottom',
                    align: 'center'
                }
            },

            // ── שלב 4: כפתור ניסוי חדש ──
            {
                element: '#add-experiment-btn',
                popover: {
                    title: '🧪 יצירת ניסוי חדש',
                    description: `
                        <strong>לחצו על הריבוע הזה</strong> כדי להתחיל תיעוד ניסוי חדש.
                        <hr class="tour-divider">
                        תוכלו ליצור כמה ניסויים שתרצו — כל ניסוי מאוחסן בנפרד ואפשר לעבוד עליו מכל מקום.
                    `,
                    side: 'right',
                    align: 'center'
                },
                onNextClick: () => {
                    document.getElementById('add-experiment-btn').click();
                    setTimeout(() => tourDriver.moveNext(), 400);
                }
            },

            // ── שלב 5: מודאל יצירת ניסוי ──
            {
                element: '#new-experiment-modal .modal',
                popover: {
                    title: '✏️ שם הניסוי',
                    description: `
                        הזינו <span class="tour-accent">שם תיאורי לניסוי</span> (למשל: "עגבניות חממה 2025")
                        ולחצו על <strong>"יצירת ניסוי"</strong>.
                        <hr class="tour-divider">
                        לאחר הלחיצה תועברו ישירות לדף הניסוי שבו תוכלו למלא את כל הפרטים.
                    `,
                    side: 'top',
                    align: 'center'
                },
                onDeselected: () => {
                    const modal = document.getElementById('new-experiment-modal');
                    if (modal && !modal.classList.contains('hidden')) {
                        modal.classList.add('hidden');
                    }
                },
                onNextClick: () => {
                    const modal = document.getElementById('new-experiment-modal');
                    if (modal && !modal.classList.contains('hidden')) {
                        modal.classList.add('hidden');
                    }
                    tourDriver.moveNext();
                }
            },

            // ── שלב 6: שליפה לאקסל ──
            {
                element: 'a[href="export.html"]',
                popover: {
                    title: '📊 שליפת נתונים לאקסל',
                    description: `
                        בסיום (או בכל שלב) תוכלו לייצא את נתוני הניסוי לאקסל דרך
                        <span class="tour-accent">שליפת ניסוי</span> בתפריט.
                        <hr class="tour-divider">
                        בחרו ניסוי, סמנו אילו נתונים לייצא — והקובץ יורד ישירות למחשב שלכם.
                    `,
                    side: 'left',
                    align: 'center'
                }
            },

            // ── שלב 7: סיום ──
            {
                element: '.sidebar-footer',
                popover: {
                    title: '✅ מוכנים להתחיל!',
                    description: `
                        אתם מוכנים לעבוד עם מערכת ח"ץ.
                        <hr class="tour-divider">
                        <ul class="tour-list">
                            <li>נתקלתם בבעיה? השתמשו ב<span class="tour-accent">דיווח תקלות</span> כאן למטה</li>
                            <li>יש שאלות? פנו לצ'אטבוט המובנה בפינה השמאלית</li>
                            <li>בתוך כל ניסוי — לחצו על <span class="tour-accent">סיור בניסוי</span> לקבלת הדרכה מפורטת</li>
                        </ul>
                        <hr class="tour-divider">
                        <strong>בהצלחה! 🌟</strong>
                    `,
                    side: 'top',
                    align: 'start'
                }
            }
        ]
    });

    // ── מאזין לכפתור סיור במערכת ──
    const tourBtn = document.getElementById('btn-start-tour');
    if (tourBtn) {
        tourBtn.addEventListener('click', (e) => {
            e.preventDefault();

            // סגירת המודאל אם פתוח
            const modal = document.getElementById('new-experiment-modal');
            if (modal && !modal.classList.contains('hidden')) {
                modal.classList.add('hidden');
            }

            // סגירת התפריט במובייל אם פתוח
            const sidebar = document.querySelector('.sidebar');
            if (sidebar && sidebar.classList.contains('open')) {
                const overlay = document.getElementById('sidebar-overlay');
                if (overlay) overlay.click();
            }

            tourDriver.drive();
        });
    }
}