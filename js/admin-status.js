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
        return;
    }

    if (await checkAdminAccess(user)) {
        showAdminStatusBadge();
    } else {
        hideAdminStatusBadge();
    }
});