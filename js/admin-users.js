// js/admin-users.js
import { auth, db } from "./firebase-config.js";
import { formatDateIL } from "./date-utils.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    getDocs,
    doc,
    getDoc,
    updateDoc,
    setDoc,
    deleteField,
    serverTimestamp,
    Timestamp,
    query,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast, showConfirmModal } from "./toast.js";
import { packageLabel } from "./labels.js?v=20260726-4";
import {
    ASSIGNABLE_WORK_PACKAGE_CODES,
    WORK_PACKAGE_LEADS_DOC,
    loadWorkPackageLeads,
    invalidateWorkPackageLeadsCache,
    getWorkPackageLeads
} from "./work-package-leads.js?v=20260825-1";

let currentUser = null;
let allUsers = [];
let currentFilter = 'all';
let workPackageLeads = {};
let pendingLeadPackage = '';

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
});

// Initialize event listeners
function initEventListeners() {
    // Hamburger menu (Mobile)
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
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
            const icon = hamburgerBtn?.querySelector('i');
            if (icon) {
                icon.classList.add('fa-bars');
                icon.classList.remove('fa-times');
            }
        });
    }

    // Filter buttons
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            displayUsers();
        });
    });

    // Logout button
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }

    initWorkPackageLeadModal();
    initAdminTabs();
}

// =========================================
// כרטיסיות עליונות: "משתמשי המערכת" / "שיוך ראשי חבילות"
// =========================================
function initAdminTabs() {
    const tabs = Array.from(document.querySelectorAll('.admin-tab'));
    if (tabs.length === 0) return;

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => activateAdminTab(tab.dataset.tab));
    });

    // deep-link: work-packages.html מפנה לכאן עם #wp-leads כדי לפתוח ישירות את
    // כרטיסיית "שיוך ראשי חבילות". hash לא מוכר פשוט נשאר בכרטיסייה ברירת המחדל.
    const openTabFromHash = () => {
        const requested = window.location.hash.replace('#', '');
        if (tabs.some((tab) => tab.dataset.tab === requested)) {
            activateAdminTab(requested);
        }
    };

    openTabFromHash();
    window.addEventListener('hashchange', openTabFromHash);
}

function activateAdminTab(tabName) {
    if (!tabName) return;

    document.querySelectorAll('.admin-tab').forEach((tab) => {
        const isActive = tab.dataset.tab === tabName;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });

    document.querySelectorAll('.admin-tab-panel').forEach((panel) => {
        panel.hidden = panel.id !== `tab-panel-${tabName}`;
    });
}

// Auth state listener
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }

    currentUser = user;
    await loadUserInfo();

    // מנסים לטעון משתמשים - אם אין הרשאות, loadAllUsers תזרוק שגיאה
    // ואז נחזיר לדשבורד
    await loadAllUsers();
});

// טעינת פרטי המשתמש המחובר
async function loadUserInfo() {
    const userDisplayName = document.getElementById('user-display-name');
    try {
        const docSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (docSnap.exists()) {
            const userData = docSnap.data();
            const fullName = `${userData.firstName || ''} ${userData.lastName || ''}`.trim();
            if (userDisplayName) {
                userDisplayName.textContent = fullName || currentUser.email || 'מנהל';
            }
        }
    } catch (error) {
        console.error("Error fetching user data:", error);
    }
}

// טעינת כל המשתמשים
// אם אין הרשאות - Firestore יזרוק שגיאה ונחזיר לדשבורד
async function loadAllUsers() {
    const loadingContainer = document.getElementById('loading-container');
    const tableContainer = document.getElementById('users-table-container');

    if (loadingContainer) loadingContainer.style.display = 'block';
    if (tableContainer) tableContainer.style.display = 'none';

    try {
        const usersRef = collection(db, "users");
        const q = query(usersRef, orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);

        allUsers = [];
        querySnapshot.forEach((doc) => {
            allUsers.push({
                id: doc.id,
                ...doc.data()
            });
        });

        displayUsers();

        // ראשי חבילות העבודה נבנים מהרשימה שכבר נטענה — ללא קריאה נוספת ל-Firestore.
        await renderWorkPackageLeads();

    } catch (error) {
        // שגיאת הרשאות = אין גישה לדף זה
        console.error("Error loading users:", error);
        showToast('אין לך הרשאות גישה לדף זה', 'error');
        setTimeout(() => {
            window.location.href = "dashboard.html";
        }, 1500);
    } finally {
        if (loadingContainer) loadingContainer.style.display = 'none';
        if (tableContainer) tableContainer.style.display = 'block';
    }
}

// הצגת משתמשים בטבלה לפי הסינון
function displayUsers() {
    const tbody = document.getElementById('users-table-body');
    const emptyState = document.getElementById('empty-state');
    const tableContainer = document.getElementById('users-table-container');

    if (!tbody) return;

    // סינון משתמשים
    let filteredUsers = allUsers;

    if (currentFilter === 'pending') {
        filteredUsers = allUsers.filter(u => u.isApproved === false);
    } else if (currentFilter === 'approved') {
        filteredUsers = allUsers.filter(u => u.isApproved === true && u.role !== 'admin');
    } else if (currentFilter === 'admin') {
        filteredUsers = allUsers.filter(u => u.role === 'admin');
    }

    // אם אין משתמשים - הצג מסך ריק
    if (filteredUsers.length === 0) {
        if (tableContainer) tableContainer.style.display = 'none';
        if (emptyState) emptyState.style.display = 'block';
        return;
    }

    if (tableContainer) tableContainer.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';

    tbody.innerHTML = '';

    filteredUsers.forEach(user => {
        const row = document.createElement('tr');

        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'לא צוין';
        const email = user.email || 'לא צוין';
        const role = getRoleText(user.role);
        const statusBadge = getStatusBadge(user);
        const createdDate = formatDateIL(user.createdAt, 'לא ידוע');

        row.innerHTML = `
            <td data-label="שם">${fullName}</td>
            <td data-label="אימייל">${email}</td>
            <td data-label="תפקיד">${role}</td>
            <td data-label="סטטוס">${statusBadge}</td>
            <td data-label="תאריך הרשמה">${createdDate}</td>
            <td data-label="פעולות">
                ${getActionButtons(user)}
            </td>
        `;

        tbody.appendChild(row);
    });

    // הוספת Event Listeners לכפתורי הפעולה
    attachActionButtons();
}

// קבלת טקסט תפקיד בעברית
function getRoleText(role) {
    const roles = {
        'admin': 'מנהל',
        'researcher': 'חוקר',
        'technician': 'טכנאי',
        'student': 'סטודנט',
        'other': 'אחר'
    };
    return roles[role] || role;
}

// קבלת תג סטטוס
function getStatusBadge(user) {
    if (user.role === 'admin') {
        return '<span class="status-badge admin"><i class="fas fa-user-shield"></i> מנהל</span>';
    }
    if (user.isApproved === true) {
        return '<span class="status-badge approved"><i class="fas fa-check"></i> מאושר</span>';
    }
    return '<span class="status-badge pending"><i class="fas fa-clock"></i> ממתין לאישור</span>';
}

// קבלת כפתורי פעולה
function getActionButtons(user) {
    // אם המשתמש הוא המנהל המחובר - אי אפשר לערוך את עצמו
    const isSelf = user.id === currentUser.uid;

    if (user.isApproved === false) {
        return `
            <button class="action-btn approve" data-user-id="${user.id}" ${isSelf ? 'disabled' : ''}>
                <i class="fas fa-check"></i> אשר
            </button>
            <button class="action-btn reject" data-user-id="${user.id}" ${isSelf ? 'disabled' : ''}>
                <i class="fas fa-times"></i> דחה
            </button>
        `;
    }

    return `
        <button class="action-btn view" data-user-id="${user.id}">
            <i class="fas fa-eye"></i> צפייה
        </button>
    `;
}

// חיבור Event Listeners לכפתורי הפעולה
function attachActionButtons() {
    // כפתורי אישור
    document.querySelectorAll('.action-btn.approve').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.dataset.userId;
            await approveUser(userId);
        });
    });

    // כפתורי דחייה
    document.querySelectorAll('.action-btn.reject').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.dataset.userId;
            if (confirm('האם אתה בטוח שברצונך לדחות את המשתמש?')) {
                await rejectUser(userId);
            }
        });
    });

    // כפתורי צפייה
    document.querySelectorAll('.action-btn.view').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = btn.dataset.userId;
            viewUser(userId);
        });
    });
}

// אישור משתמש
async function approveUser(userId) {
    try {
        await updateDoc(doc(db, "users", userId), {
            isApproved: true
        });

        showToast('המשתמש אושר בהצלחה!', 'success');
        await loadAllUsers(); // טען מחדש את הרשימה
    } catch (error) {
        console.error("Error approving user:", error);
        showToast('שגיאה באישור משתמש', 'error');
    }
}

// דחיית משתמש (שינוי סטטוס חזרה לא מאושר)
async function rejectUser(userId) {
    try {
        await updateDoc(doc(db, "users", userId), {
            isApproved: false
        });

        showToast('המשתמש נדחה', 'info');
        await loadAllUsers();
    } catch (error) {
        console.error("Error rejecting user:", error);
        showToast('שגיאה בדחיית משתמש', 'error');
    }
}

// צפייה בפרטי משתמש
function viewUser(userId) {
    const user = allUsers.find(u => u.id === userId);
    if (!user) return;

    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    const details = `
שם: ${fullName}
אימייל: ${user.email}
טלפון: ${user.phone || 'לא צוין'}
תפקיד: ${getRoleText(user.role)}
סטטוס: ${user.isApproved ? 'מאושר' : 'ממתין לאישור'}
תאריך הרשמה: ${formatDateIL(user.createdAt, 'לא ידוע')}
    `.trim();

    alert(details);
}

// =========================================
// ראשי חבילות עבודה (appSettings/workPackageLeads)
//
// השיוך הוא ייעוד ניהולי בלבד ואינו מרחיב הרשאות קריאה: ניסוי חסוי נשאר חסוי
// גם בפני ראש החבילה. הכתיבה למסמך מותרת לאדמין בלבד לפי הכללים.
// =========================================

function getWorkPackageLeadsRef() {
    return doc(db, ...WORK_PACKAGE_LEADS_DOC);
}

function getUserFullName(user) {
    return `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
}

// רק משתמשים מאושרים יכולים להיות ראשי חבילה. הרשימה מגיעה מ-allUsers שכבר
// נטענה (אוסף users) — היא היחידה שנושאת את isApproved; ל-publicUsers אין אותו.
function getAssignableUsers() {
    return allUsers
        .filter(user => user.isApproved === true)
        .sort((a, b) => (getUserFullName(a) || a.email || '')
            .localeCompare(getUserFullName(b) || b.email || '', 'he'));
}

async function renderWorkPackageLeads() {
    // המסמך נקרא כאן ישירות (ולא דרך המטמון) כי דף זה גם כותב אליו.
    invalidateWorkPackageLeadsCache();
    workPackageLeads = await loadWorkPackageLeads(db);
    displayWorkPackageLeads();
}

function displayWorkPackageLeads() {
    const tbody = document.getElementById('wp-leads-table-body');
    if (!tbody) return;

    tbody.replaceChildren();

    ASSIGNABLE_WORK_PACKAGE_CODES.forEach((code) => {
        const leads = getWorkPackageLeads(workPackageLeads, code);
        const row = document.createElement('tr');
        const leadCell = leads.length
            ? leads.map((lead) => {
                const name = escapeHtml(lead.name || lead.email || lead.uid);
                const email = lead.email && lead.email !== lead.name
                    ? `<span class="wp-lead-cell-email">${escapeHtml(lead.email)}</span>`
                    : '';
                return `<span class="wp-lead-cell-name">${name}</span>${email}`;
            }).join('<br>')
            : '<span class="wp-lead-cell-empty">לא הוגדר</span>';

        const assignedAtCell = leads.length
            ? leads.map((lead) => formatDateIL(lead.assignedAt, 'לא ידוע')).join('<br>')
            : '—';

        const actions = leads.length
            ? `
                <button class="action-btn view wp-lead-assign" data-wp="${escapeHtml(code)}">
                    <i class="fas fa-user-pen"></i> החלפה
                </button>
                <button class="action-btn reject wp-lead-remove" data-wp="${escapeHtml(code)}">
                    <i class="fas fa-user-minus"></i> הסרה
                </button>
            `
            : `
                <button class="action-btn approve wp-lead-assign" data-wp="${escapeHtml(code)}">
                    <i class="fas fa-user-plus"></i> שיוך
                </button>
            `;

        row.innerHTML = `
            <td data-label="חבילת עבודה">${escapeHtml(packageLabel(code) || code)}</td>
            <td data-label="ראש חבילה">${leadCell}</td>
            <td data-label="תאריך שיוך">${assignedAtCell}</td>
            <td data-label="פעולות">${actions}</td>
        `;

        tbody.appendChild(row);
    });

    tbody.querySelectorAll('.wp-lead-assign').forEach((btn) => {
        btn.addEventListener('click', () => openWorkPackageLeadModal(btn.dataset.wp));
    });

    tbody.querySelectorAll('.wp-lead-remove').forEach((btn) => {
        btn.addEventListener('click', () => confirmRemoveWorkPackageLead(btn.dataset.wp));
    });
}

function initWorkPackageLeadModal() {
    const modal = document.getElementById('wp-lead-modal');

    document.getElementById('wp-lead-cancel')?.addEventListener('click', closeWorkPackageLeadModal);
    document.getElementById('wp-lead-confirm')?.addEventListener('click', submitWorkPackageLead);
    document.getElementById('wp-lead-search')?.addEventListener('input', (event) => {
        populateWorkPackageLeadOptions(event.target.value);
    });

    if (modal) {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeWorkPackageLeadModal();
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
            closeWorkPackageLeadModal();
        }
    });
}

function openWorkPackageLeadModal(wpCode) {
    if (!wpCode) return;

    pendingLeadPackage = wpCode;

    const modal = document.getElementById('wp-lead-modal');
    const packageLine = document.getElementById('wp-lead-modal-package');
    const search = document.getElementById('wp-lead-search');

    if (packageLine) packageLine.textContent = packageLabel(wpCode) || wpCode;
    if (search) search.value = '';

    populateWorkPackageLeadOptions('');

    const currentLead = getWorkPackageLeads(workPackageLeads, wpCode)[0];
    const select = document.getElementById('wp-lead-user');
    if (select && currentLead) select.value = currentLead.uid;

    modal?.classList.remove('hidden');
    search?.focus();
}

function closeWorkPackageLeadModal() {
    pendingLeadPackage = '';
    document.getElementById('wp-lead-modal')?.classList.add('hidden');
}

function populateWorkPackageLeadOptions(filterTerm) {
    const select = document.getElementById('wp-lead-user');
    if (!select) return;

    const term = String(filterTerm || '').trim().toLowerCase();
    const previousValue = select.value;

    const candidates = getAssignableUsers().filter((user) => {
        if (!term) return true;
        const haystack = `${getUserFullName(user)} ${user.email || ''}`.toLowerCase();
        return haystack.includes(term);
    });

    select.replaceChildren();

    if (candidates.length === 0) {
        const option = new Option('לא נמצאו משתמשים מאושרים', '');
        option.disabled = true;
        select.appendChild(option);
        return;
    }

    candidates.forEach((user) => {
        const name = getUserFullName(user) || user.email || user.id;
        const label = user.email && user.email !== name ? `${name} (${user.email})` : name;
        select.appendChild(new Option(label, user.id));
    });

    if (candidates.some((user) => user.id === previousValue)) {
        select.value = previousValue;
    }
}

async function submitWorkPackageLead() {
    const wpCode = pendingLeadPackage;
    const select = document.getElementById('wp-lead-user');
    const uid = select?.value || '';

    if (!wpCode) return;
    if (!uid) {
        showToast('יש לבחור משתמש מאושר', 'warning');
        return;
    }

    const user = allUsers.find((candidate) => candidate.id === uid);
    if (!user) {
        showToast('המשתמש שנבחר לא נמצא', 'error');
        return;
    }

    const confirmBtn = document.getElementById('wp-lead-confirm');
    if (confirmBtn) confirmBtn.disabled = true;

    // כתיבה אחת: יוצרת את המסמך אם אינו קיים, ממזגת לעומק אחרת, ומסירה ראש
    // חבילה יוצא. deleteField() מותר ב-setDoc עם merge.
    const packageLeads = {
        [uid]: {
            name: getUserFullName(user),
            email: user.email || '',
            assignedAt: Timestamp.now(),
            assignedBy: currentUser.uid
        }
    };

    getWorkPackageLeads(workPackageLeads, wpCode).forEach((lead) => {
        if (lead.uid !== uid) packageLeads[lead.uid] = deleteField();
    });

    try {
        await setDoc(getWorkPackageLeadsRef(), {
            leads: { [wpCode]: packageLeads },
            updatedAt: serverTimestamp(),
            updatedBy: currentUser.uid
        }, { merge: true });

        closeWorkPackageLeadModal();
        await renderWorkPackageLeads();
        showToast('ראש חבילת העבודה עודכן בהצלחה', 'success');
    } catch (error) {
        console.error("Error assigning work package lead:", error);
        showToast(error?.code === 'permission-denied'
            ? 'אין לך הרשאה לעדכן ראשי חבילות עבודה'
            : 'שגיאה בעדכון ראש חבילת העבודה', 'error');
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

async function confirmRemoveWorkPackageLead(wpCode) {
    const leads = getWorkPackageLeads(workPackageLeads, wpCode);
    if (!wpCode || leads.length === 0) return;

    const names = leads.map((lead) => lead.name || lead.email || lead.uid).join(', ');

    const confirmed = await showConfirmModal({
        title: 'הסרת ראש חבילת עבודה',
        message: `להסיר את ${names} מתפקיד ראש ${packageLabel(wpCode) || wpCode}?`,
        confirmText: 'הסרה',
        cancelText: 'ביטול'
    });

    if (confirmed) await removeWorkPackageLead(wpCode, leads);
}

async function removeWorkPackageLead(wpCode, leads) {
    const packageLeads = {};
    leads.forEach((lead) => { packageLeads[lead.uid] = deleteField(); });

    try {
        await setDoc(getWorkPackageLeadsRef(), {
            leads: { [wpCode]: packageLeads },
            updatedAt: serverTimestamp(),
            updatedBy: currentUser.uid
        }, { merge: true });

        await renderWorkPackageLeads();
        showToast('ראש חבילת העבודה הוסר', 'info');
    } catch (error) {
        console.error("Error removing work package lead:", error);
        showToast(error?.code === 'permission-denied'
            ? 'אין לך הרשאה לעדכן ראשי חבילות עבודה'
            : 'שגיאה בהסרת ראש חבילת העבודה', 'error');
    }
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}



// התנתקות
async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Error signing out:", error);
    }
}