// js/work-package-leads.js
// ראשי חבילות עבודה — קריאה ונרמול של appSettings/workPackageLeads.
//
// מודל הנתונים:
//   appSettings/workPackageLeads = {
//     leads: { wp1: { "<uid>": { name, email, assignedAt, assignedBy } }, ... },
//     updatedAt, updatedBy
//   }
//
// שיוך ראש חבילה אינו מרחיב הרשאות קריאה: ניסוי חסוי נשאר חסוי גם בפני ראש
// החבילה. ראו "Scope decision" ב-Project Architecture.txt.

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { WORK_PACKAGE_LABELS } from "./labels.js?v=20260726-4";

// מקור האמת לקודים ולתוויות הוא labels.js — אין להצהיר עליהם כאן מחדש.
export const WORK_PACKAGE_CODES = Object.keys(WORK_PACKAGE_LABELS);

// "לא שייך למיזם ח"ץ" אינו חבילת עבודה אמיתית ולכן אין לו ראש חבילה,
// אבל הוא כן נבחר לצפייה בדף חבילות העבודה.
export const ASSIGNABLE_WORK_PACKAGE_CODES =
    WORK_PACKAGE_CODES.filter((code) => code !== 'not-related');

export const WORK_PACKAGE_LEADS_DOC = ['appSettings', 'workPackageLeads'];

function clean(value) {
    return String(value === null || value === undefined ? '' : value).trim();
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLeadEntry(uid, raw) {
    const safe = isPlainObject(raw) ? raw : {};
    return {
        uid,
        name: clean(safe.name),
        email: clean(safe.email),
        assignedAt: safe.assignedAt || null,
        assignedBy: clean(safe.assignedBy)
    };
}

/**
 * ממיר את מסמך הראשים למבנה אחיד: { [wpCode]: [{uid, name, email, assignedAt, assignedBy}] }.
 * סובלני למסמך חסר, ל-leads חסר, לערכים שאינם map ולקודים לא מוכרים.
 */
export function normalizeWorkPackageLeads(raw) {
    const source = isPlainObject(raw?.leads) ? raw.leads : (isPlainObject(raw) ? raw : {});
    const result = {};

    Object.entries(source).forEach(([code, packageLeads]) => {
        const wpCode = clean(code);
        if (!wpCode || !isPlainObject(packageLeads)) return;

        const entries = Object.entries(packageLeads)
            .map(([uid, entry]) => normalizeLeadEntry(clean(uid), entry))
            .filter((entry) => Boolean(entry.uid));

        if (entries.length) result[wpCode] = entries;
    });

    return result;
}

/**
 * טוען את מסמך ראשי חבילות העבודה. לעולם לא זורק — דף לא אמור להישבר בגלל
 * חוסר הרשאה או מסמך שטרם נוצר.
 */
export async function loadWorkPackageLeads(db) {
    try {
        const snap = await getDoc(doc(db, ...WORK_PACKAGE_LEADS_DOC));
        if (!snap.exists()) return {};
        return normalizeWorkPackageLeads(snap.data());
    } catch (error) {
        console.warn('Could not load work package leads', error);
        return {};
    }
}

let cachedLeadsPromise = null;

/**
 * גרסה ממוזכרת לשימוש בדפים שרק מציגים מידע (סרגל הניווט, תווית בדף הניסוי).
 * מונעת קריאה כפולה של אותו מסמך באותו טעינת דף — המודול משותף בין הצרכנים.
 * מי שכותב למסמך (admin-users.js) חייב להשתמש ב-loadWorkPackageLeads הרגיל
 * או לקרוא ל-invalidateWorkPackageLeadsCache().
 */
export function loadWorkPackageLeadsCached(db) {
    if (!cachedLeadsPromise) cachedLeadsPromise = loadWorkPackageLeads(db);
    return cachedLeadsPromise;
}

export function invalidateWorkPackageLeadsCache() {
    cachedLeadsPromise = null;
}

export function getWorkPackageLeads(leads, wpCode) {
    const code = clean(wpCode);
    if (!code) return [];
    const entries = leads?.[code];
    return Array.isArray(entries) ? entries : [];
}

/** כל חבילות העבודה שהמשתמש הוא ראש שלהן, לפי סדר WORK_PACKAGE_CODES. */
export function getLeadPackagesForUser(leads, uid) {
    const userUid = clean(uid);
    if (!userUid) return [];

    const known = WORK_PACKAGE_CODES.filter((code) =>
        getWorkPackageLeads(leads, code).some((lead) => lead.uid === userUid));

    // קודים היסטוריים/מותאמים שאינם ברשימה הקבועה עדיין נספרים.
    const extra = Object.keys(leads || {})
        .filter((code) => !WORK_PACKAGE_CODES.includes(code))
        .filter((code) => getWorkPackageLeads(leads, code).some((lead) => lead.uid === userUid));

    return [...known, ...extra];
}

export function isWorkPackageLead(leads, uid, wpCode) {
    const userUid = clean(uid);
    if (!userUid) return false;
    return getWorkPackageLeads(leads, wpCode).some((lead) => lead.uid === userUid);
}

/** טקסט תצוגה לראש/י החבילה, לדוגמה: "שם (email)". מחזיר '' כשאין ראש. */
export function getWorkPackageLeadText(leads, wpCode, options = {}) {
    const { includeEmail = true, separator = ', ', fallback = '' } = options;

    const labels = getWorkPackageLeads(leads, wpCode).map((lead) => {
        const name = lead.name || lead.email || lead.uid;
        if (!includeEmail || !lead.email || lead.email === name) return name;
        return `${name} (${lead.email})`;
    });

    return labels.length ? labels.join(separator) : fallback;
}
