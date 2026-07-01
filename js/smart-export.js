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
import { siteLabel, packageLabel } from "./labels.js";

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
        s(packageLabel(d.workPackage)),
        s(siteLabel(d.experimentSite)),
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

        (section.irrigationData || []).forEach(r => {
            recordNum++;
            const fileUrl = r.fileUrl || r.fileURL || r.downloadUrl || '';
            const zipPath = fileUrl
                ? `attachments/${ctx.folderName}/השקיה ודשן/${r.fileName || getFileNameFromUrl(fileUrl) || 'file'}`
                : '';
            rows.push([
                ctx.expId, ctx.expName, ctx.treatmentNum, ctx.treatmentName, ctx.sameForAll,
                recordNum, 'השקיה',
                s(r.fileName), s(r.uploadDate), s(r.startDate || r.measureDates), s(r.endDate),
                s(r.totalWater), '', '', '',
                s(fileUrl), zipPath, s(r.notes)
            ]);
        });

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
                    fileNameCol: 7,
                    tagCol: 6,
                    tagPrefix: label,
                    sourceFileName: rec.fileName || rec.originalFileName || rec.name || parsed.displayName || parsed.name,
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
                        fileNameCol: 12,
                        tagCol: 15,
                        sourceFileName: f.fileName || f.originalFileName || f.name || parsed.displayName || parsed.name,
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
        let wb;
        if (ext === 'csv') {
            // CSV: read as text first so Hebrew/UTF-8 content is decoded correctly.
            // Reading raw bytes causes SheetJS to default to Latin-1, garbling
            // non-ASCII headers and making column matching impossible.
            const text = await blob.text();            // Blob.text() decodes as UTF-8
            wb = XLSX.read(text, { type: 'string' });  // SheetJS accepts string input
        } else {
            // Excel binary formats (xlsx/xls) embed their own encoding — safe to
            // read as raw bytes.
            const buf = await blob.arrayBuffer();
            wb = XLSX.read(buf, { type: 'array' });
        }
        const sheetName = wb.SheetNames[0];
        if (!sheetName) return null;
        const ws = wb.Sheets[sheetName];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        const nonEmpty = aoa.filter(row => Array.isArray(row) && row.some(c => s(c) !== ''));
        if (nonEmpty.length < 2) return null; // need a header row + at least one data row
        const headers = (nonEmpty[0] || []).map(h => s(h));
        const rows = nonEmpty.slice(1);
        console.log(`[extract] parsed ${fileName}: ${headers.length} columns, ${rows.length} data rows, headers:`, headers);
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
        refObj.originalFileName,
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

    if (pool.length === 1) return pool[0];
    return null;
}

// Normalize a column header for exact-but-punctuation-insensitive comparison
// (so 'סה"כ כמות דשן' and 'סה״כ כמות דשן' are treated as equal).
function normalizeHeader(value) {
    return s(value)
        .replace(/["'״׳`]/g, '')
        .replace(/\s*\/\s*/g, ' / ')   // normalize spaces around /
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeFileRef(value) {
    let out = s(value);
    if (!out) return '';
    try { out = decodeURIComponent(out); } catch { /* keep raw */ }
    // Strip Firebase Storage download-URL prefix.
    // Actual format: https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>
    out = out.replace(/^https?:\/\/[^/]+\/v0\/b\/[^/]+\/o\//, '');
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