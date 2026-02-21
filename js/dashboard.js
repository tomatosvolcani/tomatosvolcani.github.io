// js/dashboard.js
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc,
    getDoc,
    collection,
    getDocs,
    addDoc,
    serverTimestamp,
    query,
    orderBy,
    limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from "./toast.js";

let currentUser = null;
let userData = null;

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
            // Change icon
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

    // Add experiment button
    const addBtn = document.getElementById('add-experiment-btn');
    if (addBtn) {
        addBtn.addEventListener('click', openNewExperimentModal);
    }

    // Modal buttons
    const confirmBtn = document.getElementById('confirm-new-experiment');
    const cancelBtn = document.getElementById('cancel-new-experiment');
    const modal = document.getElementById('new-experiment-modal');
    const nameInput = document.getElementById('new-experiment-name');

    if (confirmBtn) {
        confirmBtn.addEventListener('click', createNewExperiment);
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeNewExperimentModal);
    }

    // Close modal on overlay click
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeNewExperimentModal();
            }
        });
    }

    // Enter key to create
    if (nameInput) {
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                createNewExperiment();
            }
        });
    }

    // Escape to close modal
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('new-experiment-modal');
        if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
            closeNewExperimentModal();
        }
    });

    // Logout button
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
}

// Auth state listener
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "index.html";
        return;
    }

    currentUser = user;

    // בדיקת אישור משתמש לפני טעינת הדשבורד
    const isApproved = await checkUserApproval();
    if (!isApproved) {
        return; // checkUserApproval מטפל בהודעה ובניתוב
    }

    await loadUserData();
    await loadExperiments();
});

// בדיקה אם המשתמש מאושר
async function checkUserApproval() {
    try {
        const userDocSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (userDocSnap.exists()) {
            const userData = userDocSnap.data();
            if (userData.isApproved === true) {
                return true;
            } else {
                // משתמש לא מאושר - התנתק והחזר לדף התחברות
                await signOut(auth);
                window.location.href = "index.html";
                return false;
            }
        } else {
            // אין מסמך משתמש
            await signOut(auth);
            window.location.href = "index.html";
            return false;
        }
    } catch (error) {
        console.error("Error checking user approval:", error);
        return false;
    }
}

// Load user data from Firestore
async function loadUserData() {
    const userDisplayName = document.getElementById('user-display-name');

    try {
        const docSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (docSnap.exists()) {
            userData = docSnap.data();

            const fullName = `${userData.firstName || ''} ${userData.lastName || ''}`.trim();
            if (userDisplayName) {
                userDisplayName.textContent = fullName || currentUser.email || 'משתמש';
            }

            // Add export menu item for all users
            addExportMenuItem();

            // בדיקת הרשאות ניהול - מנסים לגשת לנתונים מוגבלים
            // אם Firestore Rules מאפשרים - יש הרשאות ניהול
            await checkAndDisplayAdminMenu();
        } else {
            if (userDisplayName) {
                userDisplayName.textContent = currentUser.email || 'משתמש';
            }
        }
    } catch (error) {
        console.error("Error fetching user data:", error);
        if (userDisplayName) {
            userDisplayName.textContent = 'משתמש';
        }
    }
}

// בדיקת הרשאות ניהול והצגת תפריט
// הגישה: מנסים לקרוא משתמשים אחרים - אם מצליחים יש הרשאות
async function checkAndDisplayAdminMenu() {
    try {
        // מנסים לקרוא 2 משתמשים - רק מנהל יכול לפי ה-Rules
        const usersQuery = query(collection(db, "users"), limit(2));
        const snapshot = await getDocs(usersQuery);

        // אם קראנו יותר ממשתמש אחד - יש הרשאות ניהול
        if (snapshot.size > 1) {
            displayAdminMenu();
        }
    } catch (error) {
        // אין הרשאות - זה בסדר, לא מציגים תפריט ניהול
    }
}

// הצגת אפשרות שליפת ניסוי בסיידבר (לכל משתמש)
function addExportMenuItem() {
    const sidebar = document.querySelector('.sidebar-nav');
    if (!sidebar) return;
    // Avoid duplicates
    if (sidebar.querySelector('a[href="export.html"]')) return;

    const homeLink = sidebar.querySelector('a[href="dashboard.html"]');
    if (homeLink) {
        homeLink.insertAdjacentHTML('afterend', `
            <a href="export.html" class="nav-item">
                <i class="fas fa-file-export"></i>
                <span>שליפת ניסוי</span>
            </a>
        `);
    }
}

// הצגת תפריט ניהול לאדמין בסיידבר
function displayAdminMenu() {
    const sidebar = document.querySelector('.sidebar-nav');
    if (!sidebar) return;

    const adminMenuHTML = `
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
    `;

    sidebar.insertAdjacentHTML('beforeend', adminMenuHTML);
}

// Load experiments from Firestore
async function loadExperiments() {
    if (!currentUser) return;

    const experimentsGrid = document.getElementById('experiments-grid');
    const loadingContainer = document.getElementById('loading-container');

    if (!experimentsGrid) return;

    // הצג את הספינר והסתר את הגריד
    if (loadingContainer) loadingContainer.classList.remove('hidden');
    experimentsGrid.style.display = 'none';

    try {
        // Keep the add button, remove other cards
        const addBtn = document.getElementById('add-experiment-btn');
        experimentsGrid.innerHTML = '';
        if (addBtn) {
            experimentsGrid.appendChild(addBtn);
        } else {
            // Recreate the add button if it was removed
            const newAddBtn = createAddButton();
            experimentsGrid.appendChild(newAddBtn);
        }

        // 1. טעינת הניסויים שלי (שאני הקמתי)
        const myExperimentsRef = collection(db, "users", currentUser.uid, "experiments");
        const myQuery = query(myExperimentsRef, orderBy("createdAt", "desc"));
        const myExperimentsSnapshot = await getDocs(myQuery);

        // Add my experiment cards to grid
        myExperimentsSnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const card = createExperimentCard(docSnap.id, data, currentUser.uid, false); // isShared = false
            experimentsGrid.appendChild(card);
        });

        // 2. טעינת ניסויים שאני שותף בהם
        const sharedExperimentsRef = collection(db, "users", currentUser.uid, "sharedExperiments");
        const sharedSnapshot = await getDocs(sharedExperimentsRef);

        // לכל ניסוי משותף - טען את הפרטים מהבעלים המקורי
        for (const sharedDoc of sharedSnapshot.docs) {
            const sharedData = sharedDoc.data();
            const ownerUid = sharedData.ownerUid;
            const experimentId = sharedData.experimentId;

            if (ownerUid && experimentId) {
                try {
                    const originalExperimentRef = doc(db, "users", ownerUid, "experiments", experimentId);
                    const originalExperimentSnap = await getDoc(originalExperimentRef);

                    if (originalExperimentSnap.exists()) {
                        const experimentData = originalExperimentSnap.data();
                        const card = createExperimentCard(experimentId, experimentData, ownerUid, true); // isShared = true
                        experimentsGrid.appendChild(card);
                    }
                } catch (error) {
                    console.error("Error loading shared experiment:", error);
                }
            }
        }

    } catch (error) {
        console.error("Error loading experiments:", error);
    } finally {
        // הסתר את הספינר והצג את הגריד
        if (loadingContainer) loadingContainer.classList.add('hidden');
        experimentsGrid.style.display = 'grid';
    }
}

// Create add button element
function createAddButton() {
    const btn = document.createElement('div');
    btn.className = 'experiment-card add-experiment-btn';
    btn.id = 'add-experiment-btn';
    btn.innerHTML = `
        <div class="plus-icon">+</div>
        <span>הוסף ניסוי חדש</span>
    `;
    btn.addEventListener('click', openNewExperimentModal);
    return btn;
}

// Create experiment card element
function createExperimentCard(id, data, ownerUid, isShared = false) {
    const card = document.createElement('div');
    card.className = 'experiment-card';
    if (isShared) {
        card.classList.add('shared-experiment');
    }

    // סמל לציון האם זה ניסוי שלי או שאני שותף בו
    const ownershipIcon = isShared
        ? '<span class="ownership-badge shared" title="ניסוי שאני שותף בו"><i class="fas fa-users"></i></span>'
        : '<span class="ownership-badge owner" title="ניסוי שהקמתי"><i class="fas fa-user-check"></i></span>';

    card.innerHTML = `
        ${ownershipIcon}
        <h3>
            <i class="fas fa-flask"></i>
            ${data.experimentName || 'ניסוי ללא שם'}
        </h3>
        <p class="date">${formatDate(data.createdAt)}</p>
        ${data.experimentSite ? `<p class="site">${data.experimentSite}</p>` : ''}
        ${isShared && data.leadResearcher ? `<p class="owner-name">חוקר מוביל: ${data.leadResearcher}</p>` : ''}
    `;
    card.addEventListener('click', () => {
        // מעביר גם את ownerUid לניסויים משותפים
        if (isShared) {
            window.location.href = `experiment.html?id=${id}&owner=${ownerUid}`;
        } else {
            window.location.href = `experiment.html?id=${id}`;
        }
    });
    return card;
}


// Open new experiment modal
function openNewExperimentModal() {
    const modal = document.getElementById('new-experiment-modal');
    const input = document.getElementById('new-experiment-name');
    if (modal) {
        modal.classList.remove('hidden');
    }
    if (input) {
        input.value = '';
        input.focus();
    }
}

// Close new experiment modal
function closeNewExperimentModal() {
    const modal = document.getElementById('new-experiment-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// Create new experiment
async function createNewExperiment() {
    const nameInput = document.getElementById('new-experiment-name');
    const experimentName = nameInput ? nameInput.value.trim() : '';

    if (!experimentName) {
        if (nameInput) nameInput.focus();
        return;
    }

    if (!currentUser) return;

    try {
        const experimentsRef = collection(db, "users", currentUser.uid, "experiments");

        const leadResearcherName = userData
            ? `${userData.firstName || ''} ${userData.lastName || ''}`.trim()
            : '';

        const newExperiment = {
            experimentName: experimentName,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            leadResearcher: leadResearcherName,
            partners: [],
            experimentYear: new Date().getFullYear(),
            experimentMonth: '',
            startDate: '',
            workPackage: '',
            experimentSite: '',
            siteCoordinates: '',
            experimentGoal: '',
            experimentSummary: '',
            treatmentsCount: 3,
            repetitionsCount: 0,
            treatments: [],
            independentVariables: [],
            dependentVariables: [],
            keywords: [],
            cropDetails: { shared: true, data: {} },
            structureDetails: { shared: true, data: {} },
            soilDetails: { shared: true, data: {} },
            dripDetails: { shared: true, data: {} }
        };

        const docRef = await addDoc(experimentsRef, newExperiment);

        closeNewExperimentModal();

        // Navigate to the new experiment
        window.location.href = `experiment.html?id=${docRef.id}`;

    } catch (error) {
        console.error("Error creating experiment:", error);
        showToast('שגיאה ביצירת ניסוי חדש: ' + error.message, 'error');
    }
}

// Format date helper
function formatDate(timestamp) {
    if (!timestamp) return '';
    try {
        const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        return date.toLocaleDateString('he-IL');
    } catch {
        return '';
    }
}

// Handle logout
async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = "index.html";
    } catch (error) {
        console.error("Error signing out:", error);
    }
}

