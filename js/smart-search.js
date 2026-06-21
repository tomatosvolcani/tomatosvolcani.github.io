// js/smart-search.js
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    collectionGroup,
    doc,
    getDoc,
    getDocs,
    limit,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from "./toast.js";
import { initServerTime, getTrustedNow } from "./server-time.js";
import { timestampToDate } from "./permissions-utils.js";

const ACTIVE_EXPERIMENT_CONTEXT_KEY = "research-map-active-experiment-context";
const BOOT_LOADER_MIN_MS = 5000;
const BOOT_STATUSES = [
    "בודק הרשאות גישה...",
    "אוסף ניסויים שיש לך הרשאה אליהם...",
    "מכין חיפוש חכם..."
];

const bootStartedAt = Date.now();
let bootStatusIndex = 0;
let bootStatusTimer = null;
let bootRevealStarted = false;

const SOURCE_PRIORITY = {
    own: 4,
    shared: 3,
    admin: 2,
    public: 1
};

const SEARCH_FIELDS = [
    { key: "searchBlocks.value", label: "כל תוכן הניסוי", checked: true },
    { key: "experimentName", label: "שם הניסוי", checked: true },
    { key: "leadResearcher", label: "חוקר מוביל", checked: true },
    { key: "experimentSite", label: "אתר", checked: true },
    { key: "experimentYear", label: "שנה", checked: true },
    { key: "workPackage", label: "חבילת עבודה", checked: true },
    { key: "keywordsText", label: "מילות מפתח", checked: true },
    { key: "partnersText", label: "שותפים", checked: true },
    { key: "studyType", label: "סוג מחקר", checked: false }
];

const DIRECT_SEARCH_LABELS = {
    experimentName: "שם הניסוי",
    leadResearcher: "חוקר מוביל",
    experimentSite: "אתר",
    experimentYear: "שנה",
    workPackage: "חבילת עבודה",
    keywordsText: "מילות מפתח",
    partnersText: "שותפים",
    studyType: "סוג מחקר",
    "searchBlocks.value": "כל תוכן הניסוי"
};

const PATH_LABELS = {
    experimentName: "שם הניסוי",
    leadResearcher: "חוקר מוביל",
    partners: "שותפים",
    name: "שם",
    email: "אימייל",
    role: "תפקיד",
    experimentYear: "שנה",
    experimentMonth: "חודש",
    startDate: "תאריך התחלה",
    studyType: "סוג מחקר",
    workPackage: "חבילת עבודה",
    experimentSite: "אתר הניסוי",
    siteCoordinates: "קורדינטות",
    labCellNumber: "תא מעבדה",
    treatmentsCount: "מספר טיפולים",
    repetitionsCount: "מספר חזרות",
    independentVariables: "משתנים בלתי תלויים",
    dependentVariables: "משתנים תלויים",
    keywords: "מילות מפתח",
    events: "אירועים",
    date: "תאריך",
    description: "תיאור",
    fileName: "שם קובץ",
    researchMap: "מפת מחקר",
    cropDetails: "פרטי גידול",
    structureDetails: "מבנה",
    soilDetails: "קרקע",
    dripDetails: "מערכת טפטוף",
    irrigationData: "השקיה",
    fertilizationData: "דישון",
    climateData: "אקלים",
    agrotechnicsData: "אגרוטכניקה",
    plantProtectionData: "הגנת הצומח",
    growthData: "מדדי צימוח",
    yieldData: "יבול",
    data: "",
    sharedData: "נתונים משותפים",
    byTreatment: "לפי טיפול",
    treatmentName: "שם טיפול",
    cropType: "סוג גידול",
    variety: "זן",
    varieties: "זנים",
    varietyType: "סוג זן",
    nursery: "משתלה",
    notes: "הערות",
    plantingDate: "מועד שתילה",
    inoculationDate1: "מועד הדבקה 1",
    inoculationDate2: "מועד הדבקה 2",
    graftedPlant: "צמח מורכב",
    splitPlant: "צמח מפוצל",
    seedlingsCount: "כמות שתילים",
    plantingDensity: "עומד שתילה",
    potsCount: "מספר עציצים",
    seedlingsPerPot: "שתילים בעציץ",
    plantingStructure: "מבנה שתילה",
    experimentArea: "שטח הניסוי",
    preparationName: "שם הכנה"
};

const SEARCH_BLOCK_SKIP_KEYS = new Set([
    "fileUrl",
    "fileURL",
    "downloadURL",
    "filePath",
    "path",
    "url"
]);

let currentUser = null;
let userData = null;
let currentView = "all";
let isAdminUser = false;
let allExperiments = [];
let sharedOnlyExperiments = [];
let filteredExperiments = [];
let currentFuseResultsByKey = new Map();
let selectedExperiments = new Map();

document.addEventListener("DOMContentLoaded", () => {
    initEventListeners();
    initBootStatusRotator();
    renderSearchFieldCheckboxes();
    updateThresholdLabel();
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }

    currentUser = user;

    try {
        const isApproved = await verifyApprovedUser();
        if (!isApproved) return;

        await initServerTime(db, currentUser);
        setUserDisplayName();
        isAdminUser = await checkAndDisplayAdminMenu();
        await loadSmartSearchExperiments();
    } catch (error) {
        console.error("Smart search initialization failed:", error);
        showToast("שגיאה בטעינת עמוד השליפה החכמה", "error");
        hideLoading();
        showEmptyState();
    }
});

function initEventListeners() {
    const hamburgerBtn = document.getElementById("hamburger-btn");
    const sidebar = document.querySelector(".sidebar");
    const overlay = document.getElementById("sidebar-overlay");

    if (hamburgerBtn && sidebar) {
        hamburgerBtn.addEventListener("click", () => {
            sidebar.classList.toggle("open");
            if (overlay) overlay.classList.toggle("active");

            const icon = hamburgerBtn.querySelector("i");
            if (icon) {
                icon.classList.toggle("fa-bars");
                icon.classList.toggle("fa-times");
            }
        });
    }

    if (overlay) {
        overlay.addEventListener("click", () => {
            sidebar?.classList.remove("open");
            overlay.classList.remove("active");
            const icon = hamburgerBtn?.querySelector("i");
            if (icon) {
                icon.classList.add("fa-bars");
                icon.classList.remove("fa-times");
            }
        });
    }

    document.getElementById("btn-logout")?.addEventListener("click", handleLogout);

    document.querySelectorAll(".view-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            const nextView = tab.dataset.view || "all";
            if (nextView === currentView) return;
            currentView = nextView;
            setActiveTab();
            populateFilterOptions();
            applyFiltersAndSearch();
        });
    });

    document.getElementById("smart-search-input")?.addEventListener("input", () => {
        updateClearButtonVisibility();
        applyFiltersAndSearch();
    });

    document.getElementById("btn-clear-search")?.addEventListener("click", () => {
        const input = document.getElementById("smart-search-input");
        if (input) input.value = "";
        updateClearButtonVisibility();
        applyFiltersAndSearch();
    });

    ["filter-year", "filter-work-package", "filter-researcher"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", applyFiltersAndSearch);
    });

    document.getElementById("btn-reset-filters")?.addEventListener("click", () => {
        setSelectValue("filter-year", "");
        setSelectValue("filter-work-package", "");
        setSelectValue("filter-researcher", "");
        applyFiltersAndSearch();
    });

    document.getElementById("fuse-options-toggle")?.addEventListener("click", () => {
        document.getElementById("fuse-options-panel")?.classList.toggle("open");
        document.getElementById("fuse-options-toggle")?.classList.toggle("expanded");
    });

    document.getElementById("fuse-threshold")?.addEventListener("input", () => {
        updateThresholdLabel();
        applyFiltersAndSearch();
    });

    document.querySelectorAll('input[name="logical-mode"]').forEach((radio) => {
        radio.addEventListener("change", () => {
            updateLogicalModeLabels();
            applyFiltersAndSearch();
        });
    });

    // Selection controls
    document.getElementById("select-all-checkbox")?.addEventListener("change", toggleSelectAll);
    document.getElementById("btn-clear-selection")?.addEventListener("click", clearSelection);
    document.getElementById("btn-prepare-export")?.addEventListener("click", showExportSummaryModal);
    document.getElementById("btn-modal-back")?.addEventListener("click", hideExportModal);
    document.getElementById("btn-modal-confirm")?.addEventListener("click", proceedToSmartExport);

    // Close modal on overlay click
    document.getElementById("export-modal-overlay")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) hideExportModal();
    });
}

function initBootStatusRotator() {
    const wrapper = document.getElementById("status-wrapper");
    const statusElement = document.getElementById("dynamic-status");
    if (!wrapper || !statusElement) return;

    statusElement.textContent = BOOT_STATUSES[0];

    bootStatusTimer = window.setInterval(() => {
        wrapper.classList.add("exit");

        window.setTimeout(() => {
            bootStatusIndex = (bootStatusIndex + 1) % BOOT_STATUSES.length;
            statusElement.textContent = BOOT_STATUSES[bootStatusIndex];
            wrapper.classList.remove("exit");
            wrapper.classList.add("enter");

            window.setTimeout(() => {
                wrapper.classList.remove("enter");
            }, 450);
        }, 300);
    }, 2000);
}

function revealSmartSearchWhenReady() {
    if (bootRevealStarted) return;
    bootRevealStarted = true;

    const elapsed = Date.now() - bootStartedAt;
    const remaining = Math.max(0, BOOT_LOADER_MIN_MS - elapsed);

    window.setTimeout(() => {
        if (bootStatusTimer) {
            window.clearInterval(bootStatusTimer);
            bootStatusTimer = null;
        }

        document.body.classList.remove("smart-search-booting");
        document.body.classList.add("smart-search-ready");
    }, remaining);
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
    const displayName = document.getElementById("user-display-name");
    if (!displayName) return;

    const fullName = `${userData?.firstName || ""} ${userData?.lastName || ""}`.trim();
    displayName.textContent = fullName || currentUser.email || "משתמש";
}

async function checkAndDisplayAdminMenu() {
    try {
        const usersQuery = query(collection(db, "users"), limit(2));
        const snapshot = await getDocs(usersQuery);

        if (snapshot.size > 1) {
            displayAdminMenu();
            return true;
        }
    } catch (_) {
        return false;
    }

    return false;
}

function displayAdminMenu() {
    const sidebar = document.querySelector(".sidebar-nav");
    if (!sidebar || sidebar.querySelector('a[href="admin-users.html"]')) return;

    sidebar.insertAdjacentHTML("beforeend", `
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
        <a href="bi.html" class="nav-item">
            <i class="fas fa-chart-bar"></i>
            <span>לוח BI</span>
        </a>
    `);
}

async function loadSmartSearchExperiments() {
    showLoading();

    try {
        const sharedExperiments = await fetchSharedExperiments();
        const sharedKeys = new Set(sharedExperiments.map((exp) => getExperimentKey(exp.ownerUid, exp.id)));
        const loadedExperiments = [...sharedExperiments];

        if (isAdminUser) {
            loadedExperiments.push(...await fetchAdminExperiments(sharedKeys));
        } else {
            loadedExperiments.push(...await fetchOwnExperiments());
            loadedExperiments.push(...await fetchPublicExperiments(sharedKeys));
        }

        allExperiments = dedupeExperiments(loadedExperiments);
        sharedOnlyExperiments = allExperiments.filter((exp) => exp.source === "shared");

        updateTabCounts();
        populateFilterOptions();
        applyFiltersAndSearch();
    } catch (error) {
        console.error("Error loading smart search experiments:", error);
        showToast("שגיאה בטעינת הניסויים", "error");
        showEmptyState();
    } finally {
        hideLoading();
        revealSmartSearchWhenReady();
    }
}

async function fetchOwnExperiments() {
    const ownSnap = await getDocs(collection(db, "users", currentUser.uid, "experiments"));

    return ownSnap.docs.map((docSnap) => normalizeExperiment({
        id: docSnap.id,
        ownerUid: currentUser.uid,
        data: docSnap.data(),
        source: "own"
    }));
}

async function fetchSharedExperiments() {
    const sharedSnap = await getDocs(collection(db, "users", currentUser.uid, "sharedExperiments"));

    const results = await Promise.all(sharedSnap.docs.map(async (sharedDoc) => {
        const sharedData = sharedDoc.data();
        const ownerUid = sharedData.ownerUid;
        const experimentId = sharedData.experimentId || sharedDoc.id;

        if (!ownerUid || !experimentId) return null;

        if (sharedData.cachedExperiment && typeof sharedData.cachedExperiment === "object") {
            return normalizeExperiment({
                id: experimentId,
                ownerUid,
                data: sharedData.cachedExperiment,
                source: "shared"
            });
        }

        try {
            const originalSnap = await getDoc(doc(db, "users", ownerUid, "experiments", experimentId));
            if (!originalSnap.exists()) return null;

            return normalizeExperiment({
                id: experimentId,
                ownerUid,
                data: originalSnap.data(),
                source: "shared"
            });
        } catch (error) {
            console.warn("Could not load shared experiment", experimentId, error);
            return null;
        }
    }));

    return results.filter(Boolean);
}

async function fetchPublicExperiments(sharedKeys) {
    const publicQuery = query(
        collectionGroup(db, "experiments"),
        where("visibility", "==", "public")
    );
    const publicSnap = await getDocs(publicQuery);

    return publicSnap.docs
        .map((docSnap) => {
            const ownerUid = getOwnerUidFromExperimentPath(docSnap.ref.path);
            if (!ownerUid || ownerUid === currentUser.uid) return null;

            const key = getExperimentKey(ownerUid, docSnap.id);
            if (sharedKeys.has(key)) return null;

            return normalizeExperiment({
                id: docSnap.id,
                ownerUid,
                data: docSnap.data(),
                source: "public"
            });
        })
        .filter(Boolean);
}

async function fetchAdminExperiments(sharedKeys) {
    const allSnap = await getDocs(collectionGroup(db, "experiments"));

    return allSnap.docs
        .map((docSnap) => {
            const ownerUid = getOwnerUidFromExperimentPath(docSnap.ref.path);
            if (!ownerUid) return null;

            let source = "admin";
            const key = getExperimentKey(ownerUid, docSnap.id);
            const data = docSnap.data();

            if (ownerUid === currentUser.uid) {
                source = "own";
            } else if (sharedKeys.has(key)) {
                source = "shared";
            } else if (data.visibility === "public") {
                source = "public";
            }

            return normalizeExperiment({
                id: docSnap.id,
                ownerUid,
                data,
                source
            });
        })
        .filter(Boolean);
}

function dedupeExperiments(experiments) {
    const byKey = new Map();

    experiments.forEach((experiment) => {
        const key = getExperimentKey(experiment.ownerUid, experiment.id);
        const existing = byKey.get(key);
        if (!existing || SOURCE_PRIORITY[experiment.source] > SOURCE_PRIORITY[existing.source]) {
            byKey.set(key, experiment);
        }
    });

    return Array.from(byKey.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function normalizeExperiment({ id, ownerUid, data, source }) {
    const safeData = data || {};
    const partners = Array.isArray(safeData.partners) ? safeData.partners : [];
    const keywords = Array.isArray(safeData.keywords) ? safeData.keywords : [];

    const normalized = {
        id,
        ownerUid,
        source,
        data: safeData,
        experimentName: stringValue(safeData.experimentName),
        leadResearcher: stringValue(safeData.leadResearcher),
        experimentSite: stringValue(safeData.experimentSite || safeData.labCellNumber),
        experimentYear: stringValue(safeData.experimentYear),
        workPackage: stringValue(safeData.workPackage),
        studyType: getStudyTypeLabel(safeData.studyType),
        keywordsText: keywords.map(stringValue).filter(Boolean).join(" "),
        partnersText: partners.map(formatPartnerForSearch).filter(Boolean).join(" "),
        createdAtMs: timestampToDate(safeData.createdAt)?.getTime() || 0
    };

    normalized.searchBlocks = buildSearchBlocks(safeData);
    normalized.fullText = normalized.searchBlocks.map((block) => block.value).join(" ");
    normalized.searchKey = getExperimentKey(ownerUid, id);

    return normalized;
}

function renderSearchFieldCheckboxes() {
    const grid = document.getElementById("search-fields-grid");
    if (!grid) return;

    grid.innerHTML = SEARCH_FIELDS.map((field) => `
        <label class="search-field-check ${field.checked ? "checked" : ""}">
            <input type="checkbox" value="${field.key}" ${field.checked ? "checked" : ""}>
            <span>${escapeHtml(field.label)}</span>
        </label>
    `).join("");

    grid.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
            checkbox.closest(".search-field-check")?.classList.toggle("checked", checkbox.checked);
            applyFiltersAndSearch();
        });
    });
}

function populateFilterOptions() {
    const base = getCurrentViewExperiments();

    populateSelect("filter-year", uniqueSortedValues(base, "experimentYear", true));
    populateSelect("filter-work-package", uniqueSortedValues(base, "workPackage"));
    populateSelect("filter-researcher", uniqueSortedValues(base, "leadResearcher"));
}

function populateSelect(id, values) {
    const select = document.getElementById(id);
    if (!select) return;

    const previousValue = select.value;
    select.innerHTML = '<option value="">הכל</option>';

    values.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    });

    select.value = values.includes(previousValue) ? previousValue : "";
}

function applyFiltersAndSearch() {
    const base = getCurrentViewExperiments();
    const year = document.getElementById("filter-year")?.value || "";
    const workPackage = document.getElementById("filter-work-package")?.value || "";
    const researcher = document.getElementById("filter-researcher")?.value || "";

    const filtered = base.filter((experiment) => {
        return (!year || experiment.experimentYear === year)
            && (!workPackage || experiment.workPackage === workPackage)
            && (!researcher || experiment.leadResearcher === researcher);
    });

    filteredExperiments = runFuseSearch(filtered);
    renderResults();
}

function runFuseSearch(experiments) {
    currentFuseResultsByKey = new Map();

    const searchInput = document.getElementById("smart-search-input");
    const searchTerm = searchInput?.value.trim() || "";
    if (!searchTerm) {
        return experiments;
    }

    const FuseCtor = window.Fuse;
    if (!FuseCtor) {
        console.warn("Fuse.js is not available");
        return experiments;
    }

    const selectedFields = getSelectedSearchFields();
    if (selectedFields.length === 0) {
        selectFallbackSearchField();
        showToast("יש לבחור לפחות שדה אחד לחיפוש", "warning");
        return runFuseSearch(experiments);
    }

    const fuse = new FuseCtor(experiments, {
        keys: selectedFields,
        includeScore: true,
        includeMatches: true,
        ignoreLocation: true,
        threshold: getFuseThreshold(),
        minMatchCharLength: 1
    });

    const words = splitSearchTerms(searchTerm);
    const logicalMode = document.querySelector('input[name="logical-mode"]:checked')?.value || "and";
    const queryExpression = buildLogicalQuery(words, selectedFields, logicalMode);
    const results = fuse.search(queryExpression);

    results.forEach((result) => {
        currentFuseResultsByKey.set(result.item.searchKey, result);
    });

    return results.map((result) => result.item);
}

function buildLogicalQuery(words, selectedFields, logicalMode) {
    const clauses = words.map((word) => {
        const fieldClauses = selectedFields.map((fieldKey) => ({ [fieldKey]: word }));
        return fieldClauses.length === 1 ? fieldClauses[0] : { $or: fieldClauses };
    });

    if (clauses.length === 1) return clauses[0];
    return logicalMode === "or" ? { $or: clauses } : { $and: clauses };
}

function renderResults() {
    const tbody = document.getElementById("results-table-body");
    if (!tbody) return;

    updateResultsStats();

    if (filteredExperiments.length === 0) {
        document.getElementById("results-table-wrapper").style.display = "none";
        showEmptyState();
        tbody.innerHTML = "";
        return;
    }

    document.getElementById("empty-state").style.display = "none";
    document.getElementById("results-table-wrapper").style.display = "block";

    const searchWords = splitSearchTerms(document.getElementById("smart-search-input")?.value || "");

    tbody.innerHTML = filteredExperiments.map((experiment) => {
        const fuseResult = currentFuseResultsByKey.get(experiment.searchKey);
        const score = fuseResult?.score;
        const matchToggle = renderMatchInsights(experiment, fuseResult, searchWords);
        const matchDetailsRow = renderMatchDetailsRow(experiment, fuseResult, searchWords);
        const expKey = getExperimentKey(experiment.ownerUid, experiment.id);
        const isSelected = selectedExperiments.has(expKey);

        return `
            <tr class="result-row${isSelected ? ' selected-row' : ''}" data-experiment-id="${escapeHtml(experiment.id)}" data-owner-uid="${escapeHtml(experiment.ownerUid)}" data-exp-key="${escapeHtml(expKey)}">
                <td class="td-checkbox">
                    <input type="checkbox" class="exp-checkbox" data-exp-key="${escapeHtml(expKey)}" ${isSelected ? 'checked' : ''}>
                </td>
                <td data-label="שם הניסוי">
                    <strong>${highlightText(experiment.experimentName || "ניסוי ללא שם", searchWords)}</strong>
                    ${matchToggle}
                </td>
                <td data-label="חוקר מוביל">${highlightText(experiment.leadResearcher || "לא צוין", searchWords)}</td>
                <td data-label="אתר">${highlightText(experiment.experimentSite || "לא צוין", searchWords)}</td>
                <td data-label="שנה">${highlightText(experiment.experimentYear || "-", searchWords)}</td>
                <td data-label="חבילת עבודה">${highlightText(experiment.workPackage || "-", searchWords)}</td>
                <td data-label="מקור">${renderSourceBadge(experiment.source)}</td>
                <td data-label="חשיפה">${renderVisibilityBadge(experiment.data)}</td>
                <td data-label="פעולות">
                    <button class="btn-view-exp" type="button" data-experiment-id="${escapeHtml(experiment.id)}" data-owner-uid="${escapeHtml(experiment.ownerUid)}">
                        <i class="fas fa-eye"></i>
                        צפייה
                    </button>
                </td>
            </tr>
            ${matchDetailsRow}
        `;
    }).join("");

    // Checkbox event listeners
    tbody.querySelectorAll(".exp-checkbox").forEach((checkbox) => {
        checkbox.addEventListener("change", (event) => {
            event.stopPropagation();
            const key = checkbox.dataset.expKey;
            toggleExperimentSelection(key);
            const row = checkbox.closest("tr.result-row");
            if (row) row.classList.toggle("selected-row", checkbox.checked);
            updateSelectAllState();
        });
    });

    tbody.querySelectorAll("tr.result-row").forEach((row) => {
        row.addEventListener("click", (event) => {
            if (event.target.closest(".btn-view-exp") || event.target.closest(".match-toggle-btn") || event.target.closest(".td-checkbox")) return;
            viewExperiment(row.dataset.experimentId, row.dataset.ownerUid);
        });
    });

    tbody.querySelectorAll(".match-toggle-btn").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            const targetId = button.dataset.target;
            const detailsRow = document.getElementById(targetId);
            if (!detailsRow) return;
            const isOpen = detailsRow.hidden;
            detailsRow.hidden = !isOpen;
            detailsRow.classList.toggle("open", isOpen);
            button.classList.toggle("open", isOpen);
            button.setAttribute("aria-expanded", String(isOpen));
        });
    });

    updateSelectionUI();
    updateSelectAllState();
}

function updateResultsStats() {
    const stats = document.getElementById("results-stats");
    if (stats) stats.style.display = "flex";

    setText("results-count", filteredExperiments.length);

    const searchTerm = document.getElementById("smart-search-input")?.value.trim() || "";
    const termDisplay = document.getElementById("search-term-display");
    if (termDisplay) {
        termDisplay.textContent = searchTerm ? ` עבור "${searchTerm}"` : "";
    }

    const ownCount = filteredExperiments.filter((exp) => exp.source === "own").length;
    const sharedCount = filteredExperiments.filter((exp) => exp.source === "shared").length;
    const publicCount = filteredExperiments.filter((exp) => exp.source === "public" || exp.source === "admin").length;

    updateStatBadge("stat-own", "stat-own-count", ownCount);
    updateStatBadge("stat-shared", "stat-shared-count", sharedCount);
    updateStatBadge("stat-public", "stat-public-count", publicCount);
}

function updateStatBadge(wrapperId, countId, count) {
    const wrapper = document.getElementById(wrapperId);
    setText(countId, count);
    if (wrapper) wrapper.style.display = count > 0 ? "inline-flex" : "none";
}

function renderSourceBadge(source) {
    const config = {
        own: { className: "own", icon: "fa-user-check", label: "שלי" },
        shared: { className: "shared", icon: "fa-users", label: "שותף/ה" },
        public: { className: "public-exp", icon: "fa-globe", label: "ציבורי" },
        admin: { className: "public-exp", icon: "fa-shield-halved", label: "ניהול" }
    }[source] || { className: "public-exp", icon: "fa-globe", label: "ציבורי" };

    return `
        <span class="source-badge ${config.className}">
            <i class="fas ${config.icon}"></i>
            ${config.label}
        </span>
    `;
}

function renderVisibilityBadge(data) {
    const isPrivate = data?.visibility === "private" && isPrivateStillActive(data.privateUntil);
    const className = isPrivate ? "private" : "public";
    const icon = isPrivate ? "fa-lock" : "fa-globe";
    const label = isPrivate ? "חסוי" : "חשוף";

    return `
        <span class="vis-badge ${className}">
            <i class="fas ${icon}"></i>
            ${label}
        </span>
    `;
}

function renderScore(score) {
    if (typeof score !== "number") {
        return '<span class="score-indicator"><span class="score-dot excellent"></span>מלאה</span>';
    }

    const percentage = Math.max(0, Math.min(100, Math.round((1 - score) * 100)));
    let level = "fair";
    if (score <= 0.25) level = "excellent";
    else if (score <= 0.55) level = "good";

    return `
        <span class="score-indicator">
            <span class="score-dot ${level}"></span>
            ${percentage}%
        </span>
    `;
}

function renderMatchInsights(experiment, fuseResult, searchWords) {
    if (!searchWords.length || !fuseResult?.matches?.length) return "";
    const insights = getMatchInsights(experiment, fuseResult);
    if (!insights.length) return "";
    const detailsRowId = getMatchDetailsRowId(experiment);
    const totalCount = insights.length;
    return `
        <div class="match-insights-wrapper">
            <button type="button" class="match-toggle-btn" data-target="${detailsRowId}" aria-expanded="false" aria-controls="${detailsRowId}">
                <i class="fas fa-location-dot"></i>
                <span>${totalCount} מקורות התאמה</span>
                <i class="fas fa-chevron-down match-toggle-chevron"></i>
            </button>
        </div>
    `;
}

function renderMatchDetailsRow(experiment, fuseResult, searchWords) {
    if (!searchWords.length || !fuseResult?.matches?.length) return "";

    const insights = getMatchInsights(experiment, fuseResult);
    if (!insights.length) return "";

    const detailsRowId = getMatchDetailsRowId(experiment);

    return `
        <tr class="match-details-row" id="${detailsRowId}" hidden>
            <td class="match-details-cell" colspan="10">
                <div class="match-details-list" role="region" aria-label="מקורות התאמה עבור ${escapeHtml(experiment.experimentName || 'ניסוי ללא שם')}">
                    ${insights.map((insight) => `
                        <div class="match-source-card">
                            <div class="match-source-icon" aria-hidden="true">
                                <i class="fas fa-location-dot"></i>
                            </div>
                            <div class="match-source-content">
                                <div class="match-source-label">נמצא ב: ${escapeHtml(insight.label)}</div>
                                <div class="match-source-snippet">${insight.snippet}</div>
                            </div>
                        </div>
                    `).join("")}
                </div>
            </td>
        </tr>
    `;
}

function getMatchDetailsRowId(experiment) {
    const rawKey = experiment.searchKey || `${experiment.ownerUid || ''}-${experiment.id || ''}`;
    const safeKey = String(rawKey).replace(/[^a-zA-Z0-9_-]/g, "-");
    return `match-details-${safeKey}`;
}

function getMatchInsights(experiment, fuseResult) {
    const insights = [];
    const seen = new Set();

    fuseResult.matches.forEach((match) => {
        const insight = buildInsightFromMatch(experiment, match);
        if (!insight) return;

        const dedupeKey = `${insight.label}:${stripHtml(insight.snippet)}`;
        if (seen.has(dedupeKey)) return;

        seen.add(dedupeKey);
        insights.push(insight);
    });

    return insights.sort((a, b) => b.specificity - a.specificity);
}

function buildInsightFromMatch(experiment, match) {
    const key = String(match.key || "");

    if (key === "searchBlocks.value") {
        const block = typeof match.refIndex === "number"
            ? experiment.searchBlocks?.[match.refIndex]
            : experiment.searchBlocks?.find((item) => item.value === match.value);
        if (!block?.value) return null;

        return {
            label: block.label || DIRECT_SEARCH_LABELS[key],
            snippet: renderIndexedSnippet(block.value, match.indices || []),
            specificity: 3
        };
    }

    const rawValue = match.value || experiment[key];
    if (!rawValue) return null;

    return {
        label: DIRECT_SEARCH_LABELS[key] || key,
        snippet: renderIndexedSnippet(rawValue, match.indices || []),
        specificity: key === "fullText" ? 1 : 2
    };
}

function renderIndexedSnippet(value, indices) {
    const text = stringValue(value).replace(/\s+/g, " ");
    if (!text) return "";

    if (!indices?.length) {
        return escapeHtml(text.length > 110 ? `${text.slice(0, 110)}...` : text);
    }

    const normalizedRanges = normalizeRanges(indices);
    if (!normalizedRanges.length) {
        return escapeHtml(text.length > 110 ? `${text.slice(0, 110)}...` : text);
    }

    const firstRange = normalizedRanges[0];
    const lastRange = normalizedRanges[Math.min(normalizedRanges.length - 1, 2)];
    const snippetStart = Math.max(0, firstRange[0] - 38);
    const snippetEnd = Math.min(text.length, lastRange[1] + 48);
    const snippet = text.slice(snippetStart, snippetEnd);
    const relativeRanges = normalizedRanges
        .map(([start, end]) => [
            Math.max(0, start - snippetStart),
            Math.min(snippet.length - 1, end - snippetStart)
        ])
        .filter(([start, end]) => start <= end);

    return `${snippetStart > 0 ? "..." : ""}${highlightByRanges(snippet, relativeRanges)}${snippetEnd < text.length ? "..." : ""}`;
}

function normalizeRanges(indices) {
    const sorted = indices
        .filter((range) => Array.isArray(range) && range.length === 2)
        .map(([start, end]) => [Number(start), Number(end)])
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start <= end)
        .sort((a, b) => a[0] - b[0]);

    return sorted.reduce((merged, range) => {
        const last = merged[merged.length - 1];
        if (!last || range[0] > last[1] + 1) {
            merged.push(range);
        } else {
            last[1] = Math.max(last[1], range[1]);
        }
        return merged;
    }, []);
}

function highlightByRanges(text, ranges) {
    if (!ranges.length) return escapeHtml(text);

    let html = "";
    let cursor = 0;

    ranges.forEach(([start, end]) => {
        if (start > cursor) html += escapeHtml(text.slice(cursor, start));
        html += `<mark class="fuse-highlight">${escapeHtml(text.slice(start, end + 1))}</mark>`;
        cursor = end + 1;
    });

    if (cursor < text.length) html += escapeHtml(text.slice(cursor));
    return html;
}

function viewExperiment(experimentId, ownerUid) {
    if (!experimentId) return;

    try {
        localStorage.setItem(
            ACTIVE_EXPERIMENT_CONTEXT_KEY,
            JSON.stringify({ experimentId, ownerUid: ownerUid || currentUser.uid })
        );
    } catch (error) {
        console.warn("Could not persist active experiment context", error);
    }

    if (!ownerUid || ownerUid === currentUser.uid) {
        window.location.href = `experiment.html?id=${encodeURIComponent(experimentId)}`;
        return;
    }

    window.location.href = `experiment.html?id=${encodeURIComponent(experimentId)}&owner=${encodeURIComponent(ownerUid)}`;
}

function getCurrentViewExperiments() {
    return currentView === "shared" ? sharedOnlyExperiments : allExperiments;
}

function setActiveTab() {
    document.querySelectorAll(".view-tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.view === currentView);
    });
}

function updateTabCounts() {
    setText("count-all", allExperiments.length);
    setText("count-shared", sharedOnlyExperiments.length);
}

function showLoading() {
    const loading = document.getElementById("loading-state");
    if (loading) loading.style.display = "flex";
    const table = document.getElementById("results-table-wrapper");
    if (table) table.style.display = "none";
    const empty = document.getElementById("empty-state");
    if (empty) empty.style.display = "none";
}

function hideLoading() {
    const loading = document.getElementById("loading-state");
    if (loading) loading.style.display = "none";
}

function showEmptyState() {
    const empty = document.getElementById("empty-state");
    if (empty) empty.style.display = "block";
}

function updateClearButtonVisibility() {
    const input = document.getElementById("smart-search-input");
    const button = document.getElementById("btn-clear-search");
    if (!button) return;
    button.classList.toggle("visible", Boolean(input?.value));
}

function updateThresholdLabel() {
    const range = document.getElementById("fuse-threshold");
    const label = document.getElementById("fuse-threshold-value");
    if (!range || !label) return;
    label.textContent = getFuseThreshold().toFixed(2).replace(/0$/, "");
}

function updateLogicalModeLabels() {
    // Function to update labels dynamically if needed in the future
    // Currently labels are static in HTML
}

function getFuseThreshold() {
    const value = Number(document.getElementById("fuse-threshold")?.value || 40);
    return Math.max(0, Math.min(1, value / 100));
}

function getSelectedSearchFields() {
    return Array.from(document.querySelectorAll('#search-fields-grid input[type="checkbox"]:checked'))
        .map((input) => input.value)
        .filter(Boolean);
}

function selectFallbackSearchField() {
    const checkbox = document.querySelector('#search-fields-grid input[value="searchBlocks.value"]');
    if (!checkbox) return;
    checkbox.checked = true;
    checkbox.closest(".search-field-check")?.classList.add("checked");
}

function splitSearchTerms(value) {
    return String(value || "")
        .trim()
        .split(/\s+/)
        .map((word) => word.trim())
        .filter(Boolean);
}

function highlightText(value, words) {
    const text = stringValue(value) || "";
    if (!words.length) return escapeHtml(text);

    const escapedWords = words
        .map(escapeRegExp)
        .filter(Boolean);
    if (!escapedWords.length) return escapeHtml(text);

    const pattern = new RegExp(`(${escapedWords.join("|")})`, "gi");
    return escapeHtml(text).replace(pattern, '<mark class="fuse-highlight">$1</mark>');
}

function uniqueSortedValues(items, key, numericDesc = false) {
    const values = Array.from(new Set(items.map((item) => item[key]).filter(Boolean)));
    return values.sort((a, b) => {
        if (numericDesc) return Number(b) - Number(a);
        return a.localeCompare(b, "he");
    });
}

function buildSearchBlocks(value, path = [], seen = new WeakSet()) {
    if (value === null || value === undefined) return [];

    if (isPrimitiveSearchValue(value) || isTimestampLike(value)) {
        const displayValue = formatSearchValue(value);
        if (!displayValue || path.length === 0) return [];

        return [{
            path: path.join("."),
            label: buildPathLabel(path),
            value: displayValue
        }];
    }

    if (Array.isArray(value)) {
        if (value.every((item) => isPrimitiveSearchValue(item) || isTimestampLike(item))) {
            const displayValue = value.map(formatSearchValue).filter(Boolean).join(", ");
            if (!displayValue || path.length === 0) return [];

            return [{
                path: path.join("."),
                label: buildPathLabel(path),
                value: displayValue
            }];
        }

        return value.flatMap((item, index) => buildSearchBlocks(item, path.concat(`[${index + 1}]`), seen));
    }

    if (typeof value === "object") {
        if (seen.has(value)) return [];
        seen.add(value);

        return Object.entries(value).flatMap(([key, item]) => {
            if (SEARCH_BLOCK_SKIP_KEYS.has(key) || /url|downloadURL|filePath/i.test(key)) return [];
            return buildSearchBlocks(item, path.concat(key), seen);
        });
    }

    return [];
}

function isPrimitiveSearchValue(value) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function formatSearchValue(value) {
    if (value === null || value === undefined) return "";

    if (isTimestampLike(value)) {
        const date = timestampToDate(value);
        return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString("he-IL") : "";
    }

    if (typeof value === "boolean") return value ? "כן" : "לא";
    return stringValue(value);
}

function buildPathLabel(path) {
    const labels = path.map((segment, index) => {
        const arrayMatch = String(segment).match(/^\[(\d+)\]$/);
        if (arrayMatch) {
            const previous = path[index - 1];
            return previous === "byTreatment" ? `טיפול ${arrayMatch[1]}` : `פריט ${arrayMatch[1]}`;
        }

        if (PATH_LABELS[segment] !== undefined) return PATH_LABELS[segment];
        return formatUnknownFieldLabel(segment);
    }).filter(Boolean);

    return labels.filter((label, index) => label !== labels[index - 1]).join(" > ");
}

function formatUnknownFieldLabel(key) {
    return stringValue(key)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim();
}

function collectPrimitiveText(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return "";

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    const date = timestampToDate(value);
    if (date && !Number.isNaN(date.getTime()) && isTimestampLike(value)) {
        return date.toLocaleDateString("he-IL");
    }

    if (Array.isArray(value)) {
        return value.map((item) => collectPrimitiveText(item, seen)).filter(Boolean).join(" ");
    }

    if (typeof value === "object") {
        if (seen.has(value)) return "";
        seen.add(value);

        return Object.entries(value)
            .filter(([key]) => !/url|downloadURL|filePath/i.test(key))
            .map(([, item]) => collectPrimitiveText(item, seen))
            .filter(Boolean)
            .join(" ");
    }

    return "";
}

function isTimestampLike(value) {
    return Boolean(value && typeof value === "object" && (
        typeof value.toDate === "function"
        || typeof value.seconds === "number"
        || value instanceof Date
    ));
}

function formatPartnerForSearch(partner) {
    if (!partner || typeof partner !== "object") return stringValue(partner);
    return [partner.name, partner.email, partner.role].map(stringValue).filter(Boolean).join(" ");
}

function getStudyTypeLabel(value) {
    if (value === "field") return "שדה";
    if (value === "lab") return "מעבדה";
    return stringValue(value);
}

function isPrivateStillActive(privateUntil) {
    const until = timestampToDate(privateUntil);
    return Boolean(until && until > getTrustedNow());
}

function getOwnerUidFromExperimentPath(path) {
    const parts = String(path || "").split("/");
    const usersIndex = parts.indexOf("users");
    if (usersIndex === -1) return "";
    return parts[usersIndex + 1] || "";
}

function getExperimentKey(ownerUid, experimentId) {
    return `${ownerUid || ""}:${experimentId || ""}`;
}

function setSelectValue(id, value) {
    const select = document.getElementById(id);
    if (select) select.value = value;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
}

function stringValue(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function escapeHtml(value) {
    return stringValue(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeRegExp(value) {
    return stringValue(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHtml(value) {
    return stringValue(value).replace(/<[^>]*>/g, "");
}

// ═══════════════════════════════════════
// Selection Management for Smart Export
// ═══════════════════════════════════════
const SMART_EXPORT_SESSION_KEY = 'smart-export-selections';

function toggleExperimentSelection(expKey) {
    if (selectedExperiments.has(expKey)) {
        selectedExperiments.delete(expKey);
    } else {
        const experiment = findExperimentByKey(expKey);
        if (experiment) {
            selectedExperiments.set(expKey, experiment);
        }
    }
    updateSelectionUI();
}

function toggleSelectAll() {
    const selectAllCheckbox = document.getElementById("select-all-checkbox");
    if (!selectAllCheckbox) return;

    if (selectAllCheckbox.checked) {
        filteredExperiments.forEach((exp) => {
            const key = getExperimentKey(exp.ownerUid, exp.id);
            selectedExperiments.set(key, exp);
        });
    } else {
        filteredExperiments.forEach((exp) => {
            const key = getExperimentKey(exp.ownerUid, exp.id);
            selectedExperiments.delete(key);
        });
    }
    updateSelectionUI();
    updateRowCheckboxes();
}

function clearSelection() {
    selectedExperiments.clear();
    updateSelectionUI();
    updateRowCheckboxes();
    const selectAllCheckbox = document.getElementById("select-all-checkbox");
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
}

function updateSelectionUI() {
    const bar = document.getElementById("selection-action-bar");
    const countEl = document.getElementById("selection-bar-count");
    const count = selectedExperiments.size;

    if (countEl) countEl.textContent = count;
    if (bar) bar.classList.toggle("visible", count > 0);
}

function updateRowCheckboxes() {
    document.querySelectorAll(".exp-checkbox").forEach((checkbox) => {
        const key = checkbox.dataset.expKey;
        const isSelected = selectedExperiments.has(key);
        checkbox.checked = isSelected;
        const row = checkbox.closest("tr.result-row");
        if (row) row.classList.toggle("selected-row", isSelected);
    });
    updateSelectAllState();
}

function updateSelectAllState() {
    const selectAllCheckbox = document.getElementById("select-all-checkbox");
    if (!selectAllCheckbox) return;

    const visibleCheckboxes = document.querySelectorAll(".exp-checkbox");
    const allChecked = visibleCheckboxes.length > 0 && Array.from(visibleCheckboxes).every((cb) => cb.checked);
    selectAllCheckbox.checked = allChecked;
}

function findExperimentByKey(key) {
    return allExperiments.find((exp) => getExperimentKey(exp.ownerUid, exp.id) === key) || null;
}

function showExportSummaryModal() {
    const overlay = document.getElementById("export-modal-overlay");
    if (overlay) {
        // Update the zip header label with the count of selected experiments
        const zipLabel = document.getElementById("modal-zip-name-label");
        if (zipLabel) {
            zipLabel.textContent = `שליפה_חכמה_חץ.zip (${selectedExperiments.size} ניסויים)`;
        }

        // Dynamically build the folder structure representing selected experiments inside the ZIP
        const foldersContainer = document.getElementById("modal-experiment-folders-list");
        if (foldersContainer) {
            const selectedList = Array.from(selectedExperiments.values());
            const visibleCount = 4;
            
            const usedNames = new Set();
            let html = "";
            selectedList.slice(0, visibleCount).forEach((exp) => {
                const rawName = exp.experimentName || exp.data?.experimentName || "ניסוי ללא שם";
                
                // Sanitize exactly as done in smart-export.js
                let sanitizedName = String(rawName).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').substring(0, 100);
                if (usedNames.has(sanitizedName)) {
                    let counter = 2;
                    let candidate = `${sanitizedName}_${counter}`;
                    while (usedNames.has(candidate)) {
                        counter++;
                        candidate = `${sanitizedName}_${counter}`;
                    }
                    sanitizedName = candidate;
                }
                usedNames.add(sanitizedName);
                
                html += `
                    <div class="explorer-item folder" title="${escapeHtml(rawName)}">
                        <i class="fas fa-folder"></i>
                        <span class="folder-name">${escapeHtml(sanitizedName)}/</span>
                    </div>
                `;
            });
            
            if (selectedList.length > visibleCount) {
                const remaining = selectedList.length - visibleCount;
                html += `
                    <div class="explorer-item folder-more" title="עוד ${remaining} תיקיות ניסויים">
                        <i class="fas fa-folder-plus"></i>
                        <span class="folder-name">עוד ${remaining} ניסויים...</span>
                    </div>
                `;
            }
            
            foldersContainer.innerHTML = html || `<div style="grid-column: 1 / -1; color: var(--neutral-400); font-size:12px; text-align:center; padding: 10px;">לא נבחרו ניסויים</div>`;
        }

        overlay.classList.add("visible");
    }
}

function hideExportModal() {
    const overlay = document.getElementById("export-modal-overlay");
    if (overlay) overlay.classList.remove("visible");
}

function proceedToSmartExport() {
    const selections = Array.from(selectedExperiments.values()).map((exp) => ({
        id: exp.id,
        ownerUid: exp.ownerUid,
        name: exp.experimentName || exp.data?.experimentName || '',
        researcher: exp.leadResearcher || exp.data?.leadResearcher || ''
    }));

    sessionStorage.setItem(SMART_EXPORT_SESSION_KEY, JSON.stringify(selections));
    window.location.href = 'smart-export.html';
}

async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Error signing out:", error);
        showToast("שגיאה בהתנתקות", "error");
    }
}