// Shared administrator badge for every protected page with a sidebar.
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    getDocsFromServer,
    limit,
    query
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    loadWorkPackageLeadsCached,
    getLeadPackagesForUser
} from "./work-package-leads.js?v=20260825-1";

const ADMIN_STATUS_BADGE_ID = 'shared-admin-system-status';
const ADMIN_STATUS_STYLE_ID = 'shared-admin-system-status-style';
const SHARED_ADMIN_NAV_CLASS = 'shared-admin-navigation';
const WORK_PACKAGES_NAV_CLASS = 'work-packages-navigation';
const PRIMARY_NAV_ITEMS = [
    { href: 'dashboard.html', icon: 'fa-home', label: 'בית' },
    { href: 'smart-search.html', icon: 'fa-magnifying-glass-chart', label: 'שליפה חכמה' },
    { href: 'export.html', icon: 'fa-file-export', label: 'שליפת ניסוי' },
    { href: 'my-bi.html', icon: 'fa-chart-pie', label: 'הסטטיסטיקה שלי' },
    { href: 'report-issue.html', icon: 'fa-comment-dots', label: 'תקלות והצעות' },
    { href: 'tutorials.html', icon: 'fa-graduation-cap', label: 'מרכז הדרכה' }
];

// מוצג לראשי חבילות עבודה ולמנהלי מערכת — ראו ensureWorkPackagesNavigation.
const WORK_PACKAGES_NAV_ITEM = {
    href: 'work-packages.html',
    icon: 'fa-boxes-stacked',
    label: 'חבילות עבודה'
};

const ADMIN_NAV_ITEMS = [
    { href: 'admin-users.html', icon: 'fa-users-cog', label: 'ניהול משתמשים' },
    { href: 'admin-experiments.html', icon: 'fa-flask', label: 'כל הניסויים' },
    { href: 'researcher-activity.html', icon: 'fa-ranking-star', label: 'פעילות חוקרים' },
    { href: 'bi.html', icon: 'fa-chart-bar', label: 'לוח BI מערכת' }
];

let cachedUserUid = '';
let adminAccessPromise = null;

function ensureAdminStatusStyles() {
    if (document.getElementById(ADMIN_STATUS_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = ADMIN_STATUS_STYLE_ID;
    style.textContent = `
        .admin-user-identity {
            min-width: 0;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
        }

        .user-info .shared-admin-system-status {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            width: fit-content;
            margin-top: 5px;
            padding: 4px 8px;
            border: 1px solid #bfdbfe;
            border-radius: 6px;
            background: linear-gradient(135deg, #eff6ff 0%, #f8fbff 100%);
            color: #1e40af;
            font-size: 11px;
            font-weight: 600;
            line-height: 1.25;
            box-shadow: 0 2px 7px rgba(37, 99, 235, 0.07);
        }

        .user-info .shared-admin-system-status[hidden] {
            display: none;
        }

        .user-info .shared-admin-system-status-icon {
            width: 17px;
            height: 17px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            border-radius: 50%;
            background: #dbeafe;
            color: #2563eb;
        }

        .user-info .shared-admin-system-status-icon i {
            color: inherit;
            font-size: 9px;
        }

        .user-info .shared-admin-system-status span {
            color: inherit;
            font-size: inherit;
            font-weight: inherit;
            text-align: right;
        }
    `;
    document.head.appendChild(style);
}

function ensureAdminStatusBadge() {
    const existing = document.getElementById(ADMIN_STATUS_BADGE_ID);
    if (existing) return existing;

    const userName = document.getElementById('user-display-name');
    const userInfo = userName?.closest('.user-info');
    if (!userName || !userInfo) return null;

    ensureAdminStatusStyles();

    let identity = userName.closest('.admin-user-identity');
    if (!identity) {
        identity = document.createElement('div');
        identity.className = 'admin-user-identity';
        userInfo.insertBefore(identity, userName);
        identity.appendChild(userName);
    }

    const badge = document.createElement('div');
    badge.id = ADMIN_STATUS_BADGE_ID;
    badge.className = 'shared-admin-system-status';
    badge.setAttribute('role', 'status');
    badge.hidden = true;
    badge.innerHTML = `
        <span class="shared-admin-system-status-icon" aria-hidden="true">
            <i class="fas fa-shield-halved"></i>
        </span>
        <span>את/ה מנהל/ת מערכת</span>
    `;
    identity.appendChild(badge);
    return badge;
}

export function showAdminStatusBadge() {
    const badge = ensureAdminStatusBadge();
    if (badge) badge.hidden = false;
}

export function hideAdminStatusBadge() {
    const badge = document.getElementById(ADMIN_STATUS_BADGE_ID);
    if (badge) badge.hidden = true;
}

function getCurrentPageName() {
    const pageName = window.location.pathname.split('/').pop();
    return pageName || 'dashboard.html';
}

function createNavigationLink(item) {
    const link = document.createElement('a');
    link.href = item.href;
    link.className = 'nav-item';
    if (getCurrentPageName() === item.href) {
        link.classList.add('active');
        link.setAttribute('aria-current', 'page');
    }

    const icon = document.createElement('i');
    icon.className = `fas ${item.icon}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = item.label;
    link.append(icon, label);
    return link;
}

export function ensurePrimaryNavigation() {
    const navigation = document.querySelector('.sidebar-nav');
    if (!navigation) return;

    const adminTitle = Array.from(navigation.querySelectorAll('.nav-section-title'))
        .find((element) => element.textContent.trim() === 'ניהול מערכת');
    const precedingSeparator = adminTitle?.previousElementSibling?.classList.contains('nav-separator')
        ? adminTitle.previousElementSibling
        : null;
    const adminBoundary = navigation.querySelector('.admin-menu-section')
        || precedingSeparator
        || adminTitle
        || null;

    PRIMARY_NAV_ITEMS.forEach((item, index) => {
        if (navigation.querySelector(`a[href="${item.href}"]`)) return;
        const link = createNavigationLink(item);
        const nextExistingLink = PRIMARY_NAV_ITEMS
            .slice(index + 1)
            .map((nextItem) => navigation.querySelector(`a[href="${nextItem.href}"]`))
            .find((candidate) => {
                if (!candidate || !adminBoundary) return Boolean(candidate);
                return Boolean(candidate.compareDocumentPosition(adminBoundary) & Node.DOCUMENT_POSITION_FOLLOWING);
            });
        navigation.insertBefore(link, nextExistingLink || adminBoundary);
    });
}

export function ensureAdminNavigation() {
    const navigation = document.querySelector('.sidebar-nav');
    if (!navigation) return;

    const firstExistingLink = ADMIN_NAV_ITEMS
        .map((item) => navigation.querySelector(`a[href="${item.href}"]`))
        .find(Boolean);

    let container = firstExistingLink?.closest('.admin-menu-section') || navigation;
    if (!firstExistingLink) {
        container = document.createElement('div');
        container.className = `admin-menu-section ${SHARED_ADMIN_NAV_CLASS}`;

        const separator = document.createElement('div');
        separator.className = 'nav-separator';
        const title = document.createElement('div');
        title.className = 'nav-section-title';
        title.textContent = 'ניהול מערכת';
        container.append(separator, title);
        navigation.appendChild(container);
    }

    ADMIN_NAV_ITEMS.forEach((item, index) => {
        if (navigation.querySelector(`a[href="${item.href}"]`)) return;
        const link = createNavigationLink(item);
        const nextExistingLink = ADMIN_NAV_ITEMS
            .slice(index + 1)
            .map((nextItem) => container.querySelector(`a[href="${nextItem.href}"]`))
            .find(Boolean);
        if (nextExistingLink) {
            container.insertBefore(link, nextExistingLink);
        } else {
            container.appendChild(link);
        }
    });
}

function removeSharedAdminNavigation() {
    document.querySelector(`.${SHARED_ADMIN_NAV_CLASS}`)?.remove();
}

/**
 * פריט "חבילות עבודה" מוצג לראשי חבילות עבודה ולמנהלי מערכת.
 *
 * מנהל מערכת מקבל אותו גם ללא שיוך כראש חבילה: יש לו ממילא גישת צפייה לכל
 * הניסויים, והדף עצמו מסביר את ההיקף — renderScopeNotice() ב-work-packages.js
 * מציג לו הערה מפורשת שהבורר המלא הוא הרשאת מנהל, ולא מה שראש חבילה רואה.
 * ההערה הזו היא מה שהופך את ההצגה למנהל לברורה; אם היא תוסר, יש לשקול מחדש
 * גם את התנאי כאן (בלעדיה הדף נקרא כאילו ראש חבילה רואה את כל החבילות).
 *
 * הפריט מוזרק אחרי "שליפה חכמה" כדי לשמור על סדר התפריט הקיים.
 */
export async function ensureWorkPackagesNavigation(user = auth.currentUser) {
    const navigation = document.querySelector('.sidebar-nav');
    if (!navigation || !user) return false;

    const [isLead, isAdmin] = await Promise.all([
        isWorkPackageLeadUser(user),
        checkAdminAccess(user)
    ]);
    const shouldShow = isLead || isAdmin;

    const existing = navigation.querySelector(`a[href="${WORK_PACKAGES_NAV_ITEM.href}"]`);

    if (!shouldShow) {
        // מסירים רק פריט שהוזרק ע"י מודול זה, לא קישור שנכתב ידנית בדף עצמו.
        if (existing?.classList.contains(WORK_PACKAGES_NAV_CLASS)) existing.remove();
        return false;
    }

    if (existing) return true;

    const link = createNavigationLink(WORK_PACKAGES_NAV_ITEM);
    link.classList.add(WORK_PACKAGES_NAV_CLASS);

    const anchor = navigation.querySelector('a[href="smart-search.html"]');
    if (anchor) {
        anchor.insertAdjacentElement('afterend', link);
    } else {
        const fallback = navigation.querySelector('a[href="export.html"]')
            || navigation.querySelector('.admin-menu-section');
        navigation.insertBefore(link, fallback || null);
    }

    return true;
}

/** האם המשתמש הנוכחי הוא ראש של לפחות חבילת עבודה אחת. */
export async function isWorkPackageLeadUser(user = auth.currentUser) {
    if (!user) return false;
    const leads = await loadWorkPackageLeadsCached(db);
    return getLeadPackagesForUser(leads, user.uid).length > 0;
}

/** חבילות העבודה שהמשתמש הנוכחי הוא ראש שלהן. */
export async function getMyWorkPackages(user = auth.currentUser) {
    if (!user) return [];
    const leads = await loadWorkPackageLeadsCached(db);
    return getLeadPackagesForUser(leads, user.uid);
}

export function checkAdminAccess(user = auth.currentUser) {
    if (!user) return Promise.resolve(false);

    if (cachedUserUid !== user.uid) {
        cachedUserUid = user.uid;
        adminAccessPromise = null;
    }

    if (!adminAccessPromise) {
        // Keep the project's established Limit-2 admin detection unchanged.
        const usersQuery = query(collection(db, "users"), limit(2));
        adminAccessPromise = getDocsFromServer(usersQuery)
            .then(snapshot => snapshot.size > 1)
            .catch(() => false);
    }

    return adminAccessPromise;
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        cachedUserUid = '';
        adminAccessPromise = null;
        hideAdminStatusBadge();
        removeSharedAdminNavigation();
        return;
    }

    ensurePrimaryNavigation();

    const isAdmin = await checkAdminAccess(user);

    if (isAdmin) {
        showAdminStatusBadge();
        ensureAdminNavigation();
    } else {
        hideAdminStatusBadge();
        removeSharedAdminNavigation();
    }

    // מנהל מערכת מקבל את הפריט גם כשאינו רשום כראש חבילה במסמך הראשים.
    // checkAdminAccess ממוזכר, ולכן הקריאה כאן אינה שאילתה נוספת.
    await ensureWorkPackagesNavigation(user);
});
