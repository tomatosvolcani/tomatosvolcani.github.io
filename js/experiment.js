// js/experiment.js
import { auth, db, storage } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc,
    getDoc,
    updateDoc,
    setDoc,
    deleteDoc,
    serverTimestamp,
    collection,
    getDocs,
    query,
    limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    ref,
    uploadBytesResumable,
    getDownloadURL,
    deleteObject
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { showToast } from "./toast.js";

// =========================================
// State
// =========================================
let currentUser = null;
let userData = null;
let currentExperimentId = null;
let experimentData = null;
let currentView = 'basic';
let currentTreatmentIndex = 0;
let allUsers = []; // All users for partner selection
let selectedPartner = null; // Currently selected partner from autocomplete
let experimentOwnerUid = null; // מזהה הבעלים של הניסוי (יכול להיות שונה מהמשתמש הנוכחי אם זה ניסוי משותף)
let isSharedExperiment = false; // האם זה ניסוי שאני שותף בו

// =========================================
// Initialization
// =========================================
document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "index.html";
        return;
    }

    currentUser = user;

    // בדיקת אישור משתמש לפני טעינת הניסוי
    const isApproved = await checkUserApproval();
    if (!isApproved) {
        return; // checkUserApproval מטפל בהודעה ובניתוב
    }

    await loadUserData();

    // טען את כל המשתמשים מוקדם - נדרש לסנכרון שותפים!
    await loadAllUsers();

    // Ensure year dropdown is initialized before loading experiment data so
    // populateForm can set the select value into existing options.
    initYearsDropdown();

    // Get experiment ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    currentExperimentId = urlParams.get('id');
    const section = urlParams.get('section');
    const ownerParam = urlParams.get('owner'); // לניסויים משותפים

    // קבע את הבעלים של הניסוי
    if (ownerParam) {
        experimentOwnerUid = ownerParam;
        isSharedExperiment = true;
    } else {
        experimentOwnerUid = currentUser.uid;
        isSharedExperiment = false;
    }

    if (currentExperimentId) {
        await loadExperiment();
        if (section) {
            switchView(section);
        }
    } else {
        window.location.href = "dashboard.html";
    }
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

// Load user data
async function loadUserData() {
    try {
        const docSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (docSnap.exists()) {
            userData = docSnap.data();
            const fullName = `${userData.firstName || ''} ${userData.lastName || ''}`.trim();
            const userDisplay = document.getElementById('user-display-name');
            if (userDisplay) {
                userDisplay.textContent = fullName || currentUser.email || 'משתמש';
            }

            // בדיקת הרשאות ניהול על ידי ניסיון גישה לנתונים מוגבלים
            await checkAndDisplayAdminMenu();
        }
    } catch (error) {
        console.error("Error fetching user data:", error);
    }
}

// בדיקת הרשאות ניהול והצגת תפריט
async function checkAndDisplayAdminMenu() {
    try {
        const usersQuery = query(collection(db, "users"), limit(2));
        const snapshot = await getDocs(usersQuery);
        if (snapshot.size > 1) {
            displayAdminMenuInExperiment();
        }
    } catch (error) {
        // אין הרשאות ניהול - לא מציגים תפריט
    }
}

// הצגת תפריט ניהול לאדמין בסיידבר של דף הניסוי
function displayAdminMenuInExperiment() {
    const sidebar = document.querySelector('.sidebar-nav');
    if (!sidebar) return;

    // בדוק אם התפריט כבר קיים
    if (document.querySelector('.admin-menu-section')) return;

    const adminMenuHTML = `
        <div class="admin-menu-section">
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
        </div>
    `;

    sidebar.insertAdjacentHTML('beforeend', adminMenuHTML);
}

// Load all users for partner selection
// Reads from publicUsers collection which contains ONLY public fields
// This provides database-level security - sensitive data is never exposed
async function loadAllUsers() {
    try {
        // Use publicUsers collection instead of users for better security
        // publicUsers contains ONLY: uid, firstName, lastName, email, role
        // Does NOT contain: phone, createdAt, or any other sensitive data
        const usersRef = collection(db, "publicUsers");
        const querySnapshot = await getDocs(usersRef);

        allUsers = [];
        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            // All fields in publicUsers are safe to use
            allUsers.push({
                uid: docSnap.id,
                firstName: data.firstName || '',
                lastName: data.lastName || '',
                email: data.email || '',
                role: data.role || '',
                fullName: `${data.firstName || ''} ${data.lastName || ''}`.trim()
            });
        });
    } catch (error) {
        console.error("Error loading users:", error);

        // Check if it's a permission error
        if (error.code === 'permission-denied') {
            showToast('שגיאת הרשאות - לא ניתן לטעון רשימת משתמשים.', 'error', 5000);
        } else {
            showToast('שגיאה בטעינת רשימת משתמשים', 'error');
        }

        allUsers = []; // Empty array so the UI doesn't break
    }
}

// Initialize years dropdown
function initYearsDropdown() {
    const yearSelect = document.getElementById('experiment-year');
    if (!yearSelect) return;

    const currentYear = new Date().getFullYear();
    yearSelect.innerHTML = '<option value="">בחר שנה</option>';


    for (let year = currentYear - 5; year <= currentYear + 5; year++) {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        yearSelect.appendChild(option);
    }
}

// =========================================
// Load Experiment
// =========================================
async function loadExperiment() {
    const loadingContainer = document.getElementById('loading-container');
    const experimentContent = document.getElementById('experiment-content');

    // הצג את הספינר והסתר את התוכן
    if (loadingContainer) loadingContainer.classList.remove('hidden');
    if (experimentContent) experimentContent.style.display = 'none';

    try {
        // טען מהבעלים של הניסוי (יכול להיות המשתמש הנוכחי או אחר אם זה ניסוי משותף)
        const experimentRef = doc(db, "users", experimentOwnerUid, "experiments", currentExperimentId);
        const experimentSnap = await getDoc(experimentRef);

        if (experimentSnap.exists()) {
            experimentData = experimentSnap.data();
            populateForm();
            updateUI();
            generateTreatmentTabs();
            // אתחל את ה-autocomplete של השותפים אחרי שהניסוי נטען
            initPartnersAutocomplete();
            // אתחל את יומן האירועים
            initEventsLog();
        } else {
            showToast('הניסוי לא נמצא', 'error');
            window.location.href = "dashboard.html";
        }
    } catch (error) {
        console.error("Error loading experiment:", error);

        // בדיקה אם זו שגיאת הרשאות
        if (error.code === 'permission-denied') {
            showAccessDeniedMessage();
        } else {
            showToast('שגיאה בטעינת הניסוי', 'error');
            setTimeout(() => {
                window.location.href = "dashboard.html";
            }, 2000);
        }
    } finally {
        // הסתר את הספינר והצג את התוכן
        if (loadingContainer) loadingContainer.classList.add('hidden');
        if (experimentContent) experimentContent.style.display = 'block';
    }
}

// הצגת הודעת "אין גישה" עם הסבר
function showAccessDeniedMessage() {
    const experimentContent = document.getElementById('experiment-content');
    if (!experimentContent) return;

    experimentContent.innerHTML = `
        <div class="access-denied-container">
            <div class="access-denied-icon">
                <i class="fas fa-lock"></i>
            </div>
            <h2>אין לך הרשאה לצפות בניסוי זה</h2>
            <p class="access-denied-text">
                הניסוי הזה לא שותף איתך. כדי לקבל גישה, בקש מבעל הניסוי לשתף אותו איתך.
            </p>
            <div class="access-denied-steps">
                <h3>איך לקבל גישה?</h3>
                <ol>
                    <li>פנה לבעל הניסוי ובקש ממנו לשתף אותך</li>
                    <li>בעל הניסוי צריך להיכנס לניסוי שלו</li>
                    <li>בחלק "שותפים" - להוסיף אותך כשותף</li>
                    <li>לאחר מכן תוכל לגשת לניסוי מהדשבורד שלך</li>
                </ol>
            </div>
            <button class="btn-back-home" onclick="window.location.href='dashboard.html'">
                <i class="fas fa-home"></i>
                חזרה לדשבורד
            </button>
        </div>
    `;
}

// Update UI elements
function updateUI() {
    const name = experimentData.experimentName || 'ניסוי';

    const sidebarName = document.getElementById('sidebar-experiment-name');
    if (sidebarName) sidebarName.textContent = name;

    document.title = `${name} - מיזם ח"ץ`;

    // Update breadcrumb for current view
    switchView(currentView);
}

// =========================================
// Populate Form
// =========================================
function populateForm() {
    const data = experimentData;

    // Lead researcher
    const leadResearcher = document.getElementById('lead-researcher');
    if (leadResearcher) {
        if (data.leadResearcher) {
            leadResearcher.value = data.leadResearcher;
        } else if (userData) {
            leadResearcher.value = `${userData.firstName || ''} ${userData.lastName || ''}`.trim();
        }
    }

    // Partners
    if (data.partners && data.partners.length > 0) {
        const container = document.getElementById('partners-container');
        if (container) {
            container.innerHTML = '';
            data.partners.forEach(partner => addPartnerRow(partner));
        }
    }

    // Basic fields
    setFieldValue('experiment-year', data.experimentYear);
    setFieldValue('experiment-month', data.experimentMonth);
    setFieldValue('start-date', data.startDate);
    setFieldValue('work-package', data.workPackage);
    setFieldValue('experiment-site', data.experimentSite);
    setFieldValue('site-coordinates', data.siteCoordinates);
    setFieldValue('experiment-goal', data.experimentGoal);
    setFieldValue('experiment-summary', data.experimentSummary);
    setFieldValue('treatments-count', data.treatmentsCount || 3);
    setFieldValue('repetitions-count', data.repetitionsCount);
    setFieldValue('levels-count', data.levelsCount);
    setFieldValue('level-value', data.levelValue);

    // Treatments
    generateTreatmentInputs(data.treatmentsCount || 3, data.treatments || []);

    // Variables
    if (data.independentVariables) {
        data.independentVariables.forEach(v => addVariableRow('independent', v));
    }
    if (data.dependentVariables) {
        data.dependentVariables.forEach(v => addVariableRow('dependent', v));
    }

    // Keywords
    if (data.keywords) {
        data.keywords.forEach(k => addKeywordTag(k));
    }

    // Crop details
    if (data.cropDetails && data.cropDetails.data) {
        const crop = data.cropDetails.data;
        setFieldValue('planting-date', crop.plantingDate);
        setFieldValue('crop-type', crop.cropType);
        setFieldValue('variety', crop.variety);
        setFieldValue('grafted-plant', crop.graftedPlant);
        setFieldValue('variety-type', crop.varietyType);
        setFieldValue('split-plant', crop.splitPlant);
        setFieldValue('nursery', crop.nursery);
        setFieldValue('seedlings-count', crop.seedlingsCount);
        setFieldValue('planting-density', crop.plantingDensity);
        setFieldValue('planting-structure', crop.plantingStructure);
        setFieldValue('experiment-area', crop.experimentArea);
        setFieldValue('preparation-name', crop.preparationName);
        setFieldValue('crop-notes', crop.notes);

        const toggle = document.getElementById('shared-data-toggle');
        if (toggle && data.cropDetails.shared !== undefined) {
            toggle.checked = data.cropDetails.shared;
        }
    }

    // Structure details
    if (data.structureDetails && data.structureDetails.data) {
        const structure = data.structureDetails.data;
        setFieldValue('structure-type', structure.type);
        setFieldValue('structure-size', structure.size);
        setFieldValue('structure-tunnels', structure.tunnels);
        setFieldValue('structure-length', structure.length);
        setFieldValue('structure-width', structure.width);
        setFieldValue('roof-covering', structure.roofCovering);
        setFieldValue('net-washing', structure.netWashing);
        setFieldValue('structure-direction', structure.direction);
        setFieldValue('structure-notes', structure.notes);
    }

    // Soil details
    if (data.soilDetails && data.soilDetails.data) {
        const soil = data.soilDetails.data;
        setFieldValue('detached-substrate', soil.detachedSubstrate);
        setFieldValue('substrate-company', soil.substrateCompany);
        setFieldValue('substrate-type', soil.substrateType);
        setFieldValue('substrate-volume', soil.substrateVolume);
        setFieldValue('soil-mulch', soil.mulch);
        setFieldValue('soil-disinfection-adigan', soil.disinfectionAdigan);
        setFieldValue('soil-adigan-amount', soil.adiganAmount);
        setFieldValue('soil-solarization', soil.solarization);
        // Dynamic tables
        renderSoilTable('compost-tbody', soil.compostRows || [], ['date','amount','method']);
        renderSoilTable('spray-tbody', soil.sprayRows || [], ['date','amount','method']);
        renderSoilDisinfectTable('disinfect-tbody', soil.disinfectRows || []);
    }

    // Drip details
    if (data.dripDetails && data.dripDetails.data) {
        const drip = data.dripDetails.data;
        setFieldValue('drip-single-double', drip.singleDouble);
        setFieldValue('drip-pipe-diameter', drip.pipeDiameter);
        setFieldValue('drip-emitter-spacing', drip.emitterSpacing);
        setFieldValue('drip-flow-rate', drip.flowRate);
        setFieldValue('drip-lines-count', drip.linesCount);
        setFieldValue('drip-lines-spacing', drip.linesSpacing);
        setFieldValue('drip-bed-spacing', drip.bedSpacing);
    }

    // Progress views (מהלך הניסוי + נתוני יבול)
    populateProgressViews(data);

    // עדכון כפתור Google Maps אחרי שהנתונים נטענו
    updateGoogleMapsButtonVisibility();
}

function setFieldValue(id, value) {
    const el = document.getElementById(id);
    if (el && value !== undefined && value !== null) {
        el.value = value;
    }
}

// עדכון כפתור Google Maps - פונקציה גלובלית שניתן לקרוא לה מכל מקום
function updateGoogleMapsButtonVisibility() {
    const openGoogleMapsBtn = document.getElementById('open-google-maps-btn');
    const coordsInput = document.getElementById('site-coordinates');

    if (openGoogleMapsBtn && coordsInput) {
        if (coordsInput.value && coordsInput.value.trim()) {
            openGoogleMapsBtn.style.display = 'block';
        } else {
            openGoogleMapsBtn.style.display = 'none';
        }
    }
}

// =========================================
// Treatment Tabs
// =========================================
function generateTreatmentTabs() {
    const count = parseInt(document.getElementById('treatments-count')?.value) || 0;
    const treatments = experimentData?.treatments || [];
    const tabsNav = document.getElementById('tabs-nav');

    if (!tabsNav) return;

    tabsNav.innerHTML = '';

    for (let i = 0; i < count; i++) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab-item' + (i === currentTreatmentIndex ? ' active' : '');

        const treatmentName = treatments[i]?.name || `טיפול ${i + 1}`;
        const pesticideName = treatments[i]?.pesticide || '';

        tab.textContent = pesticideName ? `${treatmentName} - ${pesticideName}` : treatmentName;
        tab.dataset.index = i;

        tab.addEventListener('click', () => switchTreatmentTab(i));
        // Insert at the beginning to reverse the order (1,2,3 from right to left)
        tabsNav.insertBefore(tab, tabsNav.firstChild);
    }
}

function switchTreatmentTab(index) {
    currentTreatmentIndex = index;
    // Match tabs by their data-index attribute instead of DOM order
    document.querySelectorAll('.tab-item').forEach((tab) => {
        const tabIndex = parseInt(tab.dataset.index);
        tab.classList.toggle('active', tabIndex === index);
    });
}

// =========================================
// View Switching
// =========================================
function switchView(viewName) {
    currentView = viewName;

    // Hide all views
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.remove('active');
    });

    // Show selected view
    const viewElement = document.getElementById(`view-${viewName}`);
    if (viewElement) {
        viewElement.classList.add('active');
    }

    // Update sidebar active states
    document.querySelectorAll('.sub-sub-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewName);
    });
    document.querySelectorAll('.sub-item[data-view]').forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewName);
    });

    // Show/hide tabs and toggle
    const tabsContainer = document.getElementById('treatments-tabs');
    const toggleContainer = document.getElementById('shared-toggle-container');
    const viewsWithTabs = ['crop', 'structure', 'soil', 'drip', 'irrigation', 'growth', 'climate', 'agrotechnics', 'plant-protection'];

    if (viewsWithTabs.includes(viewName)) {
        if (tabsContainer) tabsContainer.style.display = 'block';
        if (toggleContainer) toggleContainer.style.display = 'flex';
    } else {
        if (tabsContainer) tabsContainer.style.display = 'none';
        if (toggleContainer) toggleContainer.style.display = 'none';
    }

    // Update breadcrumb with full path and clickable links
    const viewNames = {
        'basic': 'תוכנית הניסוי',
        'crop': 'פרטי הגידול',
        'structure': 'דרישות המבנה',
        'soil': 'טיפול בקרקע',
        'drip': 'סוג ופריסת הטפטוף',
        'irrigation': 'השקיה ודשן',
        'growth': 'צימוח',
        'climate': 'נתוני אקלים וסנסורים',
        'agrotechnics': 'אגרוטכניקה',
        'plant-protection': 'הגנת הצומח',
        'yield': 'נתוני יבול',
        'events': 'יומן אירועים'
    };

    // Views that belong to "הכנות לניסוי"
    const prepViews = ['crop', 'structure', 'soil', 'drip'];
    // Views that belong to "מהלך הניסוי"
    const progressViews = ['irrigation', 'growth', 'climate', 'agrotechnics', 'plant-protection'];

    const expName = experimentData?.experimentName || 'ניסוי';
    const breadcrumb = document.getElementById('breadcrumb-text');

    if (breadcrumb) {
        let breadcrumbHTML = `<span class="breadcrumb-link" onclick="window.location.href='dashboard.html'">${expName}</span>`;

        if (prepViews.includes(viewName)) {
            // Add "הכנות לניסוי" for sub-categories
            breadcrumbHTML += ` > <span class="breadcrumb-text">הכנות לניסוי</span>`;
        } else if (progressViews.includes(viewName)) {
            // Add "מהלך הניסוי" for progress sub-categories
            breadcrumbHTML += ` > <span class="breadcrumb-text">מהלך הניסוי</span>`;
        }

        breadcrumbHTML += ` > <span class="breadcrumb-current">${viewNames[viewName] || viewName}</span>`;
        breadcrumb.innerHTML = breadcrumbHTML;
    }
}

// =========================================
// Dynamic Elements
// =========================================
function generateTreatmentInputs(count, existingTreatments = []) {
    const container = document.getElementById('treatments-container');
    if (!container) return;

    container.innerHTML = '';

    for (let i = 0; i < count; i++) {
        const existing = existingTreatments[i] || {};
        const item = document.createElement('div');
        item.className = 'treatment-item';
        item.innerHTML = `
            <label>שם לטיפול ${i + 1}:</label>
            <input type="text" class="treatment-name" data-index="${i}" value="${existing.name || ''}" placeholder="שם הטיפול">
            <input type="text" class="treatment-pesticide" data-index="${i}" value="${existing.pesticide || ''}" placeholder="חומר הדברה">
        `;
        container.appendChild(item);
    }
}

function addPartnerRow(partnerData = null) {
    const container = document.getElementById('partners-container');
    if (!container) return;

    // Support both old string format and new object format
    let partnerName = '';
    let partnerEmail = '';

    if (typeof partnerData === 'string') {
        // Old format: just name
        partnerName = partnerData;
    } else if (partnerData && typeof partnerData === 'object') {
        // New format: {name, email}
        partnerName = partnerData.name || '';
        partnerEmail = partnerData.email || '';
    }

    const row = document.createElement('div');
    row.className = 'partner-row';
    row.dataset.email = partnerEmail; // Store email in data attribute

    // בדיקה אם המשתמש הנוכחי הוא הבעלים של הניסוי
    const isOwner = currentUser && experimentOwnerUid && currentUser.uid === experimentOwnerUid;
    const disabledClass = isOwner ? '' : 'disabled';
    const disabledAttr = isOwner ? '' : 'disabled';
    const disabledTitle = isOwner ? '' : 'title="רק מי שהקים את הניסוי יכול למחוק שותפים"';

    row.innerHTML = `
        <div class="partner-info">
            <div class="partner-name">${partnerName || 'לא צוין שם'}</div>
            <div class="partner-email">${partnerEmail || 'אין אימייל'}</div>
        </div>
        <button type="button" class="btn-icon btn-delete ${disabledClass}" ${disabledAttr} ${disabledTitle}><i class="fas fa-trash"></i></button>
    `;

    const deleteBtn = row.querySelector('.btn-delete');
    if (isOwner) {
        deleteBtn.addEventListener('click', () => row.remove());
    }
    container.appendChild(row);
}

function addVariableRow(type, value = '') {
    const containerId = type === 'independent' ? 'independent-vars-container' : 'dependent-vars-container';
    const container = document.getElementById(containerId);
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'variable-row';
    row.innerHTML = `
        <input type="text" class="${type}-var-input" value="${value}" placeholder="שם המשתנה">
        <button type="button" class="btn-icon btn-delete"><i class="fas fa-trash"></i></button>
    `;

    row.querySelector('.btn-delete').addEventListener('click', () => row.remove());
    container.appendChild(row);
}

function addKeywordTag(value) {
    const container = document.getElementById('keywords-list');
    if (!container) return;

    // Check if exists
    if (container.querySelector(`[data-value="${value}"]`)) return;

    const tag = document.createElement('span');
    tag.className = 'keyword-tag';
    tag.dataset.value = value;
    tag.innerHTML = `
        ${value}
        <span class="remove"><i class="fas fa-times"></i></span>
    `;

    tag.querySelector('.remove').addEventListener('click', () => tag.remove());
    container.appendChild(tag);
}

// =========================================
// Collect Form Data
// =========================================
function collectFormData() {
    // Partners - collect from partner rows
    const partners = [];
    document.querySelectorAll('.partner-row').forEach(row => {
        const nameEl = row.querySelector('.partner-name');
        const emailEl = row.querySelector('.partner-email');
        if (nameEl && nameEl.textContent && nameEl.textContent !== 'לא צוין שם') {
            partners.push({
                name: nameEl.textContent.trim(),
                email: row.dataset.email || emailEl?.textContent.trim() || ''
            });
        }
    });

    // Treatments
    const treatments = [];
    document.querySelectorAll('.treatment-name').forEach(input => {
        const index = input.dataset.index;
        const pesticideInput = document.querySelector(`.treatment-pesticide[data-index="${index}"]`);
        treatments.push({
            name: input.value || '',
            pesticide: pesticideInput ? pesticideInput.value : ''
        });
    });

    // Independent Variables
    const independentVariables = [];
    document.querySelectorAll('.independent-var-input').forEach(input => {
        if (input.value.trim()) independentVariables.push(input.value.trim());
    });

    // Dependent Variables
    const dependentVariables = [];
    document.querySelectorAll('.dependent-var-input').forEach(input => {
        if (input.value.trim()) dependentVariables.push(input.value.trim());
    });

    // Keywords
    const keywords = [];
    document.querySelectorAll('#keywords-list .keyword-tag').forEach(tag => {
        keywords.push(tag.dataset.value);
    });

    const sharedToggle = document.getElementById('shared-data-toggle');
    const isShared = sharedToggle ? sharedToggle.checked : true;

    return {
        leadResearcher: document.getElementById('lead-researcher')?.value || '',
        partners,
        experimentYear: document.getElementById('experiment-year')?.value || '',
        experimentMonth: document.getElementById('experiment-month')?.value || '',
        startDate: document.getElementById('start-date')?.value || '',
        workPackage: document.getElementById('work-package')?.value || '',
        experimentSite: document.getElementById('experiment-site')?.value || '',
        siteCoordinates: document.getElementById('site-coordinates')?.value || '',
        experimentGoal: document.getElementById('experiment-goal')?.value || '',
        experimentSummary: document.getElementById('experiment-summary')?.value || '',
        treatmentsCount: parseInt(document.getElementById('treatments-count')?.value) || 0,
        repetitionsCount: parseInt(document.getElementById('repetitions-count')?.value) || 0,
        treatments,
        independentVariables,
        levelsCount: parseInt(document.getElementById('levels-count')?.value) || 0,
        levelValue: document.getElementById('level-value')?.value || '',
        dependentVariables,
        keywords,
        cropDetails: {
            shared: isShared,
            data: {
                plantingDate: document.getElementById('planting-date')?.value || '',
                cropType: document.getElementById('crop-type')?.value || '',
                variety: document.getElementById('variety')?.value || '',
                graftedPlant: document.getElementById('grafted-plant')?.value || '',
                varietyType: document.getElementById('variety-type')?.value || '',
                splitPlant: document.getElementById('split-plant')?.value || '',
                nursery: document.getElementById('nursery')?.value || '',
                seedlingsCount: document.getElementById('seedlings-count')?.value || '',
                plantingDensity: document.getElementById('planting-density')?.value || '',
                plantingStructure: document.getElementById('planting-structure')?.value || '',
                experimentArea: document.getElementById('experiment-area')?.value || '',
                preparationName: document.getElementById('preparation-name')?.value || '',
                notes: document.getElementById('crop-notes')?.value || ''
            }
        },
        structureDetails: {
            shared: isShared,
            data: {
                type: document.getElementById('structure-type')?.value || '',
                size: document.getElementById('structure-size')?.value || '',
                tunnels: document.getElementById('structure-tunnels')?.value || '',
                length: document.getElementById('structure-length')?.value || '',
                width: document.getElementById('structure-width')?.value || '',
                roofCovering: document.getElementById('roof-covering')?.value || '',
                netWashing: document.getElementById('net-washing')?.value || '',
                direction: document.getElementById('structure-direction')?.value || '',
                notes: document.getElementById('structure-notes')?.value || ''
            }
        },
        soilDetails: {
            shared: isShared,
            data: {
                detachedSubstrate: document.getElementById('detached-substrate')?.value || '',
                substrateCompany: document.getElementById('substrate-company')?.value || '',
                substrateType: document.getElementById('substrate-type')?.value || '',
                substrateVolume: document.getElementById('substrate-volume')?.value || '',
                mulch: document.getElementById('soil-mulch')?.value || '',
                disinfectionAdigan: document.getElementById('soil-disinfection-adigan')?.value || '',
                adiganAmount: document.getElementById('soil-adigan-amount')?.value || '',
                solarization: document.getElementById('soil-solarization')?.value || '',
                compostRows: collectSoilTableRows('compost-tbody', ['date','amount','method']),
                sprayRows: collectSoilTableRows('spray-tbody', ['date','amount','method']),
                disinfectRows: collectSoilDisinfectRows('disinfect-tbody')
            }
        },
        dripDetails: {
            shared: isShared,
            data: {
                singleDouble: document.getElementById('drip-single-double')?.value || '',
                pipeDiameter: document.getElementById('drip-pipe-diameter')?.value || '',
                emitterSpacing: document.getElementById('drip-emitter-spacing')?.value || '',
                flowRate: document.getElementById('drip-flow-rate')?.value || '',
                linesCount: document.getElementById('drip-lines-count')?.value || '',
                linesSpacing: document.getElementById('drip-lines-spacing')?.value || '',
                bedSpacing: document.getElementById('drip-bed-spacing')?.value || ''
            }
        },
        ...collectProgressData(),
        events: collectEventsData(),
        updatedAt: serverTimestamp()
    };
}

// =========================================
// Save Experiment
// =========================================
async function saveExperiment() {
    if (!currentUser || !currentExperimentId || !experimentOwnerUid) return;

    const formData = collectFormData();

    try {
        // שמור לבעלים של הניסוי
        const experimentRef = doc(db, "users", experimentOwnerUid, "experiments", currentExperimentId);
        await updateDoc(experimentRef, formData);

        // עדכן שותפים - הוסף/הסר את הניסוי מהאוסף sharedExperiments שלהם
        const syncResult = await syncSharedExperiments(formData.partners);

        experimentData = { ...experimentData, ...formData };
        generateTreatmentTabs();

        // הודעת הצלחה עם מידע על שותפים
        if (syncResult && syncResult.added > 0) {
            showToast(`הניסוי נשמר! נוספו ${syncResult.added} שותפים חדשים.`, 'success');
        } else {
            showToast('הניסוי נשמר בהצלחה!', 'success');
        }
    } catch (error) {
        console.error("Error saving experiment:", error);
        showToast('שגיאה בשמירת הניסוי: ' + error.message, 'error');
    }
}

// =========================================
// Sync Shared Experiments
// =========================================
async function syncSharedExperiments(currentPartners) {
    // רק הבעלים המקורי יכול לסנכרן שותפים
    if (experimentOwnerUid !== currentUser.uid) return { added: 0, removed: 0 };

    let addedCount = 0;
    let removedCount = 0;

    try {
        // בדיקה שיש לנו את רשימת המשתמשים
        if (allUsers.length === 0) {
            showToast('שגיאה: לא ניתן לסנכרן שותפים. נסה לרענן את הדף.', 'warning');
            return { added: 0, removed: 0 };
        }

        // מצא את כל המשתמשים שהם שותפים כרגע
        const partnerEmails = currentPartners.map(p => p.email).filter(e => e);

        // מצא את ה-UID של כל שותף
        for (const partner of currentPartners) {
            if (!partner.email) continue;

            // מצא את המשתמש לפי האימייל (case-insensitive)
            const partnerUser = allUsers.find(u => u.email.toLowerCase() === partner.email.toLowerCase());

            if (partnerUser && partnerUser.uid) {
                // הוסף אסמכתא לניסוי באוסף sharedExperiments של השותף
                const sharedRef = doc(db, "users", partnerUser.uid, "sharedExperiments", currentExperimentId);
                await setDoc(sharedRef, {
                    experimentId: currentExperimentId,
                    ownerUid: currentUser.uid,
                    ownerEmail: currentUser.email,
                    addedAt: serverTimestamp()
                }, { merge: true });

                addedCount++;
            } else {
                showToast(`לא נמצא משתמש עם האימייל: ${partner.email}`, 'warning');
            }
        }

        // הסר שותפים שכבר לא ברשימה (אם יש רשימה קודמת)
        if (experimentData?.partners) {
            const previousPartners = experimentData.partners;
            for (const oldPartner of previousPartners) {
                if (!oldPartner.email) continue;
                // אם השותף הישן לא נמצא ברשימה החדשה
                if (!partnerEmails.includes(oldPartner.email)) {
                    const oldUser = allUsers.find(u => u.email.toLowerCase() === oldPartner.email.toLowerCase());
                    if (oldUser && oldUser.uid) {
                        // הסר את האסמכתא
                        const sharedRef = doc(db, "users", oldUser.uid, "sharedExperiments", currentExperimentId);
                        try {
                            await deleteDoc(sharedRef);
                            removedCount++;
                        } catch (e) {
                            // התעלם משגיאות מחיקה
                        }
                    }
                }
            }
        }

        return { added: addedCount, removed: removedCount };
    } catch (error) {
        console.error("Error syncing shared experiments:", error);
        showToast('שגיאה בסנכרון שותפים: ' + error.message, 'error');
        return { added: 0, removed: 0 };
    }
}

// =========================================
// Event Listeners
// =========================================
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

    // Form submit
    const form = document.getElementById('experiment-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveExperiment();
        });
    }


    // Treatment count change
    const treatmentsCount = document.getElementById('treatments-count');
    if (treatmentsCount) {
        treatmentsCount.addEventListener('change', () => {
            const count = parseInt(treatmentsCount.value) || 0;
            const existingTreatments = [];
            document.querySelectorAll('.treatment-name').forEach(input => {
                const index = input.dataset.index;
                const pesticideInput = document.querySelector(`.treatment-pesticide[data-index="${index}"]`);
                existingTreatments.push({
                    name: input.value,
                    pesticide: pesticideInput?.value || ''
                });
            });
            generateTreatmentInputs(count, existingTreatments);
            generateTreatmentTabs();
        });
    }

    // Add variables
    const addIndependent = document.getElementById('add-independent-var');
    const newIndependent = document.getElementById('new-independent-var');
    if (addIndependent && newIndependent) {
        addIndependent.addEventListener('click', () => {
            if (newIndependent.value.trim()) {
                addVariableRow('independent', newIndependent.value.trim());
                newIndependent.value = '';
            }
        });
        newIndependent.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addIndependent.click();
            }
        });
    }

    const addDependent = document.getElementById('add-dependent-var');
    const newDependent = document.getElementById('new-dependent-var');
    if (addDependent && newDependent) {
        addDependent.addEventListener('click', () => {
            if (newDependent.value.trim()) {
                addVariableRow('dependent', newDependent.value.trim());
                newDependent.value = '';
            }
        });
        newDependent.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addDependent.click();
            }
        });
    }

    // Add keyword
    const addKeyword = document.getElementById('add-keyword');
    const keywordsSelect = document.getElementById('keywords-select');
    if (addKeyword && keywordsSelect) {
        addKeyword.addEventListener('click', () => {
            if (keywordsSelect.value) {
                addKeywordTag(keywordsSelect.value);
                keywordsSelect.value = '';
            }
        });
    }

    // Sidebar submenu toggles
    document.querySelectorAll('.sub-item.has-submenu').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            item.classList.toggle('expanded');
            const submenuId = item.dataset.submenu;
            const submenu = document.getElementById(submenuId);
            if (submenu) {
                submenu.classList.toggle('open');
            }
        });
    });

    // View switching from sidebar
    document.querySelectorAll('.sub-sub-item[data-view]').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(item.dataset.view);
        });
    });

    document.querySelectorAll('.sub-item[data-view]').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(item.dataset.view);
        });
    });

    // Experiment header toggle
    const expHeader = document.getElementById('current-experiment-header');
    if (expHeader) {
        expHeader.addEventListener('click', () => {
            expHeader.classList.toggle('expanded');
            const submenu = expHeader.nextElementSibling;
            if (submenu) {
                submenu.classList.toggle('open');
            }
        });
    }

    // Logout
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await signOut(auth);
            window.location.href = "index.html";
        });
    }

    // Location Picker
    initLocationPicker();

    // Soil dynamic tables
    initSoilTableListeners();

    // Progress views (מהלך הניסוי) dynamic tables
    initProgressListeners();

    // Drip edit buttons – focus the paired input
    document.querySelectorAll('.drip-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = document.getElementById(btn.dataset.target);
            if (target) target.focus();
        });
    });

    // Partners Autocomplete - נקרא אחרי טעינת הניסוי ב-loadExperiment
    // initPartnersAutocomplete();
}

// =========================================
// OpenStreetMap Location Picker (Leaflet - Free!)
// =========================================
let map = null;
let marker = null;
let selectedLocation = null;

function initLocationPicker() {
    const pickLocationBtn = document.getElementById('pick-location-btn');
    const openGoogleMapsBtn = document.getElementById('open-google-maps-btn');
    const modal = document.getElementById('location-picker-modal');
    const closeBtn = document.getElementById('close-location-modal');
    const cancelBtn = document.getElementById('cancel-location');
    const confirmBtn = document.getElementById('confirm-location');
    const coordsInput = document.getElementById('site-coordinates');

    if (!pickLocationBtn) return;

    // Open in Google Maps (external link - free!)
    if (openGoogleMapsBtn) {
        openGoogleMapsBtn.addEventListener('click', () => {
            const coords = parseCoordinates(coordsInput.value);
            if (coords) {
                const url = `https://www.google.com/maps?q=${coords.lat},${coords.lng}&z=15`;
                window.open(url, '_blank');
                showToast('נפתח בגוגל מפות בטאב חדש', 'info', 2000);
            } else {
                showToast('אין קורדינטות תקינות', 'warning');
            }
        });
    }

    pickLocationBtn.addEventListener('click', () => {
        openLocationModal();
    });

    if (closeBtn) {
        closeBtn.addEventListener('click', closeLocationModal);
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeLocationModal);
    }

    if (confirmBtn) {
        confirmBtn.addEventListener('click', confirmLocation);
    }

    // Close on overlay click
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeLocationModal();
            }
        });
    }

    // Watch for changes to coordinates
    if (coordsInput) {
        coordsInput.addEventListener('change', updateGoogleMapsButtonVisibility);
        coordsInput.addEventListener('input', updateGoogleMapsButtonVisibility);
    }
}

function openLocationModal() {
    const modal = document.getElementById('location-picker-modal');
    if (!modal) return;

    modal.classList.remove('hidden');

    // Initialize map if not already initialized
    if (!map) {
        // Delay to ensure modal is visible and container has dimensions
        setTimeout(() => initMap(), 100);
    } else {
        // Invalidate size to fix display issues after modal was hidden
        map.invalidateSize();
    }
}

function closeLocationModal() {
    const modal = document.getElementById('location-picker-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

function initMap() {
    const mapContainer = document.getElementById('map-container');
    if (!mapContainer) return;

    // Default center - Israel center coordinates
    const defaultCenter = [31.5, 34.75]; // [lat, lng]

    // Try to get existing coordinates from input
    const coordsInput = document.getElementById('site-coordinates');
    let initialCenter = defaultCenter;

    if (coordsInput && coordsInput.value) {
        const coords = parseCoordinates(coordsInput.value);
        if (coords) {
            initialCenter = [coords.lat, coords.lng];
        }
    }

    // Create Leaflet map with OpenStreetMap tiles (FREE!)
    map = L.map(mapContainer).setView(initialCenter, 12);

    // Add OpenStreetMap tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);

    // Create custom icon for marker
    const customIcon = L.icon({
        iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
        iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });

    // Create draggable marker
    marker = L.marker(initialCenter, {
        draggable: true,
        icon: customIcon
    }).addTo(map);

    marker.bindPopup('גרור/י אותי או לחץ/י על המפה').openPopup();

    selectedLocation = { lat: initialCenter[0], lng: initialCenter[1] };
    updateSelectedCoordinates(selectedLocation);

    // Update coordinates when marker is dragged
    marker.on('dragend', (event) => {
        const position = marker.getLatLng();
        selectedLocation = { lat: position.lat, lng: position.lng };
        updateSelectedCoordinates(selectedLocation);
    });

    // Allow clicking on map to place marker
    map.on('click', (event) => {
        const position = event.latlng;
        marker.setLatLng(position);
        selectedLocation = { lat: position.lat, lng: position.lng };
        updateSelectedCoordinates(selectedLocation);
    });
}

function updateSelectedCoordinates(location) {
    const coordsSpan = document.getElementById('selected-coordinates');
    if (coordsSpan) {
        coordsSpan.textContent = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
    }
}

function confirmLocation() {
    if (selectedLocation) {
        const coordsInput = document.getElementById('site-coordinates');
        if (coordsInput) {
            coordsInput.value = `${selectedLocation.lat.toFixed(6)}, ${selectedLocation.lng.toFixed(6)}`;
            // Trigger change event to update Google Maps button
            coordsInput.dispatchEvent(new Event('change'));
        }
        closeLocationModal();
        showToast('המיקום נשמר בהצלחה', 'success');
    }
}

function parseCoordinates(coordsString) {
    try {
        const parts = coordsString.split(',').map(s => s.trim());
        if (parts.length === 2) {
            const lat = parseFloat(parts[0]);
            const lng = parseFloat(parts[1]);
            if (!isNaN(lat) && !isNaN(lng)) {
                return { lat, lng };
            }
        }
    } catch (e) {
        console.error('Failed to parse coordinates:', e);
    }
    return null;
}

// =========================================
// Partners Autocomplete
// =========================================
function initPartnersAutocomplete() {
    const searchInput = document.getElementById('partner-search');
    const suggestionsContainer = document.getElementById('partner-suggestions');
    const addBtn = document.getElementById('add-partner');

    if (!searchInput || !suggestionsContainer) return;

    // בדיקה אם המשתמש הנוכחי הוא הבעלים של הניסוי
    const isOwner = currentUser && experimentOwnerUid && currentUser.uid === experimentOwnerUid;

    // אם המשתמש אינו הבעלים - השבת את האפשרות להוסיף שותפים
    if (!isOwner) {
        searchInput.disabled = true;
        searchInput.placeholder = 'רק מי שהקים/ה את הניסוי יכול/ה להוסיף שותפים';
        searchInput.title = 'רק מי שהקים/ה את הניסוי יכול/ה להוסיף שותפים';
        if (addBtn) {
            addBtn.disabled = true;
            addBtn.classList.add('disabled');
            addBtn.title = 'רק מי שהקים/ה את הניסוי יכול/ה להוסיף שותפים';
        }
        return; // אין צורך להמשיך עם האירועים
    }

    // allUsers כבר נטען ב-onAuthStateChanged
    // אין צורך לטעון שוב כאן

    // Search and filter
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();

        if (query.length < 2) {
            suggestionsContainer.classList.remove('active');
            return;
        }

        const filtered = allUsers.filter(user => {
            // Don't show current user
            if (user.uid === currentUser?.uid) return false;

            // Search in name or email
            const fullName = user.fullName.toLowerCase();
            const email = user.email.toLowerCase();
            return fullName.includes(query) || email.includes(query);
        });

        displaySuggestions(filtered, suggestionsContainer);
    });

    // Add partner button
    if (addBtn) {
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (selectedPartner) {
                addPartnerFromSelection(selectedPartner);
                searchInput.value = '';
                selectedPartner = null;
                suggestionsContainer.classList.remove('active');
            } else if (searchInput.value.trim()) {
                showToast('נא לבחור/י שותף מהרשימה', 'warning');
            }
        });
    }

    // Close suggestions when clicking outside
    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !suggestionsContainer.contains(e.target)) {
            suggestionsContainer.classList.remove('active');
        }
    });

    // Enter key to select first suggestion
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const firstSuggestion = suggestionsContainer.querySelector('.suggestion-item');
            if (firstSuggestion) {
                firstSuggestion.click();
            }
        }
    });
}

function displaySuggestions(users, container) {
    if (users.length === 0) {
        container.innerHTML = '<div style="padding: 12px; color: #999; text-align: center;">לא נמצאו תוצאות</div>';
        container.classList.add('active');
        return;
    }

    container.innerHTML = '';
    users.forEach(user => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.innerHTML = `
            <div class="suggestion-name">${user.fullName || user.email}</div>
            <div class="suggestion-email">${user.email}</div>
            <div class="suggestion-role">${user.role || 'לא צוין תפקיד'}</div>
        `;

        item.addEventListener('click', () => {
            selectPartner(user);
        });

        container.appendChild(item);
    });

    container.classList.add('active');
}

function selectPartner(user) {
    // מוסיף ישירות כאשר בוחרים מהרשימה
    addPartnerFromSelection(user);

    const searchInput = document.getElementById('partner-search');
    if (searchInput) {
        searchInput.value = '';
    }

    const suggestionsContainer = document.getElementById('partner-suggestions');
    if (suggestionsContainer) {
        suggestionsContainer.classList.remove('active');
    }

    selectedPartner = null;
}

function addPartnerFromSelection(user) {
    // Check if partner already exists
    const existingPartners = document.querySelectorAll('.partner-row');
    for (const row of existingPartners) {
        if (row.dataset.email === user.email) {
            showToast('שותף זה כבר קיים ברשימה', 'warning');
            return;
        }
    }

    addPartnerRow({
        name: user.fullName || user.email,
        email: user.email
    });

    showToast(`השותף/ה ${user.fullName} נוסף/ה בהצלחה`, 'success');
}

// =========================================
// Events Log (יומן אירועים)
// =========================================
let eventsData = []; // מערך לשמירת אירועים

function initEventsLog() {
    const addEventBtn = document.getElementById('add-event-btn');
    if (addEventBtn) {
        addEventBtn.addEventListener('click', () => addEventRow());
    }

    // טען אירועים קיימים
    loadEvents();
}

function loadEvents() {
    eventsData = experimentData?.events || [];
    renderEventsTable();
}

function renderEventsTable() {
    const tableBody = document.getElementById('events-table-body');
    const container = document.querySelector('.events-table-container');

    if (!tableBody || !container) return;

    tableBody.innerHTML = '';

    if (eventsData.length === 0) {
        container.classList.remove('has-events');
        return;
    }

    container.classList.add('has-events');

    eventsData.forEach((event, index) => {
        const row = createEventRow(event, index);
        tableBody.appendChild(row);
    });
}

function createEventRow(event = {}, index) {
    const row = document.createElement('tr');
    row.dataset.eventIndex = index;

    const today = new Date().toISOString().split('T')[0];

    row.innerHTML = `
        <td data-label="תאריך">
            <input type="date" class="event-date" value="${event.date || today}" data-index="${index}">
        </td>
        <td data-label="תיאור">
            <textarea class="event-description" placeholder="תאר/י את האירוע..." data-index="${index}">${event.description || ''}</textarea>
        </td>
        <td data-label="קובץ">
            <div class="file-upload-cell">
                ${event.fileUrl ? `
                    <div class="file-info">
                        <i class="fas fa-file"></i>
                        <span class="file-name" title="${event.fileName || 'קובץ'}">${truncateFileName(event.fileName || 'קובץ')}</span>
                        <button type="button" class="btn-file-action btn-download" title="הורד קובץ" data-url="${event.fileUrl}">
                            <i class="fas fa-download"></i>
                        </button>
                        <button type="button" class="btn-file-action btn-delete-file" title="מחק קובץ" data-index="${index}">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                ` : `
                    <div class="file-input-wrapper">
                        <button type="button" class="btn-upload-file">
                            <i class="fas fa-upload"></i>
                            <span>בחר קובץ</span>
                        </button>
                        <input type="file" class="event-file-input" data-index="${index}" accept="*/*">
                    </div>
                `}
                <div class="upload-progress" style="display: none;" data-index="${index}">
                    <div class="progress-bar">
                        <div class="progress-bar-fill" style="width: 0%"></div>
                    </div>
                    <span class="progress-text">0%</span>
                </div>
            </div>
        </td>
        <td data-label="פעולות">
            <div class="events-actions">
                <button type="button" class="btn-delete-event" title="מחק אירוע" data-index="${index}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </td>
    `;

    // Event listeners
    const fileInput = row.querySelector('.event-file-input');
    if (fileInput) {
        fileInput.addEventListener('change', (e) => handleFileUpload(e, index));
    }

    const downloadBtn = row.querySelector('.btn-download');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            const url = downloadBtn.dataset.url;
            if (url) {
                window.open(url, '_blank');
            }
        });
    }

    const deleteFileBtn = row.querySelector('.btn-delete-file');
    if (deleteFileBtn) {
        deleteFileBtn.addEventListener('click', () => deleteEventFile(index));
    }

    const deleteEventBtn = row.querySelector('.btn-delete-event');
    if (deleteEventBtn) {
        deleteEventBtn.addEventListener('click', () => deleteEvent(index));
    }

    // Auto-save on change
    const dateInput = row.querySelector('.event-date');
    const descInput = row.querySelector('.event-description');

    if (dateInput) {
        dateInput.addEventListener('change', () => updateEventData(index));
    }
    if (descInput) {
        descInput.addEventListener('blur', () => updateEventData(index));
    }

    return row;
}

function addEventRow() {
    const today = new Date().toISOString().split('T')[0];

    eventsData.push({
        date: today,
        description: '',
        fileName: null,
        fileUrl: null,
        filePath: null,
        createdAt: new Date().toISOString()
    });

    renderEventsTable();
    showToast('שורת אירוע חדשה נוספה', 'info');
}

function updateEventData(index) {
    const row = document.querySelector(`tr[data-event-index="${index}"]`);
    if (!row) return;

    const dateInput = row.querySelector('.event-date');
    const descInput = row.querySelector('.event-description');

    if (eventsData[index]) {
        eventsData[index].date = dateInput?.value || '';
        eventsData[index].description = descInput?.value || '';
    }
}

async function handleFileUpload(e, eventIndex) {
    const file = e.target.files[0];
    if (!file) return;

    // בדיקת גודל קובץ (מקסימום 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
        showToast('הקובץ גדול מדי. גודל מקסימלי: 10MB', 'error');
        return;
    }

    // יצירת נתיב לקובץ ב-Storage
    // מבנה: users/{userId}/experiments/{experimentId}/events/{timestamp}_{filename}
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `users/${experimentOwnerUid}/experiments/${currentExperimentId}/events/${timestamp}_${safeName}`;

    const storageRef = ref(storage, filePath);
    const uploadTask = uploadBytesResumable(storageRef, file);

    // הצג את סרגל ההתקדמות
    const progressContainer = document.querySelector(`.upload-progress[data-index="${eventIndex}"]`);
    const progressBarFill = progressContainer?.querySelector('.progress-bar-fill');
    const progressText = progressContainer?.querySelector('.progress-text');

    if (progressContainer) {
        progressContainer.style.display = 'flex';
    }

    // החבא את כפתור ההעלאה
    const uploadWrapper = document.querySelector(`tr[data-event-index="${eventIndex}"] .file-input-wrapper`);
    if (uploadWrapper) {
        uploadWrapper.style.display = 'none';
    }

    uploadTask.on('state_changed',
        (snapshot) => {
            // התקדמות
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            if (progressBarFill) {
                progressBarFill.style.width = progress + '%';
            }
            if (progressText) {
                progressText.textContent = Math.round(progress) + '%';
            }
        },
        (error) => {
            // שגיאה
            console.error('Upload error:', error);
            showToast('שגיאה בהעלאת הקובץ: ' + error.message, 'error');

            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
            if (uploadWrapper) {
                uploadWrapper.style.display = 'block';
            }
        },
        async () => {
            // הצלחה
            try {
                const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);

                // עדכן את האירוע עם פרטי הקובץ
                eventsData[eventIndex].fileName = file.name;
                eventsData[eventIndex].fileUrl = downloadURL;
                eventsData[eventIndex].filePath = filePath;

                // רענן את הטבלה
                renderEventsTable();

                showToast('הקובץ הועלה בהצלחה!', 'success');
            } catch (error) {
                console.error('Error getting download URL:', error);
                showToast('שגיאה בקבלת קישור לקובץ', 'error');
            }
        }
    );
}

async function deleteEventFile(eventIndex) {
    const event = eventsData[eventIndex];
    if (!event || !event.filePath) return;

    if (!confirm('האם למחוק את הקובץ?')) return;

    try {
        const storageRef = ref(storage, event.filePath);
        await deleteObject(storageRef);

        // עדכן את האירוע
        eventsData[eventIndex].fileName = null;
        eventsData[eventIndex].fileUrl = null;
        eventsData[eventIndex].filePath = null;

        renderEventsTable();
        showToast('הקובץ נמחק בהצלחה', 'success');
    } catch (error) {
        console.error('Error deleting file:', error);
        // אם הקובץ לא קיים - נקה את הנתונים בכל מקרה
        if (error.code === 'storage/object-not-found') {
            eventsData[eventIndex].fileName = null;
            eventsData[eventIndex].fileUrl = null;
            eventsData[eventIndex].filePath = null;
            renderEventsTable();
        } else {
            showToast('שגיאה במחיקת הקובץ: ' + error.message, 'error');
        }
    }
}

async function deleteEvent(eventIndex) {
    if (!confirm('האם למחוק את האירוע?')) return;

    const event = eventsData[eventIndex];

    // מחק קובץ אם קיים
    if (event?.filePath) {
        try {
            const storageRef = ref(storage, event.filePath);
            await deleteObject(storageRef);
        } catch (error) {
            console.error('Error deleting event file:', error);
            // המשך גם אם המחיקה נכשלה
        }
    }

    // הסר מהמערך
    eventsData.splice(eventIndex, 1);

    renderEventsTable();
    showToast('האירוע נמחק בהצלחה', 'success');
}

function truncateFileName(name, maxLength = 15) {
    if (!name) return 'קובץ';
    if (name.length <= maxLength) return name;

    const ext = name.split('.').pop();
    const baseName = name.substring(0, name.length - ext.length - 1);
    const truncatedBase = baseName.substring(0, maxLength - ext.length - 4);

    return `${truncatedBase}...${ext}`;
}

function collectEventsData() {
    // עדכן את כל השדות לפני איסוף
    eventsData.forEach((_, index) => {
        updateEventData(index);
    });

    return eventsData;
}

// =========================================
// Soil Treatment – Dynamic Tables
// =========================================

function renderSoilTable(tbodyId, rows, fields) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = '';
    rows.forEach(row => addSoilTableRow(tbody, fields, row));
}

function addSoilTableRow(tbody, fields, data = {}) {
    const labels = { date: 'תאריך', amount: 'כמות', method: 'אופן יישום' };
    const tr = document.createElement('tr');
    fields.forEach(field => {
        const td = document.createElement('td');
        td.dataset.label = labels[field] || field;
        if (field === 'date') {
            const inp = document.createElement('input');
            inp.type = 'date';
            inp.className = 'soil-input';
            inp.dataset.field = field;
            inp.value = data[field] || '';
            td.appendChild(inp);
        } else {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'soil-input';
            inp.dataset.field = field;
            inp.value = data[field] || '';
            inp.placeholder = field === 'amount' ? 'כמות' : 'אופן יישום';
            td.appendChild(inp);
        }
        tr.appendChild(td);
    });
    // Delete button cell
    const tdDel = document.createElement('td');
    tdDel.dataset.label = '';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-del-soil-row';
    delBtn.innerHTML = '<i class="fas fa-trash"></i>';
    delBtn.addEventListener('click', () => tr.remove());
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
}

function renderSoilDisinfectTable(tbodyId, rows) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = '';
    rows.forEach(row => addSoilDisinfectRow(tbody, row));
}

function addSoilDisinfectRow(tbody, data = {}) {
    const fields = ['date','material','amount','method'];
    const labels = { date: 'תאריך', material: 'חומר החיטוי', amount: 'כמות', method: 'אופן יישום' };
    const placeholders = { date: '', material: 'חומר החיטוי', amount: 'כמות', method: 'אופן יישום' };
    const tr = document.createElement('tr');
    fields.forEach(field => {
        const td = document.createElement('td');
        td.dataset.label = labels[field] || field;
        const inp = document.createElement('input');
        inp.type = field === 'date' ? 'date' : 'text';
        inp.className = 'soil-input';
        inp.dataset.field = field;
        inp.value = data[field] || '';
        if (placeholders[field]) inp.placeholder = placeholders[field];
        td.appendChild(inp);
        tr.appendChild(td);
    });
    const tdDel = document.createElement('td');
    tdDel.dataset.label = '';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-del-soil-row';
    delBtn.innerHTML = '<i class="fas fa-trash"></i>';
    delBtn.addEventListener('click', () => tr.remove());
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
}

function collectSoilTableRows(tbodyId, fields) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return [];
    const rows = [];
    tbody.querySelectorAll('tr').forEach(tr => {
        const obj = {};
        fields.forEach(field => {
            const inp = tr.querySelector(`[data-field="${field}"]`);
            obj[field] = inp ? inp.value : '';
        });
        rows.push(obj);
    });
    return rows;
}

function collectSoilDisinfectRows(tbodyId) {
    return collectSoilTableRows(tbodyId, ['date','material','amount','method']);
}

function initSoilTableListeners() {
    const compostTbody = document.getElementById('compost-tbody');
    const sprayTbody = document.getElementById('spray-tbody');
    const disinfectTbody = document.getElementById('disinfect-tbody');

    document.getElementById('add-compost-row')?.addEventListener('click', () =>
        addSoilTableRow(compostTbody, ['date','amount','method']));

    document.getElementById('add-spray-row')?.addEventListener('click', () =>
        addSoilTableRow(sprayTbody, ['date','amount','method']));

    document.getElementById('add-disinfect-row')?.addEventListener('click', () =>
        addSoilDisinfectRow(disinfectTbody));
}

// =========================================
// Progress Views – Default Row Data
// =========================================
const DEFAULT_GROWTH_ROWS = [
    'קצב צימוח (גובה)', 'עובי הגבעול', 'מספר פרחים בתפרחת', 'מספר חנטים',
    'LAI', 'מוליכות פיוניות', 'SPAD', 'פוטוסינתזה', 'ביומסה - רטוב', 'ביומסה - יבש'
];

const DEFAULT_CLIMATE_ROWS = [
    { name: 'טמפרטורה', location: 'חממה' },
    { name: 'לחות יחסית', location: 'חממה' },
    { name: 'לחץ אדים', location: 'חממה' },
    { name: 'מהירות רוח', location: 'חממה' },
    { name: 'כיוון רוח', location: 'חממה' },
    { name: 'מהירות רוח רגעית', location: '' },
    { name: 'קרינה PAR', location: 'חממה' },
    { name: 'קרינה נטו', location: 'חממה' },
    { name: 'רטיבות נפחית', location: 'קרקע' },
    { name: 'טמפרטורה', location: 'קרקע' },
    { name: 'מוליכות חשמלית', location: 'קרקע' },
    { name: 'טנסיומטרים', location: 'קרקע' },
    { name: 'פוטנציאל מים בקרקע', location: 'קרקע' },
    { name: 'EC', location: 'קרקע' },
    { name: 'PH', location: 'קרקע' }
];

const DEFAULT_AGRO_ROWS = ['שוצים', 'הדליות', 'עישוב', 'גיזום', 'עקירה'];

// =========================================
// Progress Views – Generic Row Builder
// =========================================
function addProgressRow(tbody, fields, labels, data, options) {
    if (!tbody) return;
    data = data || {};
    options = options || {};
    const tr = document.createElement('tr');
    fields.forEach(field => {
        const td = document.createElement('td');
        td.dataset.label = labels[field] || field;
        const isReadonly = options.readonlyFields && options.readonlyFields.includes(field) && data[field];
        const inputType = (options.inputTypes && options.inputTypes[field]) || 'text';
        const inp = document.createElement('input');
        inp.type = inputType;
        inp.className = 'soil-input';
        inp.dataset.field = field;
        inp.value = data[field] || '';
        if (labels[field]) inp.placeholder = labels[field];
        if (isReadonly) { inp.readOnly = true; inp.style.fontWeight = '600'; }
        td.appendChild(inp);
        tr.appendChild(td);
    });
    const tdDel = document.createElement('td');
    tdDel.dataset.label = '';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-del-soil-row';
    delBtn.innerHTML = '<i class="fas fa-trash"></i>';
    delBtn.addEventListener('click', () => tr.remove());
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
}

function collectProgressRows(tbodyId, fields) {
    return collectSoilTableRows(tbodyId, fields);
}

// =========================================
// Irrigation & Fertilization
// =========================================
const IRRIGATION_FIELDS = ['fileName','uploadDate','measureDates','totalWater'];
const IRRIGATION_LABELS = { fileName:'שם הקובץ', uploadDate:'תאריך העלאה', measureDates:'תאריכי מדידה', totalWater:'סה"כ כמות מים (ליטר)' };
const FERTILIZATION_FIELDS = ['fileName','uploadDate','measureDates','fertType','company','totalFert'];
const FERTILIZATION_LABELS = { fileName:'שם הקובץ', uploadDate:'תאריך העלאה', measureDates:'תאריכי מדידה', fertType:'סוג הדשן', company:'חברה', totalFert:'סה"כ כמות דשן' };

// =========================================
// Growth
// =========================================
const GROWTH_FIELDS = ['name','value','measureDate'];
const GROWTH_LABELS = { name:'נתון', value:'ערך', measureDate:'תאריך מדידה' };

function renderGrowthTable(rows) {
    const tbody = document.getElementById('growth-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (rows && rows.length > 0) {
        rows.forEach(row => addProgressRow(tbody, GROWTH_FIELDS, GROWTH_LABELS, row, { readonlyFields: ['name'] }));
    }
}

// =========================================
// Climate
// =========================================
const CLIMATE_FIELDS = ['name','location','sensorPosition','sensorDepth','measureDates','notes'];
const CLIMATE_LABELS = { name:'נתון', location:'מיקום מדידה', sensorPosition:'מיקום חיישן במרחב', sensorDepth:'גובה/עומק חיישן', measureDates:'תאריכי מדידה', notes:'הערות' };

function renderClimateTable(rows) {
    const tbody = document.getElementById('climate-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rows || rows.length === 0) {
        DEFAULT_CLIMATE_ROWS.forEach(def => {
            addProgressRow(tbody, CLIMATE_FIELDS, CLIMATE_LABELS, { name: def.name, location: def.location }, { readonlyFields: ['name'] });
        });
    } else {
        rows.forEach(row => addProgressRow(tbody, CLIMATE_FIELDS, CLIMATE_LABELS, row, { readonlyFields: ['name'] }));
    }
}

// =========================================
// Agrotechnics
// =========================================
const AGRO_FIELDS = ['action','actionDate','hours','workers'];
const AGRO_LABELS = { action:'פעולה', actionDate:'תאריך ביצוע הפעולה', hours:'כמות שעות לפעולה', workers:'כמות עובדים לפעולה' };

function renderAgroTable(rows) {
    const tbody = document.getElementById('agro-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rows || rows.length === 0) {
        DEFAULT_AGRO_ROWS.forEach(action => {
            addProgressRow(tbody, AGRO_FIELDS, AGRO_LABELS, { action }, { readonlyFields: ['action'] });
        });
    } else {
        rows.forEach(row => addProgressRow(tbody, AGRO_FIELDS, AGRO_LABELS, row, { readonlyFields: ['action'] }));
    }
}

// =========================================
// Plant Protection
// =========================================
const PEST_FIELDS = ['pest','date','notes'];
const PEST_LABELS = { pest:'מפגע שאובחן', date:'תאריך', notes:'הערות' };
const PROTECTION_FIELDS = ['material','date','dosage','combined','notes'];
const PROTECTION_LABELS = { material:'חומר', date:'תאריך', dosage:'מינון לטיפול', combined:'משולב עם חומרים נוספים', notes:'הערות' };

function addPestRow(tbodyId, data) {
    addProgressRow(document.getElementById(tbodyId), PEST_FIELDS, PEST_LABELS, data || {});
}
function addProtectionRow(tbodyId, data) {
    addProgressRow(document.getElementById(tbodyId), PROTECTION_FIELDS, PROTECTION_LABELS, data || {});
}

// =========================================
// Yield
// =========================================
const YIELD_MEASURE_FIELDS = ['measureDate','fruitFloor','quality','quantity','fruitDesc','notes'];
const YIELD_MEASURE_LABELS = { measureDate:'תאריך מדידה', fruitFloor:'קומת הפרי', quality:'איכות (לק"ג)', quantity:'כמות (ק"ג)', fruitDesc:'תיאור הפרי', notes:'הערות' };
const YIELD_DAMAGE_FIELDS = ['measureDate','damage','damageIndex','damageValue','damageDesc'];
const YIELD_DAMAGE_LABELS = { measureDate:'תאריך מדידה', damage:'הפגע הנמדד', damageIndex:'מדד נזק (%/ס"מ/No.)', damageValue:'ערך הנזק', damageDesc:'תיאור הנזק' };

function addYieldMeasureRow(data) { addProgressRow(document.getElementById('yield-measure-tbody'), YIELD_MEASURE_FIELDS, YIELD_MEASURE_LABELS, data || {}); }
function addYieldDamageRow(data) { addProgressRow(document.getElementById('yield-damage-tbody'), YIELD_DAMAGE_FIELDS, YIELD_DAMAGE_LABELS, data || {}); }

// =========================================
// Progress Views – Populate
// =========================================
function populateProgressViews(data) {
    // Irrigation
    const irrigTbody = document.getElementById('irrigation-tbody');
    if (irrigTbody) { irrigTbody.innerHTML = ''; (data.irrigationData || []).forEach(r => addProgressRow(irrigTbody, IRRIGATION_FIELDS, IRRIGATION_LABELS, r)); }
    // Fertilization
    const fertTbody = document.getElementById('fertilization-tbody');
    if (fertTbody) { fertTbody.innerHTML = ''; (data.fertilizationData || []).forEach(r => addProgressRow(fertTbody, FERTILIZATION_FIELDS, FERTILIZATION_LABELS, r)); }
    // Growth, Climate, Agro – use their render functions (handle defaults)
    renderGrowthTable(data.growthData);
    renderClimateTable(data.climateData);
    renderAgroTable(data.agrotechnicsData);
    // Plant Protection
    const pp = data.plantProtectionData || {};
    const pestTbody = document.getElementById('pest-tbody');
    if (pestTbody) { pestTbody.innerHTML = ''; (pp.pests || []).forEach(r => addPestRow('pest-tbody', r)); }
    const diseaseTbody = document.getElementById('disease-tbody');
    if (diseaseTbody) { diseaseTbody.innerHTML = ''; (pp.diseases || []).forEach(r => addPestRow('disease-tbody', r)); }
    const sprayProtTbody = document.getElementById('spray-prot-tbody');
    if (sprayProtTbody) { sprayProtTbody.innerHTML = ''; (pp.sprays || []).forEach(r => addProtectionRow('spray-prot-tbody', r)); }
    const drenchTbody = document.getElementById('drench-tbody');
    if (drenchTbody) { drenchTbody.innerHTML = ''; (pp.drenches || []).forEach(r => addProtectionRow('drench-tbody', r)); }
    // Yield
    const yd = data.yieldData || {};
    const ymTbody = document.getElementById('yield-measure-tbody');
    if (ymTbody) { ymTbody.innerHTML = ''; (yd.measures || []).forEach(r => addYieldMeasureRow(r)); }
    const ydTbody = document.getElementById('yield-damage-tbody');
    if (ydTbody) { ydTbody.innerHTML = ''; (yd.damages || []).forEach(r => addYieldDamageRow(r)); }
}

// =========================================
// Progress Views – Collect
// =========================================
function collectProgressData() {
    return {
        irrigationData: collectProgressRows('irrigation-tbody', IRRIGATION_FIELDS),
        fertilizationData: collectProgressRows('fertilization-tbody', FERTILIZATION_FIELDS),
        growthData: collectProgressRows('growth-tbody', GROWTH_FIELDS),
        climateData: collectProgressRows('climate-tbody', CLIMATE_FIELDS),
        agrotechnicsData: collectProgressRows('agro-tbody', AGRO_FIELDS),
        plantProtectionData: {
            pests: collectProgressRows('pest-tbody', PEST_FIELDS),
            diseases: collectProgressRows('disease-tbody', PEST_FIELDS),
            sprays: collectProgressRows('spray-prot-tbody', PROTECTION_FIELDS),
            drenches: collectProgressRows('drench-tbody', PROTECTION_FIELDS)
        },
        yieldData: {
            measures: collectProgressRows('yield-measure-tbody', YIELD_MEASURE_FIELDS),
            damages: collectProgressRows('yield-damage-tbody', YIELD_DAMAGE_FIELDS)
        }
    };
}

// =========================================
// Progress Views – Init Listeners
// =========================================
function initProgressListeners() {
    // Irrigation & Fertilization – open modals
    document.getElementById('add-irrigation-row')?.addEventListener('click', () => openIrrigationModal());
    document.getElementById('add-fertilization-row')?.addEventListener('click', () => openFertilizationModal());
    // Growth – open modal
    document.getElementById('add-growth-row')?.addEventListener('click', () => openGrowthModal());
    // Rest – direct add
    document.getElementById('add-climate-row')?.addEventListener('click', () => addProgressRow(document.getElementById('climate-tbody'), CLIMATE_FIELDS, CLIMATE_LABELS));
    document.getElementById('add-agro-row')?.addEventListener('click', () => addProgressRow(document.getElementById('agro-tbody'), AGRO_FIELDS, AGRO_LABELS));
    document.getElementById('add-pest-row')?.addEventListener('click', () => addPestRow('pest-tbody'));
    document.getElementById('add-disease-row')?.addEventListener('click', () => addPestRow('disease-tbody'));
    document.getElementById('add-spray-prot-row')?.addEventListener('click', () => addProtectionRow('spray-prot-tbody'));
    document.getElementById('add-drench-row')?.addEventListener('click', () => addProtectionRow('drench-tbody'));
    document.getElementById('add-yield-measure-row')?.addEventListener('click', () => addYieldMeasureRow());
    document.getElementById('add-yield-damage-row')?.addEventListener('click', () => addYieldDamageRow());

    // Modal buttons
    document.getElementById('irr-modal-cancel')?.addEventListener('click', () => closeModal('irrigation-file-modal'));
    document.getElementById('irr-modal-save')?.addEventListener('click', () => saveIrrigationFile());
    document.getElementById('fert-modal-cancel')?.addEventListener('click', () => closeModal('fertilization-file-modal'));
    document.getElementById('fert-modal-save')?.addEventListener('click', () => saveFertilizationFile());
    document.getElementById('growth-modal-cancel')?.addEventListener('click', () => closeModal('growth-data-modal'));
    document.getElementById('growth-modal-save')?.addEventListener('click', () => saveGrowthData());

    // Dropzone visual
    initDropzone('irr-modal-dropzone', 'irr-modal-file', 'irr-modal-file-name');
    initDropzone('fert-modal-dropzone', 'fert-modal-file', 'fert-modal-file-name');
}

// =========================================
// Modal Helpers
// =========================================
function openModal(id) {
    document.getElementById(id)?.classList.remove('hidden');
}
function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
}

function initDropzone(dropzoneId, fileInputId, labelId) {
    const dropzone = document.getElementById(dropzoneId);
    const fileInput = document.getElementById(fileInputId);
    const label = document.getElementById(labelId);
    if (!dropzone || !fileInput) return;

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            if (label) label.textContent = e.dataTransfer.files[0].name;
        }
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length && label) {
            label.textContent = fileInput.files[0].name;
        }
    });
}

// =========================================
// Irrigation Modal
// =========================================
function openIrrigationModal() {
    document.getElementById('irr-modal-filename').value = '';
    document.getElementById('irr-modal-dates').value = '';
    document.getElementById('irr-modal-total').value = '';
    document.getElementById('irr-modal-file').value = '';
    document.getElementById('irr-modal-file-name').textContent = 'גרור/י קובץ לכאן או לחץ/י לבחירה';
    document.getElementById('irr-modal-progress')?.classList.add('hidden');
    openModal('irrigation-file-modal');
}

async function saveIrrigationFile() {
    const fileName = document.getElementById('irr-modal-filename').value.trim();
    const measureDates = document.getElementById('irr-modal-dates').value.trim();
    const totalWater = document.getElementById('irr-modal-total').value.trim();
    const fileInput = document.getElementById('irr-modal-file');
    const file = fileInput?.files[0];

    if (!fileName) {
        showToast('יש להזין שם קובץ', 'error');
        return;
    }

    let fileUrl = '';
    let filePath = '';
    const today = new Date().toLocaleDateString('he-IL');

    if (file) {
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) {
            showToast('הקובץ גדול מדי. גודל מקסימלי: 10MB', 'error');
            return;
        }
        try {
            const result = await uploadProgressFile(file, 'irrigation', 'irr-modal-progress', 'irr-modal-progress-fill', 'irr-modal-progress-text');
            fileUrl = result.url;
            filePath = result.path;
        } catch (err) {
            showToast('שגיאה בהעלאת הקובץ: ' + err.message, 'error');
            return;
        }
    }

    const tbody = document.getElementById('irrigation-tbody');
    addProgressRow(tbody, IRRIGATION_FIELDS, IRRIGATION_LABELS, {
        fileName: fileName,
        uploadDate: today,
        measureDates: measureDates,
        totalWater: totalWater
    });
    // Store file info on the last row
    if (fileUrl) {
        const lastRow = tbody.lastElementChild;
        if (lastRow) { lastRow.dataset.fileUrl = fileUrl; lastRow.dataset.filePath = filePath; }
    }

    closeModal('irrigation-file-modal');
    showToast('קובץ השקיה נוסף בהצלחה', 'success');
}

// =========================================
// Fertilization Modal
// =========================================
function openFertilizationModal() {
    document.getElementById('fert-modal-filename').value = '';
    document.getElementById('fert-modal-dates').value = '';
    document.getElementById('fert-modal-type').value = '';
    document.getElementById('fert-modal-company').value = '';
    document.getElementById('fert-modal-total').value = '';
    document.getElementById('fert-modal-file').value = '';
    document.getElementById('fert-modal-file-name').textContent = 'גרור/י קובץ לכאן או לחץ/י לבחירה';
    document.getElementById('fert-modal-progress')?.classList.add('hidden');
    openModal('fertilization-file-modal');
}

async function saveFertilizationFile() {
    const fileName = document.getElementById('fert-modal-filename').value.trim();
    const measureDates = document.getElementById('fert-modal-dates').value.trim();
    const fertType = document.getElementById('fert-modal-type').value.trim();
    const company = document.getElementById('fert-modal-company').value.trim();
    const totalFert = document.getElementById('fert-modal-total').value.trim();
    const fileInput = document.getElementById('fert-modal-file');
    const file = fileInput?.files[0];

    if (!fileName) {
        showToast('יש להזין שם קובץ', 'error');
        return;
    }

    let fileUrl = '';
    let filePath = '';
    const today = new Date().toLocaleDateString('he-IL');

    if (file) {
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) {
            showToast('הקובץ גדול מדי. גודל מקסימלי: 10MB', 'error');
            return;
        }
        try {
            const result = await uploadProgressFile(file, 'fertilization', 'fert-modal-progress', 'fert-modal-progress-fill', 'fert-modal-progress-text');
            fileUrl = result.url;
            filePath = result.path;
        } catch (err) {
            showToast('שגיאה בהעלאת הקובץ: ' + err.message, 'error');
            return;
        }
    }

    const tbody = document.getElementById('fertilization-tbody');
    addProgressRow(tbody, FERTILIZATION_FIELDS, FERTILIZATION_LABELS, {
        fileName: fileName,
        uploadDate: today,
        measureDates: measureDates,
        fertType: fertType,
        company: company,
        totalFert: totalFert
    });
    if (fileUrl) {
        const lastRow = tbody.lastElementChild;
        if (lastRow) { lastRow.dataset.fileUrl = fileUrl; lastRow.dataset.filePath = filePath; }
    }

    closeModal('fertilization-file-modal');
    showToast('קובץ דישון נוסף בהצלחה', 'success');
}

// =========================================
// Growth Modal
// =========================================
function openGrowthModal() {
    document.getElementById('growth-modal-name').value = '';
    document.getElementById('growth-modal-date').value = '';
    document.getElementById('growth-modal-value').value = '';
    openModal('growth-data-modal');
}

function saveGrowthData() {
    const name = document.getElementById('growth-modal-name').value;
    const measureDate = document.getElementById('growth-modal-date').value;
    const value = document.getElementById('growth-modal-value').value.trim();

    if (!name) {
        showToast('יש לבחור נתון', 'error');
        return;
    }

    const tbody = document.getElementById('growth-tbody');
    addProgressRow(tbody, GROWTH_FIELDS, GROWTH_LABELS, {
        name: name,
        value: value,
        measureDate: measureDate
    }, { readonlyFields: ['name'] });

    closeModal('growth-data-modal');
    showToast('נתון צימוח נוסף בהצלחה', 'success');
}

// =========================================
// Upload File to Firebase Storage (shared)
// =========================================
async function uploadProgressFile(file, folder, progressId, fillId, textId) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `users/${experimentOwnerUid}/experiments/${currentExperimentId}/${folder}/${timestamp}_${safeName}`;
        const storageRef = ref(storage, path);
        const uploadTask = uploadBytesResumable(storageRef, file);

        const progressEl = document.getElementById(progressId);
        const fillEl = document.getElementById(fillId);
        const textEl = document.getElementById(textId);
        if (progressEl) progressEl.classList.remove('hidden');

        uploadTask.on('state_changed',
            (snapshot) => {
                const pct = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                if (fillEl) fillEl.style.width = pct + '%';
                if (textEl) textEl.textContent = Math.round(pct) + '%';
            },
            (error) => {
                if (progressEl) progressEl.classList.add('hidden');
                reject(error);
            },
            async () => {
                try {
                    const url = await getDownloadURL(uploadTask.snapshot.ref);
                    if (progressEl) progressEl.classList.add('hidden');
                    resolve({ url, path });
                } catch (err) { reject(err); }
            }
        );
    });
}


