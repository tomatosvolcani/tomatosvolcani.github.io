// js/experiment.js
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc,
    getDoc,
    updateDoc,
    setDoc,
    deleteDoc,
    serverTimestamp,
    collection,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
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
        }
    } catch (error) {
        console.error("Error fetching user data:", error);
    }
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
        } else {
            showToast('הניסוי לא נמצא', 'error');
            window.location.href = "dashboard.html";
        }
    } catch (error) {
        console.error("Error loading experiment:", error);
        showToast('שגיאה בטעינת הניסוי', 'error');
    } finally {
        // הס��ר את הספינר והצג את התוכן
        if (loadingContainer) loadingContainer.classList.add('hidden');
        if (experimentContent) experimentContent.style.display = 'block';
    }
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
        setFieldValue('soil-type', soil.type);
        setFieldValue('soil-disinfection', soil.disinfection);
        setFieldValue('disinfection-type', soil.disinfectionType);
        setFieldValue('basic-fertilization', soil.basicFertilization);
        setFieldValue('soil-notes', soil.notes);
    }

    // Drip details
    if (data.dripDetails && data.dripDetails.data) {
        const drip = data.dripDetails.data;
        setFieldValue('drip-type', drip.type);
        setFieldValue('drip-flow', drip.flow);
        setFieldValue('drip-spacing', drip.spacing);
        setFieldValue('drip-rows', drip.rows);
        setFieldValue('drip-notes', drip.notes);
    }

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
    const viewsWithTabs = ['crop', 'structure', 'soil', 'drip'];

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
        'progress-actions': 'פעולות שוטפות',
        'yield': 'נתוני יבול',
        'events': 'יומן אירועים'
    };

    // Views that belong to "הכנות לניסוי"
    const prepViews = ['crop', 'structure', 'soil', 'drip'];
    // Views that belong to "מהלך הניסוי"
    const progressViews = ['progress-actions'];

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
                type: document.getElementById('soil-type')?.value || '',
                disinfection: document.getElementById('soil-disinfection')?.value || '',
                disinfectionType: document.getElementById('disinfection-type')?.value || '',
                basicFertilization: document.getElementById('basic-fertilization')?.value || '',
                notes: document.getElementById('soil-notes')?.value || ''
            }
        },
        dripDetails: {
            shared: isShared,
            data: {
                type: document.getElementById('drip-type')?.value || '',
                flow: document.getElementById('drip-flow')?.value || '',
                spacing: document.getElementById('drip-spacing')?.value || '',
                rows: document.getElementById('drip-rows')?.value || '',
                notes: document.getElementById('drip-notes')?.value || ''
            }
        },
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

