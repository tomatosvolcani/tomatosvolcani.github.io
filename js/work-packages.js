// js/work-packages.js
// דף "חבילות עבודה": מציג את הניסויים של חבילת עבודה נבחרת, לפי הרשאות המשתמש.
//
// חשוב לגבי הרשאות: ייעוד "ראש חבילת עבודה" אינו מרחיב הרשאות קריאה. גם ראש
// חבילה רואה כאן רק ניסויים חשופים, ניסויים שלו וניסויים ששותפו איתו — ניסוי
// חסוי נשאר חסוי. הכללים ב-most_updated_firestore_security_rules.txt הם
// האכיפה בפועל; הקוד כאן רק בונה שאילתות שאינן חורגות מהן.

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    collectionGroup,
    doc,
    getDoc,
    getDocsFromServer,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from "./toast.js";
import { formatDateIL } from "./date-utils.js";
import { initServerTime, getTrustedNow } from "./server-time.js";
import { isExperimentPublic, timestampToDate } from "./permissions-utils.js";
import { siteLabel, packageLabel } from "./labels.js?v=20260726-4";
import {
    getLeadResearchersSearchText,
    getLeadResearchersText
} from "./lead-researchers.js?v=20260818-1";
import { checkAdminAccess } from "./admin-status.js?v=20260826-2";
import {
    WORK_PACKAGE_CODES,
    loadWorkPackageLeads,
    getLeadPackagesForUser,
    getWorkPackageLeadText,
    isWorkPackageLead
} from "./work-package-leads.js?v=20260825-1";

const ACTIVE_EXPERIMENT_CONTEXT_KEY = 'research-map-active-experiment-context';
const PAGE_SIZE = 15;

// אותה היררכיה כמו ב-smart-search.js: המקור החזק ביותר קובע בעת איחוד כפילויות.
const SOURCE_PRIORITY = {
    own: 4,
    shared: 3,
    admin: 2,
    public: 1
};

const SOURCE_BADGES = {
    own: { className: 'own', icon: 'fa-user-check', label: 'ניסוי שלי' },
    shared: { className: 'shared', icon: 'fa-users', label: 'שותפו איתי' },
    admin: { className: 'other', icon: 'fa-shield-halved', label: 'גישת מנהל' },
    public: { className: 'other', icon: 'fa-globe', label: 'חוקר אחר' }
};

let currentUser = null;
let userData = null;
let isAdminUser = false;
let workPackageLeads = {};
let currentWorkPackage = '';
let currentExperiments = [];
let filteredExperiments = [];
let renderedCount = 0;
let isLoadingPackage = false;
let hasWarnedAboutMissingIndex = false;

// מסלול המנהל: הסינון המועדף הוא בשרת, אבל הוא דורש אינדקס שדה-בודד בהיקף
// Collection Group על workPackage — אינדקס שאינו נוצר אוטומטית. עד שהוא קיים,
// הנסיגה היא סריקה מלאה אחת לכל טעינת דף (ולא אחת לכל החלפת חבילה).
let adminWorkPackageIndexAvailable = true;
let adminAllExperimentsPromise = null;

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    populateWorkPackageSelect();
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }

    currentUser = user;

    try {
        if (!(await verifyApprovedUser())) return;

        // חייב לרוץ לפני כל חישוב חשיפה/חסיון — אין להסתמך על שעון המחשב.
        await initServerTime(db, currentUser);
        setUserDisplayName();

        // אין לשחזר את טריק ה-Limit 2 — משתמשים בפונקציה המשותפת.
        isAdminUser = await checkAdminAccess(user);

        workPackageLeads = await loadWorkPackageLeads(db);

        // העמוד מיועד לראשי חבילות עבודה ולמנהלי מערכת — אותו קהל בדיוק שמקבל את
        // הפריט בתפריט הצדדי (ensureWorkPackagesNavigation ב-admin-status.js).
        // כל משתמש מאושר אחר מוחזר לדשבורד.
        const ledPackages = getLeadPackagesForUser(workPackageLeads, currentUser.uid);
        if (!isAdminUser && ledPackages.length === 0) {
            showToast('עמוד זה מיועד לראשי חבילות עבודה', 'warning');
            setTimeout(() => { window.location.href = "dashboard.html"; }, 1200);
            return;
        }

        renderScopeNotice();
        populateWorkPackageSelect();
        selectInitialWorkPackage();

        await loadCurrentWorkPackage();
    } catch (error) {
        console.error("Work packages initialization failed:", error);
        showToast('שגיאה בטעינת עמוד חבילות העבודה', 'error');
        hideLoading();
        showEmptyState();
    }
});

function initEventListeners() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');

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
            sidebar?.classList.remove('open');
            overlay.classList.remove('active');
            const icon = hamburgerBtn?.querySelector('i');
            if (icon) {
                icon.classList.add('fa-bars');
                icon.classList.remove('fa-times');
            }
        });
    }

    document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

    document.getElementById('wp-select')?.addEventListener('change', (event) => {
        currentWorkPackage = event.target.value;
        loadCurrentWorkPackage();
    });

    document.getElementById('wp-search-input')?.addEventListener('input', () => {
        applySearchFilter();
        renderExperiments({ reset: true });
    });

    document.getElementById('btn-load-more-wp')?.addEventListener('click', () => {
        renderExperiments({ reset: false });
    });
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
    const displayName = document.getElementById('user-display-name');
    if (!displayName) return;

    const fullName = `${userData?.firstName || ''} ${userData?.lastName || ''}`.trim();
    displayName.textContent = fullName || currentUser.email || 'משתמש';
}

// =========================================
// Work package selection
//
// ראש חבילה רואה רק את החבילות שהוא ראש שלהן. מנהל מערכת רואה את כולן.
// =========================================

/**
 * ההיקף שהמשתמש רואה בבורר החבילות אינו זהה לכל התפקידים, ולכן מנהל מערכת מקבל
 * הערה מפורשת: הבורר המלא הוא הרשאת מנהל, ולא מה שראש חבילה רואה. בלי ההערה
 * מנהל שגם מריץ בדיקות עלול להסיק שראש חבילה נחשף לכל החבילות.
 * כותרת המשנה מתוקנת באותה הזדמנות — "שבניהולך" אינו נכון למנהל שאינו ראש חבילה.
 */
function renderScopeNotice() {
    const note = document.getElementById('wp-admin-scope-note');
    if (note) note.hidden = !isAdminUser;

    // ראש חבילה אינו יכול לשנות שיוך, ולכן ההפניה לעמוד ניהול המשתמשים מוצגת
    // למנהל/ת מערכת בלבד — למי שאין לו את ההרשאה זו הפניה למבוי סתום.
    const manageHint = document.getElementById('wp-lead-manage-hint');
    if (manageHint) manageHint.hidden = !isAdminUser;

    const subtitle = document.getElementById('wp-page-subtitle');
    if (subtitle && isAdminUser) {
        subtitle.textContent = 'כל חבילות העבודה במערכת — בהרשאת מנהל/ת מערכת, לפי ההרשאות שלך';
    }
}

function getSelectableWorkPackages() {
    if (isAdminUser) return WORK_PACKAGE_CODES;

    const ledPackages = getLeadPackagesForUser(workPackageLeads, currentUser?.uid);
    // שומרים על סדר WORK_PACKAGE_CODES, ומאפשרים גם קוד היסטורי/מותאם.
    const known = WORK_PACKAGE_CODES.filter((code) => ledPackages.includes(code));
    const extra = ledPackages.filter((code) => !WORK_PACKAGE_CODES.includes(code));
    return [...known, ...extra];
}

function populateWorkPackageSelect() {
    const select = document.getElementById('wp-select');
    if (!select) return;

    const codes = getSelectableWorkPackages();
    const previousValue = select.value || currentWorkPackage;
    select.replaceChildren();

    if (codes.length === 0) {
        const option = new Option('לא שויכת לחבילת עבודה', '');
        option.disabled = true;
        select.appendChild(option);
        select.disabled = true;
        return;
    }

    codes.forEach((code) => {
        const leadText = getWorkPackageLeadText(workPackageLeads, code, { includeEmail: false });
        const label = leadText
            ? `${packageLabel(code)} — ראש חבילה: ${leadText}`
            : packageLabel(code);
        select.appendChild(new Option(label, code));
    });

    // עם חבילה אחת בלבד אין מה לבחור — משאירים את התיבה נעולה לקריאה.
    select.disabled = codes.length === 1;

    if (previousValue && codes.includes(previousValue)) {
        select.value = previousValue;
    }
}

function selectInitialWorkPackage() {
    const select = document.getElementById('wp-select');
    const codes = getSelectableWorkPackages();

    currentWorkPackage = codes[0] || '';
    if (select && currentWorkPackage) select.value = currentWorkPackage;
}

function renderLeadPanel() {
    const nameElement = document.getElementById('wp-lead-name');
    const badge = document.getElementById('wp-lead-self-badge');

    if (nameElement) {
        const leadText = getWorkPackageLeadText(workPackageLeads, currentWorkPackage);
        nameElement.textContent = leadText || 'לא הוגדר ראש חבילה';
        nameElement.className = leadText ? 'wp-lead-name' : 'wp-lead-none';
    }

    if (badge) {
        badge.hidden = !isWorkPackageLead(workPackageLeads, currentUser?.uid, currentWorkPackage);
    }
}

// =========================================
// Loading
// =========================================
async function loadCurrentWorkPackage() {
    if (!currentUser || !currentWorkPackage || isLoadingPackage) return;

    isLoadingPackage = true;
    renderLeadPanel();
    showLoading();

    try {
        // שלוש השאילתות אינן תלויות זו בזו, ולכן הן רצות במקביל. השאילתה הרוחבית
        // (מנהל/ציבוריים) היא האיטית מביניהן, ואין טעם להתחיל אותה רק אחרי שהשתיים
        // הקצרות הסתיימו.
        const fetches = [fetchSharedExperiments(currentWorkPackage)];

        // עבור מנהל, השאילתה הרוחבית כבר מחזירה את הניסויים שלו ומתייגת אותם
        // 'own', ולכן שאילתת "הניסויים שלי" מיותרת עבורו. שאילתת השותפות כן נחוצה
        // גם לו: היא זו שמזהה 'shared', שגובר על 'admin' באיחוד הכפילויות.
        if (!isAdminUser) fetches.push(fetchOwnExperiments(currentWorkPackage));

        fetches.push(isAdminUser
            ? fetchAdminExperiments(currentWorkPackage)
            : fetchPublicExperiments(currentWorkPackage));

        const results = await Promise.all(fetches);

        currentExperiments = dedupeExperiments(results.flat());
        updateStatistics();
        applySearchFilter();
        renderExperiments({ reset: true });
    } catch (error) {
        console.error("Error loading work package experiments:", error);
        showToast('שגיאה בטעינת הניסויים של חבילת העבודה', 'error');
        currentExperiments = [];
        filteredExperiments = [];
        updateStatistics();
        showEmptyState();
    } finally {
        hideLoading();
        isLoadingPackage = false;
    }
}

async function fetchOwnExperiments(workPackage) {
    // שאילתה בתוך אוסף בודד — Firestore מתחזק אינדקס שדה-בודד אוטומטית.
    const ownQuery = query(
        collection(db, "users", currentUser.uid, "experiments"),
        where("workPackage", "==", workPackage)
    );
    const snapshot = await getDocsFromServer(ownQuery);

    return snapshot.docs.map((docSnap) => normalizeExperiment({
        id: docSnap.id,
        ownerUid: currentUser.uid,
        data: docSnap.data(),
        source: 'own'
    }));
}

async function fetchSharedExperiments(workPackage) {
    const sharedSnapshot = await getDocsFromServer(collection(db, "users", currentUser.uid, "sharedExperiments"));

    const results = await Promise.all(sharedSnapshot.docs.map(async (sharedDoc) => {
        const sharedData = sharedDoc.data();
        const ownerUid = sharedData.ownerUid;
        const experimentId = sharedData.experimentId || sharedDoc.id;
        if (!ownerUid || !experimentId) return null;

        // cachedExperiment הוא תמונת מצב חלקית (ללא visibility/privateUntil).
        // משתמשים בו רק כשהוא באמת מכיל workPackage; אחרת קוראים את המקור.
        const cached = sharedData.cachedExperiment;
        if (cached && typeof cached === 'object' && 'workPackage' in cached) {
            if (cached.workPackage !== workPackage) return null;
            return normalizeExperiment({
                id: experimentId,
                ownerUid,
                data: cached,
                source: 'shared',
                partialData: true
            });
        }

        // מצביע ללא cachedExperiment שמיש — משלימים בקריאה ישירה, ומדלגים בשקט
        // על הרשאה שנשללה (מצביע יתום).
        try {
            const originalSnap = await getDoc(doc(db, "users", ownerUid, "experiments", experimentId));
            if (!originalSnap.exists()) return null;

            const data = originalSnap.data();
            if (data.workPackage !== workPackage) return null;

            return normalizeExperiment({
                id: experimentId,
                ownerUid,
                data,
                source: 'shared'
            });
        } catch (error) {
            if (error?.code !== 'permission-denied') {
                console.warn("Could not load shared experiment", experimentId, error);
            }
            return null;
        }
    }));

    return results.filter(Boolean);
}

async function fetchPublicExperiments(workPackage) {
    // הכללים דורשים שכל מסמך בתוצאה יהיה קריא, ולכן חייבים לסנן ל-public
    // בשאילתה עצמה — בלי זה ניסוי חסוי בחבילה היה מפיל את כל השאילתה.
    let docs = [];

    try {
        const compoundQuery = query(
            collectionGroup(db, "experiments"),
            where("visibility", "==", "public"),
            where("workPackage", "==", workPackage)
        );
        docs = (await getDocsFromServer(compoundQuery)).docs;
    } catch (error) {
        if (error?.code !== 'failed-precondition') throw error;

        // חסר אינדקס Collection Group מורכב (visibility ASC, workPackage ASC).
        // נסיגה לשאילתה שכבר מאונדקסת + סינון בצד לקוח, כמו ב-smart-search.js.
        if (!hasWarnedAboutMissingIndex) {
            hasWarnedAboutMissingIndex = true;
            console.warn(
                'Missing composite collection-group index (visibility, workPackage) — ' +
                'falling back to a visibility-only query with client-side filtering. ' +
                'Create the index from the link in the Firestore error above.',
                error
            );
        }

        const fallbackQuery = query(
            collectionGroup(db, "experiments"),
            where("visibility", "==", "public")
        );
        docs = (await getDocsFromServer(fallbackQuery)).docs
            .filter((docSnap) => docSnap.data()?.workPackage === workPackage);
    }

    return docs
        .map((docSnap) => {
            const ownerUid = getOwnerUidFromExperimentPath(docSnap.ref.path);
            if (!ownerUid || ownerUid === currentUser.uid) return null;

            return normalizeExperiment({
                id: docSnap.id,
                ownerUid,
                data: docSnap.data(),
                source: 'public'
            });
        })
        .filter(Boolean);
}

/** { id, ownerUid, data } מתוך מסמך של שאילתת Collection Group. */
function toExperimentEntry(docSnap) {
    return {
        id: docSnap.id,
        ownerUid: getOwnerUidFromExperimentPath(docSnap.ref.path),
        data: docSnap.data()
    };
}

function toAdminExperiment(entry) {
    return normalizeExperiment({
        id: entry.id,
        ownerUid: entry.ownerUid,
        data: entry.data,
        source: entry.ownerUid === currentUser.uid ? 'own' : 'admin'
    });
}

/**
 * סריקה מלאה של כל הניסויים במערכת, ממוזכרת לכל טעינת דף.
 *
 * זו נסיגה בלבד, למצב שבו אין אינדקס Collection Group על workPackage. המזכר הוא
 * העיקר כאן: בלעדיו כל החלפת חבילה בבורר הייתה מורידה מחדש את אותם מסמכים בדיוק,
 * כך שמעבר על שש החבילות עלה בשש סריקות מלאות של המערכת.
 */
function loadAllExperimentsForAdmin() {
    if (!adminAllExperimentsPromise) {
        adminAllExperimentsPromise = getDocsFromServer(collectionGroup(db, "experiments"))
            .then((snapshot) => snapshot.docs
                .map(toExperimentEntry)
                .filter((entry) => Boolean(entry.ownerUid)))
            .catch((error) => {
                // כישלון אינו נשמר במזכר, אחרת הדף היה נעול על השגיאה עד רענון.
                adminAllExperimentsPromise = null;
                throw error;
            });
    }

    return adminAllExperimentsPromise;
}

async function fetchAdminExperiments(workPackage) {
    // המסלול המועדף: הסינון נעשה בשרת, ולכן נקראים רק הניסויים של החבילה המבוקשת
    // ולא כל הניסויים במערכת. דורש אינדקס שדה-בודד בהיקף Collection Group על
    // workPackage — Firestore יוצר אינדקסים אוטומטיים בהיקף אוסף בודד בלבד, כך
    // שאת זה יש ליצור פעם אחת (בדיוק כמו שנעשה עבור visibility). כל עוד הוא חסר,
    // Firestore מחזיר failed-precondition ואנחנו נופלים לסריקה הממוזכרת.
    if (adminWorkPackageIndexAvailable) {
        try {
            const scopedQuery = query(
                collectionGroup(db, "experiments"),
                where("workPackage", "==", workPackage)
            );
            const snapshot = await getDocsFromServer(scopedQuery);

            return snapshot.docs
                .map(toExperimentEntry)
                .filter((entry) => Boolean(entry.ownerUid))
                .map(toAdminExperiment);
        } catch (error) {
            if (error?.code !== 'failed-precondition') throw error;

            // נבדק פעם אחת לכל טעינת דף — אין טעם לשלם הלוך-חזור כושל בכל החלפה.
            adminWorkPackageIndexAvailable = false;
            console.warn(
                'Missing single-field collection-group index on experiments.workPackage — ' +
                'falling back to one full scan of every experiment, cached for this page load. ' +
                'Create the index from the link in the Firestore error above so the admin path ' +
                'reads only the selected work package.',
                error
            );
        }
    }

    const allExperiments = await loadAllExperimentsForAdmin();

    return allExperiments
        .filter((entry) => entry.data?.workPackage === workPackage)
        .map(toAdminExperiment);
}

function getOwnerUidFromExperimentPath(path) {
    // users/{ownerUid}/experiments/{experimentId}
    const parts = String(path || '').split('/');
    return parts[0] === 'users' ? (parts[1] || '') : '';
}

function getExperimentKey(ownerUid, experimentId) {
    return `${ownerUid}:${experimentId}`;
}

function normalizeExperiment({ id, ownerUid, data, source, partialData = false }) {
    const safeData = data || {};

    return {
        id,
        ownerUid,
        source,
        data: safeData,
        // תמונת מצב מ-cachedExperiment אינה מכילה visibility/privateUntil, ולכן
        // אסור להסיק ממנה חשיפה — התג לא יוצג עבורה.
        partialData,
        key: getExperimentKey(ownerUid, id),
        experimentName: String(safeData.experimentName || '').trim(),
        creatorName: String(safeData.creatorName || '').trim(),
        leadResearchersText: getLeadResearchersText(safeData, { separator: ' • ' }),
        searchText: [
            safeData.experimentName,
            safeData.creatorName,
            getLeadResearchersSearchText(safeData),
            siteLabel(safeData.experimentSite),
            safeData.experimentSite,
            safeData.labCellNumber,
            safeData.experimentYear
        ].filter(Boolean).join(' ').toLowerCase(),
        siteText: siteLabel(safeData.experimentSite) || String(safeData.labCellNumber || '').trim(),
        experimentYear: String(safeData.experimentYear || '').trim(),
        createdAtMs: timestampToDate(safeData.createdAt)?.getTime() || 0
    };
}

function dedupeExperiments(experiments) {
    const byKey = new Map();

    experiments.forEach((experiment) => {
        const existing = byKey.get(experiment.key);
        if (!existing) {
            byKey.set(experiment.key, experiment);
            return;
        }

        // תג ה"שיוך" נקבע לפי המקור החזק ביותר (שותפות עדיפה על "חוקר אחר"),
        // אבל הנתונים עצמם נלקחים מהרשומה המלאה: תמונת מצב מ-cachedExperiment
        // חסרה שדות חשיפה, ולכן אין להעדיף אותה על המסמך המקורי.
        const strongestSource = SOURCE_PRIORITY[experiment.source] > SOURCE_PRIORITY[existing.source]
            ? experiment.source
            : existing.source;

        let winner = existing;
        if (existing.partialData && !experiment.partialData) {
            winner = experiment;
        } else if (existing.partialData === experiment.partialData
            && SOURCE_PRIORITY[experiment.source] > SOURCE_PRIORITY[existing.source]) {
            winner = experiment;
        }

        byKey.set(experiment.key, { ...winner, source: strongestSource });
    });

    return Array.from(byKey.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

// =========================================
// Filtering & statistics
// =========================================
function applySearchFilter() {
    const term = (document.getElementById('wp-search-input')?.value || '').trim().toLowerCase();
    filteredExperiments = term
        ? currentExperiments.filter((experiment) => experiment.searchText.includes(term))
        : [...currentExperiments];
}

function updateStatistics() {
    const own = currentExperiments.filter((experiment) => experiment.source === 'own').length;
    const shared = currentExperiments.filter((experiment) => experiment.source === 'shared').length;
    const other = currentExperiments.length - own - shared;

    setText('wp-stat-total', currentExperiments.length);
    setText('wp-stat-own', own);
    setText('wp-stat-shared', shared);
    setText('wp-stat-other', other);
}

// =========================================
// Rendering
// =========================================
function renderExperiments({ reset }) {
    const tbody = document.getElementById('experiments-table-body');
    const tableContainer = document.getElementById('experiments-table-container');
    const emptyState = document.getElementById('empty-state');
    if (!tbody) return;

    if (reset) {
        renderedCount = 0;
        tbody.replaceChildren();
    }

    if (filteredExperiments.length === 0) {
        if (tableContainer) tableContainer.style.display = 'none';
        if (emptyState) emptyState.style.display = 'block';
        hideLoadMoreButton();
        return;
    }

    if (tableContainer) tableContainer.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';

    const nextSlice = filteredExperiments.slice(renderedCount, renderedCount + PAGE_SIZE);
    nextSlice.forEach((experiment) => tbody.appendChild(createExperimentRow(experiment)));
    renderedCount += nextSlice.length;

    updateLoadMoreButtonVisibility();
}

function createExperimentRow(experiment) {
    const row = document.createElement('tr');
    const sourceBadge = SOURCE_BADGES[experiment.source] || SOURCE_BADGES.public;

    // תג חשיפה מוצג רק כשיש נתוני חשיפה אמיתיים. עבור רשומה מ-cachedExperiment
    // השדות visibility/privateUntil חסרים, והצגת "חשוף" הייתה מטעה.
    const visibilityBadge = experiment.partialData
        ? ''
        : (() => {
            const isPrivate = !isExperimentPublic(experiment.data, getTrustedNow());
            return `
            <span class="wp-badge ${isPrivate ? 'private' : 'public'}">
                <i class="fas ${isPrivate ? 'fa-lock' : 'fa-globe'}" aria-hidden="true"></i> ${isPrivate ? 'חסוי' : 'חשוף'}
            </span>`;
        })();

    row.innerHTML = `
        <td data-label="שם הניסוי"><strong>${escapeHtml(experiment.experimentName || 'ניסוי ללא שם')}</strong></td>
        <td class="muted-cell" data-label="חוקרים מובילים">${escapeHtml(experiment.leadResearchersText || 'לא צוין')}</td>
        <td class="muted-cell" data-label="מקים הניסוי">${escapeHtml(experiment.creatorName || 'לא צוין')}</td>
        <td class="muted-cell" data-label="אתר">${escapeHtml(experiment.siteText || 'לא צוין')}</td>
        <td class="year-cell" data-label="שנה">${escapeHtml(experiment.experimentYear || '-')}</td>
        <td data-label="שיוך">
            <span class="wp-badge ${sourceBadge.className}">
                <i class="fas ${sourceBadge.icon}" aria-hidden="true"></i> ${sourceBadge.label}
            </span>${visibilityBadge}
        </td>
        <td class="created-date-cell" data-label="תאריך יצירה">${formatDateIL(experiment.data.createdAt, 'לא ידוע')}</td>
        <td data-label="פעולות">
            <button type="button" class="view-btn">
                <i class="fas fa-eye"></i> צפייה
            </button>
        </td>
    `;

    const open = () => openExperiment(experiment);
    row.addEventListener('click', open);
    row.querySelector('.view-btn')?.addEventListener('click', (event) => {
        event.stopPropagation();
        open();
    });

    return row;
}

function openExperiment(experiment) {
    // שמירת ההקשר כדי שווידג'ט מפת המחקר יזהה את הניסוי הפעיל.
    try {
        localStorage.setItem(
            ACTIVE_EXPERIMENT_CONTEXT_KEY,
            JSON.stringify({ experimentId: experiment.id, ownerUid: experiment.ownerUid })
        );
    } catch (error) {
        console.warn('Could not persist active experiment context', error);
    }

    window.location.href = `experiment.html?id=${experiment.id}&owner=${experiment.ownerUid}`;
}

function updateLoadMoreButtonVisibility() {
    const wrapper = document.getElementById('load-more-wrapper');
    const button = document.getElementById('btn-load-more-wp');
    if (!wrapper || !button) return;

    if (renderedCount >= filteredExperiments.length) {
        wrapper.classList.add('hidden');
        return;
    }

    wrapper.classList.remove('hidden');
    button.disabled = false;
}

function hideLoadMoreButton() {
    document.getElementById('load-more-wrapper')?.classList.add('hidden');
}

function showLoading() {
    document.getElementById('loading-container')?.classList.remove('hidden');
    const tableContainer = document.getElementById('experiments-table-container');
    const emptyState = document.getElementById('empty-state');
    if (tableContainer) tableContainer.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    hideLoadMoreButton();
}

function hideLoading() {
    document.getElementById('loading-container')?.classList.add('hidden');
}

function showEmptyState() {
    const tableContainer = document.getElementById('experiments-table-container');
    const emptyState = document.getElementById('empty-state');
    if (tableContainer) tableContainer.style.display = 'none';
    if (emptyState) emptyState.style.display = 'block';
    hideLoadMoreButton();
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Error signing out:", error);
        showToast('לא ניתן להתנתק כרגע', 'error');
    }
}
