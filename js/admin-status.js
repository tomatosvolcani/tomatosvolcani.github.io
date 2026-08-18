// Shared administrator badge for every protected page with a sidebar.
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    getDocs,
    limit,
    query
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const ADMIN_STATUS_BADGE_ID = 'shared-admin-system-status';
const ADMIN_STATUS_STYLE_ID = 'shared-admin-system-status-style';
const SHARED_ADMIN_NAV_CLASS = 'shared-admin-navigation';
const PRIMARY_NAV_ITEMS = [
    { href: 'dashboard.html', icon: 'fa-home', label: 'בית' },
    { href: 'smart-search.html', icon: 'fa-magnifying-glass-chart', label: 'שליפה חכמה' },
    { href: 'export.html', icon: 'fa-file-export', label: 'שליפת ניסוי' },
    { href: 'my-bi.html', icon: 'fa-chart-pie', label: 'הסטטיסטיקה שלי' },
    { href: 'tutorials.html', icon: 'fa-graduation-cap', label: 'מרכז הדרכה' }
];
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

export function checkAdminAccess(user = auth.currentUser) {
    if (!user) return Promise.resolve(false);

    if (cachedUserUid !== user.uid) {
        cachedUserUid = user.uid;
        adminAccessPromise = null;
    }

    if (!adminAccessPromise) {
        // Keep the project's established Limit-2 admin detection unchanged.
        const usersQuery = query(collection(db, "users"), limit(2));
        adminAccessPromise = getDocs(usersQuery)
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

    if (await checkAdminAccess(user)) {
        showAdminStatusBadge();
        ensureAdminNavigation();
    } else {
        hideAdminStatusBadge();
        removeSharedAdminNavigation();
    }
});
