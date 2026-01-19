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
    orderBy
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

// Load experiments from Firestore
async function loadExperiments() {
    if (!currentUser) return;

    const experimentsGrid = document.getElementById('experiments-grid');

    if (!experimentsGrid) return;

    try {
        const experimentsRef = collection(db, "users", currentUser.uid, "experiments");
        const q = query(experimentsRef, orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);

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

        // Add experiment cards to grid
        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();

            // Add card to grid
            const card = createExperimentCard(docSnap.id, data);
            experimentsGrid.appendChild(card);
        });

    } catch (error) {
        console.error("Error loading experiments:", error);
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
function createExperimentCard(id, data) {
    const card = document.createElement('div');
    card.className = 'experiment-card';
    card.innerHTML = `
        <h3>
            <i class="fas fa-flask"></i>
            ${data.experimentName || 'ניסוי ללא שם'}
        </h3>
        <p class="date">${formatDate(data.createdAt)}</p>
        ${data.experimentSite ? `<p class="site">${data.experimentSite}</p>` : ''}
    `;
    card.addEventListener('click', () => {
        window.location.href = `experiment.html?id=${id}`;
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

