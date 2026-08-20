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
    limit,
    Timestamp,
    runTransaction,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    ref,
    uploadBytesResumable,
    getDownloadURL,
    deleteObject
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { showToast, showConfirmModal, showInfoModal, showThreeOptionModal } from "./toast.js";
import { initExperimentTour } from "./experiment-tour.js?v=20260818-1";
import { initServerTime, getTrustedNow } from "./server-time.js";
import { createExperimentAIIntegration } from "./experiment-ai-integration.js?v=20260818-1";
import {
    canRead,
    canEdit,
    canManage,
    getRole
} from "./permissions-utils.js";
import {
    MAX_LEAD_RESEARCHERS,
    normalizeExternalLeadResearchers,
    normalizeLeadResearchers
} from "./lead-researchers.js?v=20260818-1";

document.addEventListener('DOMContentLoaded', () => {
    initExperimentTour();
    initNetworkListeners();
});


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
let selectedLeadResearcher = null;
let experimentOwnerUid = null; // מזהה הבעלים של הניסוי (יכול להיות שונה מהמשתמש הנוכחי אם זה ניסוי משותף)
let permissionsState = {
    canRead: false,
    canEdit: false,
    canManage: false,
    role: 'none'
};
let isSharedExperiment = false; // האם זה ניסוי שאני שותף בו
let sharedSectionState = {};
let isSyncingSharedToggle = false;
let lastSavedFormSignature = '';
let scrollPersistTimeoutId = null;
let isNavigationStateReady = false;
let hasUserEditedSinceSave = false;
let isBrowserNavGuardInitialized = false;
let skipNextPopstateGuard = false;
let hasShownPrivacyFallbackToast = false;
let hasLoadedPublicUsers = false;
let experimentAI = null;
let unsubscribeExperimentSnapshot = null;
let lastRealtimeDataSignature = '';
let queuedRealtimeExperimentData = null;
let isRealtimeApplyQueuedAfterSave = false;

const PERMISSIONS_SCHEMA_VERSION = 2;

// =========================================
// Auto-Save State
// =========================================
const AUTO_SAVE_DELAY = 3000; // 3 seconds debounce
let autoSaveTimeoutId = null;
let autoSaveState = 'idle'; // 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' | 'offline'
let isAutoSaveEnabled = true;
let autoSaveInProgress = false;
let activeAutoSavePromise = null;
let autoSaveQueued = false;
let isNetworkOffline = !navigator.onLine;

const SHARED_VIEW_TO_SECTION = {
    crop: 'crop',
    structure: 'structure',
    soil: 'soil',
    drip: 'drip',
    irrigation: 'irrigation',
    growth: 'growth',
    climate: 'climate',
    agrotechnics: 'agrotechnics',
    'plant-protection': 'plantProtection',
    yield: 'yield'
};

const SHARED_SECTION_IDS = Object.values(SHARED_VIEW_TO_SECTION);

const SITE_PRESET_VALUES = ['volcani-bet-dagan', 'mop-darom', 'gilat'];
const STUDY_TYPES = ['field', 'lab'];
const DYNAMIC_FIELD_CONFIG = {
    experimentSiteOther: { datalistId: 'datalist-experiment-site-other' },
    cropType: { datalistId: 'datalist-crop-type' },
    variety: { datalistId: 'datalist-variety' },
    nursery: { datalistId: 'datalist-nursery' },
    substrateCompany: { datalistId: 'datalist-substrate-company' },
    substrateType: { datalistId: 'datalist-substrate-type' },
    soilDisinfectionMaterial: { datalistId: 'datalist-soil-disinfection-material' },
    fertilizerType: { datalistId: 'datalist-fertilizer-type' },
    fertilizerCompany: { datalistId: 'datalist-fertilizer-company' },
    plantProtectionMaterial: { datalistId: 'datalist-plant-protection-material' }
};
let dynamicFieldOptions = getDefaultDynamicFieldOptions();
const GLOBAL_KEYWORDS_DOC = ['appSettings', 'keywordOptions'];
const DEFAULT_GLOBAL_KEYWORDS = ['עגבניות', 'הדברה', 'חממה'];
let globalKeywordOptions = [...DEFAULT_GLOBAL_KEYWORDS];

function getExperimentDocumentPath() {
    if (!experimentOwnerUid || !currentExperimentId) return '';
    return `/users/${experimentOwnerUid}/experiments/${currentExperimentId}`;
}

function stripAccessManagedFields(formData) {
    [
        'visibility',
        'privateUntil',
        'publicAccess',
        'permissions',
        'permissionsSchemaVersion',
        'partners',
        'experimentPartners',
        'ownerUid',
        'privacyExtensionApproved',
        'privacyUpdatedAt',
        'privacyUpdatedBy',
        'permissionsUpdatedAt',
        'permissionsUpdatedBy'
    ].forEach((key) => {
        delete formData[key];
    });
    return formData;
}

function applyPublicPrivacyFallback(formData) {
    if (!formData) return formData;
    formData.visibility = 'public';
    formData.privateUntil = null;
    formData.publicAccess = { canRead: true, canWrite: false };
    return formData;
}

function prepareAccessManagedFieldsForSave(formData, options = {}) {
    const {
        includePermissions = false,
        allowPublicFallback = true
    } = options;
    let privacyFallbackApplied = false;

    if (!permissionsState?.canManage) {
        if (
            allowPublicFallback &&
            experimentData &&
            !isPrivacyDataValidForFirestoreUpdate(experimentData)
        ) {
            applyPublicPrivacyFallback(formData);
            privacyFallbackApplied = true;
        } else {
            stripAccessManagedFields(formData);
        }

        return { privacyFallbackApplied };
    }

    const existingPrivacyInvalid = experimentData && !isPrivacyDataValidForFirestoreUpdate(experimentData);

    if (
        allowPublicFallback &&
        existingPrivacyInvalid &&
        formData?.visibility === 'public'
    ) {
        applyPublicPrivacyFallback(formData);
        privacyFallbackApplied = true;
    } else if (allowPublicFallback && !isPrivacyDataSavable(formData)) {
        applyPublicPrivacyFallback(formData);
        privacyFallbackApplied = true;
    }

    if (includePermissions) {
        formData.permissions = collectPermissionsFromUI() || formData.permissions;
        synchronizePartnerFieldsForSave(formData);

        if (canSafelyUsePermissionsV2(experimentData, formData.permissions)) {
            formData.permissionsSchemaVersion = PERMISSIONS_SCHEMA_VERSION;
        } else {
            delete formData.permissionsSchemaVersion;
        }

        formData.permissionsUpdatedAt = serverTimestamp();
        formData.permissionsUpdatedBy = currentUser?.uid || null;
    }

    return { privacyFallbackApplied };
}

function syncPrivacyFallbackUIToPublic() {
    const publicRadio = document.getElementById('visibility-public');
    const privateRadio = document.getElementById('visibility-private');
    const privateUntilInput = document.getElementById('private-until-date');
    const legacyVisibilityInput = document.getElementById('experiment-visibility');
    const legacyPrivateUntilInput = document.getElementById('private-until-date-legacy');

    if (publicRadio) publicRadio.checked = true;
    if (privateRadio) privateRadio.checked = false;
    if (privateUntilInput) privateUntilInput.value = '';
    if (legacyVisibilityInput) legacyVisibilityInput.value = 'public';
    if (legacyPrivateUntilInput) legacyPrivateUntilInput.value = '';
    syncVisibilityPanels('public');
}

function notifyPrivacyFallbackToPublic() {
    if (hasShownPrivacyFallbackToast) return;
    hasShownPrivacyFallbackToast = true;
    showToast('לא ניתן לשמור את הניסוי כחסוי ללא תאריך סיום תקין ובטווח המותר. הניסוי הועבר לציבורי ושאר השינויים נשמרו.', 'warning', 7000);
}

function isAccessManagementField(target) {
    return Boolean(target?.closest?.('#permissions-section'));
}

function ignoreUnauthorizedAccessManagementChange(target, event = null) {
    if (permissionsState?.canManage || !isAccessManagementField(target)) return false;

    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    if (experimentData) {
        populatePermissionsUI(experimentData);
    }
    clearAllFieldDots();
    updateAutoSaveIndicator('idle');
    showToast('אין הרשאה לעדכון חשיפה והרשאות', 'warning');
    return true;
}

function getDefaultDynamicFieldOptions() {
    return Object.keys(DYNAMIC_FIELD_CONFIG).reduce((acc, key) => {
        acc[key] = [];
        return acc;
    }, {});
}

function normalizeDynamicValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function hasValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizeVarieties(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }
    const single = String(value || '').trim();
    return single ? [single] : [];
}

function getCropVarieties(crop = {}) {
    const fromArray = normalizeVarieties(crop.varieties);
    if (fromArray.length) return fromArray;
    return normalizeVarieties(crop.variety);
}

function getStructureModeForUI(mode) {
    if (mode === 'משתנה') return 'משתנה מבוקרת';
    return mode || '';
}

function getCurrentStudyType() {
    const value = document.getElementById('study-type')?.value;
    return STUDY_TYPES.includes(value) ? value : 'field';
}

function setStudyTypeValue(nextValue) {
    const input = document.getElementById('study-type');
    if (!input) return;
    input.value = STUDY_TYPES.includes(nextValue) ? nextValue : 'field';
    syncStudyTypeToggle();
}

function syncStudyTypeToggle() {
    const current = getCurrentStudyType();
    document.querySelectorAll('.study-type-option').forEach((button) => {
        const isActive = button.dataset.studyType === current;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    });
}

function deepClone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

const REALTIME_SIGNATURE_IGNORED_FIELDS = new Set([
    'updatedAt',
    'permissionsUpdatedAt',
    'privacyUpdatedAt'
]);

function normalizeRealtimeSignatureValue(value, key = '') {
    if (REALTIME_SIGNATURE_IGNORED_FIELDS.has(key)) return undefined;
    if (value === null || value === undefined) return value;

    if (typeof value?.toMillis === 'function') {
        return { __timestampMillis: value.toMillis() };
    }

    if (Array.isArray(value)) {
        return value.map((item) => normalizeRealtimeSignatureValue(item));
    }

    if (typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((normalized, childKey) => {
                const childValue = normalizeRealtimeSignatureValue(value[childKey], childKey);
                if (childValue !== undefined) normalized[childKey] = childValue;
                return normalized;
            }, {});
    }

    return value;
}

function getRealtimeDataSignature(data) {
    try {
        return JSON.stringify(normalizeRealtimeSignatureValue(data || {}));
    } catch (error) {
        console.warn('Could not serialize realtime experiment signature:', error);
        return '';
    }
}

function getTreatmentRepeatNumber(treatment, index = 0) {
    const fromLabel = String(treatment?.repeatLabel || '').trim();
    const labelMatch = fromLabel.match(/(\d+)/);
    if (labelMatch) {
        const fromRepeatLabel = parseInt(labelMatch[1]);
        if (Number.isFinite(fromRepeatLabel) && fromRepeatLabel > 0) return fromRepeatLabel;
    }

    const parsed = parseInt(treatment?.repeatNumber);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;

    const legacy = String(treatment?.pesticide || '').trim();
    const match = legacy.match(/(\d+)/);
    if (match) {
        const fromLegacy = parseInt(match[1]);
        if (Number.isFinite(fromLegacy) && fromLegacy > 0) return fromLegacy;
    }

    return index + 1;
}

function getTreatmentRepeatLabel(treatment, index = 0) {
    const explicitLabel = String(treatment?.repeatLabel || '').trim();
    if (explicitLabel) return explicitLabel;

    return `חזרה ${getTreatmentRepeatNumber(treatment, index)}`;
}

const MAX_REPETITIONS_PER_TREATMENT = 100;

function getCurrentRepetitionsCount() {
    const repetitionsInput = document.getElementById('repetitions-count');
    const fromInput = parseInt(document.getElementById('repetitions-count')?.value);
    if (Number.isFinite(fromInput) && fromInput > 0) {
        const clampedInput = Math.min(fromInput, MAX_REPETITIONS_PER_TREATMENT);
        if (repetitionsInput && String(clampedInput) !== String(repetitionsInput.value)) {
            repetitionsInput.value = String(clampedInput);
        }
        return clampedInput;
    }

    const fromData = parseInt(experimentData?.repetitionsCount);
    if (Number.isFinite(fromData) && fromData > 0) {
        return Math.min(fromData, MAX_REPETITIONS_PER_TREATMENT);
    }

    return 1;
}

function getTreatmentRepeatLabels(treatment, treatmentIndex = 0, repetitionsCount = getCurrentRepetitionsCount()) {
    const count = Math.min(MAX_REPETITIONS_PER_TREATMENT, Math.max(1, parseInt(repetitionsCount) || 0));
    const explicitLabels = Array.isArray(treatment?.repeatLabels) ? treatment.repeatLabels : [];
    const labels = [];

    for (let i = 0; i < count; i++) {
        const explicitLabel = String(explicitLabels[i] ?? '').trim();
        labels.push(explicitLabel || `חזרה ${i + 1}`);
    }

    if (!labels.length) {
        labels.push(getTreatmentRepeatLabel(treatment, treatmentIndex));
    }

    return labels;
}

function getYieldRepeatOptionsForTreatment(treatmentIndex = currentTreatmentIndex) {
    const treatments = Array.isArray(experimentData?.treatments) ? experimentData.treatments : [];
    const safeIndex = Number.isFinite(parseInt(treatmentIndex, 10)) ? parseInt(treatmentIndex, 10) : 0;
    const treatment = treatments[safeIndex] || treatments[0] || null;

    return normalizeUniqueValues(getTreatmentRepeatLabels(treatment, safeIndex, getCurrentRepetitionsCount()));
}

function collectTreatmentInputsFromDOM() {
    const treatments = [];

    document.querySelectorAll('.treatment-item').forEach((item) => {
        const index = parseInt(item.dataset.index);
        if (!Number.isFinite(index)) return;

        const nameInput = item.querySelector('.treatment-name');
        const repeatInputs = Array.from(item.querySelectorAll('.treatment-repeat'))
            .sort((a, b) => parseInt(a.dataset.repeatIndex) - parseInt(b.dataset.repeatIndex));

        const repeatLabels = repeatInputs.map((repeatInput, repeatIndex) => {
            const fallbackLabel = `חזרה ${repeatIndex + 1}`;
            return String(repeatInput?.value || '').trim() || fallbackLabel;
        });

        treatments[index] = {
            name: nameInput?.value || '',
            repeatLabels,
            repeatLabel: repeatLabels[0] || '',
            repeatNumber: repeatLabels.length || 1
        };
    });

    return treatments.filter(Boolean);
}

function normalizeYieldData(rawYieldData = {}) {
    return {
        measures: Array.isArray(rawYieldData?.measures) ? deepClone(rawYieldData.measures) : [],
        damages: Array.isArray(rawYieldData?.damages) ? deepClone(rawYieldData.damages) : []
    };
}

function normalizeYieldSectionEntry(entry = {}) {
    return {
        yieldData: normalizeYieldData(entry?.yieldData || entry)
    };
}

function getYieldDataForTreatment(data, treatmentIndex = 0) {
    const sectionYield = data?.sectionSharedState?.yield;
    if (sectionYield) {
        if (sectionYield.shared !== false) {
            return normalizeYieldData(
                sectionYield.sharedData?.yieldData ||
                sectionYield.data?.yieldData ||
                sectionYield.sharedData ||
                sectionYield.data ||
                {}
            );
        }
        const byTreatmentEntry = sectionYield.byTreatment?.[treatmentIndex] || sectionYield.byTreatment?.[0] || {};
        return normalizeYieldData(byTreatmentEntry?.yieldData || byTreatmentEntry);
    }

    const rootYield = data?.yieldData || {};
    if (Array.isArray(rootYield.byTreatment) && rootYield.byTreatment.length > 0) {
        const byTreatmentEntry = rootYield.byTreatment[treatmentIndex] || rootYield.byTreatment[0] || {};
        return normalizeYieldData(byTreatmentEntry?.yieldData || byTreatmentEntry);
    }

    return normalizeYieldData(rootYield);
}

function getComparableFormData(formData) {
    const comparable = deepClone(formData) || {};
    if (!permissionsState?.canManage) {
        if (experimentData && !isPrivacyDataValidForFirestoreUpdate(experimentData)) {
            applyPublicPrivacyFallback(comparable);
        } else {
            stripAccessManagedFields(comparable);
        }
    } else {
        stripUnsavablePrivacyFields(comparable);
    }
    delete comparable.updatedAt;
    return comparable;
}

function getFormSignatureFromData(formData) {
    try {
        return JSON.stringify(getComparableFormData(formData));
    } catch (error) {
        console.warn('Could not serialize form data signature:', error);
        return '';
    }
}

function getCurrentFormSignature() {
    return getFormSignatureFromData(collectFormData());
}

function setLastSavedFormSignatureFromCurrent() {
    lastSavedFormSignature = getCurrentFormSignature();
    hasUserEditedSinceSave = false;
}

function markUserEdited() {
    hasUserEditedSinceSave = true;
    experimentAI?.markViewDirty(currentView);
    scheduleAutoSave();
}

// =========================================
// Network Awareness for Auto-Save
// =========================================
function isNetworkError(error) {
    if (!error) return false;
    const code = error?.code || '';
    const message = (error?.message || '').toLowerCase();
    const networkCodes = ['unavailable', 'deadline-exceeded', 'cancelled', 'resource-exhausted'];
    if (networkCodes.includes(code)) return true;
    if (message.includes('network') || message.includes('failed to fetch') ||
        message.includes('offline') || message.includes('timeout') ||
        message.includes('err_internet_disconnected') || message.includes('err_network')) {
        return true;
    }
    return !navigator.onLine;
}

function initNetworkListeners() {
    window.addEventListener('offline', () => {
        isNetworkOffline = true;
        console.warn('Network: browser went offline');
        // If auto-save has pending changes, show offline indicator
        if (hasUserEditedSinceSave || autoSaveState === 'detecting' || autoSaveState === 'saving') {
            updateAutoSaveIndicator('offline');
        }
    });

    window.addEventListener('online', () => {
        isNetworkOffline = false;
        console.info('Network: browser came back online');
        // If we were showing offline state, try saving now
        if (autoSaveState === 'offline') {
            updateAutoSaveIndicator('detecting');
            showToast('החיבור חזר – שומר שינויים...', 'info', 3000);
            // Small delay to let the connection stabilize
            setTimeout(() => {
                if (hasUserEditedSinceSave || autoSaveQueued) {
                    performAutoSave();
                } else {
                    updateAutoSaveIndicator('idle');
                }
            }, 1500);
        }
    });
}

// =========================================
// Auto-Save Infrastructure
// =========================================
function scheduleAutoSave() {
    if (!isAutoSaveEnabled) return;
    if (!currentUser || !currentExperimentId || !experimentOwnerUid) return;
    if (!permissionsState?.canEdit) return;

    // If currently offline, show offline indicator and queue for when connection returns
    if (isNetworkOffline) {
        autoSaveQueued = true;
        updateAutoSaveIndicator('offline');
        return;
    }

    // If save is in progress, queue another save
    if (autoSaveInProgress) {
        autoSaveQueued = true;
        updateAutoSaveIndicator('detecting');
        return;
    }

    // Cancel previous pending auto-save
    if (autoSaveTimeoutId) {
        clearTimeout(autoSaveTimeoutId);
        autoSaveTimeoutId = null;
    }

    // Show "detecting changes" while debounce timer is running
    updateAutoSaveIndicator('detecting');

    autoSaveTimeoutId = setTimeout(() => {
        autoSaveTimeoutId = null;
        if (!autoSaveInProgress) performAutoSave();
    }, AUTO_SAVE_DELAY);
}

async function performAutoSave() {
    if (experimentAI?.isActive() || !isAutoSaveEnabled) return false;
    if (!currentUser || !currentExperimentId || !experimentOwnerUid) return false;
    if (!permissionsState?.canEdit) return false;

    // If save is already in progress, queue another save and return the active promise
    if (autoSaveInProgress) {
        autoSaveQueued = true;
        return activeAutoSavePromise || false;
    }

    // Cancel any pending scheduled auto-save
    if (autoSaveTimeoutId) {
        clearTimeout(autoSaveTimeoutId);
        autoSaveTimeoutId = null;
    }

    autoSaveInProgress = true;
    autoSaveQueued = false;
    updateAutoSaveIndicator('saving');

    let saveSucceeded = false;
    let saveFailed = false;

    activeAutoSavePromise = (async () => {
        try {
            const formData = collectFormData();
            // Skip validation for auto-save – just save the data as-is
            // Full validation only happens on explicit user actions

            // If the existing/requested privacy cannot pass Firestore rules, save
            // the experiment as public instead of letting a normal data edit fail.
            const { privacyFallbackApplied } = prepareAccessManagedFieldsForSave(formData, {
                includePermissions: permissionsState?.canManage
            });

            if (
                !privacyFallbackApplied &&
                lastSavedFormSignature &&
                getFormSignatureFromData(formData) === lastSavedFormSignature
            ) {
                hasUserEditedSinceSave = false;
                clearAllFieldDots();
                updateAutoSaveIndicator('idle');
                saveSucceeded = true;
                return true;
            }

            const experimentRef = doc(db, "users", experimentOwnerUid, "experiments", currentExperimentId);
            await updateDoc(experimentRef, formData);
            await persistDynamicFieldOptions(formData);
            await persistGlobalKeywordOptions(formData.keywords);

            // Sync dashboard pointers from the authoritative permissions map.
            await syncSharedExperiments(
                getPermissionShareEntries(formData, formData.permissions),
                formData
            );

            experimentData = { ...experimentData, ...formData };
            lastRealtimeDataSignature = getRealtimeDataSignature(experimentData);
            if (privacyFallbackApplied) {
                syncPrivacyFallbackUIToPublic();
                notifyPrivacyFallbackToPublic();
            }
            updateExperimentDisplayName();
            lastSavedFormSignature = getFormSignatureFromData(formData);
            hasUserEditedSinceSave = false;
            persistNavigationState();
            generateTreatmentTabs();
            
            // Clear any pending retry timer on success
            if (autoSaveRetryTimer) {
                clearTimeout(autoSaveRetryTimer);
                autoSaveRetryTimer = null;
            }
            // If we were in offline mode, successful save proves connectivity is back
            isNetworkOffline = false;
            
            updateAutoSaveIndicator('saved');
            saveSucceeded = true;
            return true;

        } catch (error) {
            console.error('Auto-save error:', error);
            saveFailed = true;

            if (error?.code === 'permission-denied') {
                if (autoSaveRetryTimer) {
                    clearTimeout(autoSaveRetryTimer);
                    autoSaveRetryTimer = null;
                }
                clearAllFieldDots();
                updateAutoSaveIndicator('idle');
                showToast('אין הרשאה לשמור את השינוי הזה', 'warning');
                return false;
            }

            // Classify as network error or generic error
            if (isNetworkError(error)) {
                isNetworkOffline = true;
                updateAutoSaveIndicator('offline');
                // The 'online' event listener will handle retry
                // Also set a fallback retry timer in case online event doesn't fire
                if (autoSaveRetryTimer) clearTimeout(autoSaveRetryTimer);
                autoSaveRetryTimer = setTimeout(() => {
                    autoSaveRetryTimer = null;
                    if (autoSaveState === 'offline' && navigator.onLine) {
                        isNetworkOffline = false;
                        performAutoSave();
                    }
                }, 30000);
                return false;
            }

            updateAutoSaveIndicator('error');
            showToast('שגיאה בשמירה אוטומטית. ינסה שוב בעוד 20 שניות.', 'error');
            // Retry automatically after 20s for non-network errors
            if (autoSaveRetryTimer) clearTimeout(autoSaveRetryTimer);
            autoSaveRetryTimer = setTimeout(() => {
                autoSaveRetryTimer = null;
                if (autoSaveState === 'error') {
                    performAutoSave();
                }
            }, 20000);
            return false;
        } finally {
            const hadQueuedSave = autoSaveQueued;

            autoSaveInProgress = false;
            activeAutoSavePromise = null;
            autoSaveQueued = false;

            // Only schedule another save if:
            // 1. Save succeeded AND there were changes during save
            // If save failed, let the 20s retry timer handle it
            if (saveSucceeded && hadQueuedSave) {
                scheduleAutoSave();
            }
        }
    })();

    return activeAutoSavePromise;
}

let autoSaveHideTimer = null;
let autoSaveRetryTimer = null;
// =========================================
// Field-level dot indicator
// =========================================
let lastEditedFieldGroup = null;

function trackFieldEdit(target) {
    if (!target) return;
    const group = target.closest('.form-group');
    if (!group) return;

    // Clear dot from previous field if different
    if (lastEditedFieldGroup && lastEditedFieldGroup !== group) {
        clearFieldDot(lastEditedFieldGroup);
    }

    lastEditedFieldGroup = group;
    setFieldDot(group, 'detecting');
}

function setFieldDot(group, state) {
    if (!group) return;
    const label = group.querySelector('label');
    if (!label) return;

    let dot = label.querySelector('.field-save-dot');
    if (!dot) {
        dot = document.createElement('span');
        dot.className = 'field-save-dot';
        // Insert as first child of label
        label.insertBefore(dot, label.firstChild);
    }

    dot.className = `field-save-dot ${state} visible`;
}

function clearFieldDot(group) {
    if (!group) return;
    const dot = group.querySelector('.field-save-dot');
    if (!dot) return;
    dot.classList.remove('visible');
    // Remove from DOM after transition
    setTimeout(() => dot.remove(), 250);
}

function clearAllFieldDots() {
    document.querySelectorAll('.field-save-dot').forEach(dot => {
        dot.classList.remove('visible');
        setTimeout(() => dot.remove(), 250);
    });
    lastEditedFieldGroup = null;
}
function updateAutoSaveIndicator(state) {
    autoSaveState = state;
    const indicator = document.getElementById('auto-save-indicator');
    if (!indicator) return;

    const iconEl = indicator.querySelector('.auto-save-icon');
    const textEl = indicator.querySelector('.auto-save-text');
    const retryBtn = document.getElementById('auto-save-retry-btn');
    if (!iconEl || !textEl) return;

    // Cancel any pending hide timer
    if (autoSaveHideTimer) {
        clearTimeout(autoSaveHideTimer);
        autoSaveHideTimer = null;
    }

    // Reset
    indicator.classList.remove('idle', 'detecting', 'saving', 'saved', 'error', 'offline', 'ai-review');
    indicator.style.opacity = '';
    if (retryBtn) retryBtn.style.display = 'none';

    switch (state) {
        case 'idle':
            indicator.classList.add('idle');
            iconEl.innerHTML = '';
            textEl.textContent = '';
            break;

        case 'ai-review':
            indicator.classList.add('ai-review');
            iconEl.innerHTML = '<i class="fas fa-shield-halved"></i>';
            textEl.textContent = 'מצב AI — שמירה אוטומטית כבויה';
            break;

        case 'detecting':
            indicator.classList.add('detecting');
            iconEl.innerHTML = '<i class="fas fa-cloud"></i>';
            textEl.textContent = 'מזהה שינויים...';
            break;

        case 'saving':
            indicator.classList.add('saving');
            iconEl.innerHTML = '<i class="fas fa-cloud"></i> <i class="fas fa-spinner fa-spin" style="font-size: 11px;"></i>';
            textEl.textContent = 'שומר...';
            // Dot turns blue + pulse while request is in flight
            if (lastEditedFieldGroup) {
                setFieldDot(lastEditedFieldGroup, 'saving');
            }
            break;

        case 'saved':
            indicator.classList.add('saved');
            iconEl.innerHTML = '<i class="fas fa-cloud"></i> <i class="fas fa-check" style="font-size: 11px;"></i>';
            textEl.textContent = 'נשמר בהצלחה';
            // Dot turns green briefly, then disappears
            if (lastEditedFieldGroup) {
                setFieldDot(lastEditedFieldGroup, 'saved');
            }
            autoSaveHideTimer = setTimeout(() => {
                autoSaveHideTimer = null;
                if (autoSaveState === 'saved') {
                    updateAutoSaveIndicator('idle');
                }
            }, 2000);
            // Clear dots after same 2s delay
            setTimeout(() => clearAllFieldDots(), 2000);
            break;

        case 'error':
            indicator.classList.add('error');
            iconEl.innerHTML = '<i class="fas fa-cloud"></i> <i class="fas fa-exclamation-triangle" style="font-size: 11px;"></i>';
            textEl.textContent = 'שגיאה בשמירה —';
            if (retryBtn) retryBtn.style.display = 'inline';
            // Dot turns red — stays until retry succeeds
            if (lastEditedFieldGroup) {
                setFieldDot(lastEditedFieldGroup, 'error');
            }
            break;

        case 'offline':
            indicator.classList.add('offline');
            iconEl.innerHTML = '<i class="fas fa-cloud"></i> <i class="fas fa-wifi" style="font-size: 11px; opacity: 0.5;"></i>';
            textEl.textContent = 'בעיית רשת — השאירו חלון פתוח, הנתונים יישמרו כשהחיבור יחזור';
            if (retryBtn) retryBtn.style.display = 'none';
            // Dot turns orange — stays until connectivity returns
            if (lastEditedFieldGroup) {
                setFieldDot(lastEditedFieldGroup, 'offline');
            }
            break;
    }
}

function performAutoSaveRetry() {
    if (autoSaveRetryTimer) {
        clearTimeout(autoSaveRetryTimer);
        autoSaveRetryTimer = null;
    }
    performAutoSave();
}

// Flush any pending auto-save immediately (used before navigation/exit)
async function flushAutoSave() {
    if (experimentAI?.isActive()) return true;
    if (autoSaveTimeoutId) {
        clearTimeout(autoSaveTimeoutId);
        autoSaveTimeoutId = null;
    }

    // Wait for active save to complete
    if (autoSaveInProgress && activeAutoSavePromise) {
        await activeAutoSavePromise;
    }

    // If there are unsaved changes, save them now
    if (hasUserEditedSinceSave || hasUnsavedChanges()) {
        return await performAutoSave();
    }

    return true;
}

function hasUnsavedChanges() {
    if (!hasUserEditedSinceSave) return false;
    if (!lastSavedFormSignature) return false;
    return getCurrentFormSignature() !== lastSavedFormSignature;
}

function getNavigationStateStorageKey() {
    if (!currentExperimentId || !experimentOwnerUid) return null;
    return `experiment-navigation-state:${experimentOwnerUid}:${currentExperimentId}`;
}

function isValidViewName(viewName) {
    if (!viewName) return false;
    return !!document.getElementById(`view-${viewName}`);
}

function persistNavigationState(force = false) {
    if (!isNavigationStateReady && !force) return;

    const key = getNavigationStateStorageKey();
    if (!key) return;

    const state = {
        view: currentView,
        treatmentIndex: currentTreatmentIndex,
        scrollY: window.scrollY || window.pageYOffset || 0,
        savedAt: Date.now()
    };

    try {
        sessionStorage.setItem(key, JSON.stringify(state));
    } catch (error) {
        console.warn('Could not persist experiment navigation state:', error);
    }
}

function schedulePersistNavigationState() {
    if (scrollPersistTimeoutId) {
        clearTimeout(scrollPersistTimeoutId);
    }
    scrollPersistTimeoutId = setTimeout(() => {
        persistNavigationState();
        scrollPersistTimeoutId = null;
    }, 120);
}

function getSavedNavigationState() {
    const key = getNavigationStateStorageKey();
    if (!key) return null;

    try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.warn('Could not read experiment navigation state:', error);
        return null;
    }
}

function closeMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const hamburgerBtn = document.getElementById('hamburger-btn');

    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');

    const icon = hamburgerBtn?.querySelector('i');
    if (icon) {
        icon.classList.add('fa-bars');
        icon.classList.remove('fa-times');
    }
}

function restoreNavigationState(preferredSection = '') {
    const safePreferredSection = isValidViewName(preferredSection) ? preferredSection : '';
    const saved = getSavedNavigationState();
    const savedView = isValidViewName(saved?.view) ? saved.view : '';
    const targetView = safePreferredSection || savedView;

    if (targetView && targetView !== currentView) {
        switchView(targetView);
    }

    const shouldApplySavedPosition = !!saved && (!safePreferredSection || saved?.view === safePreferredSection);
    if (shouldApplySavedPosition) {
        const treatmentIndex = Number(saved?.treatmentIndex);
        const count = getCurrentTreatmentsCount();

        if (Number.isInteger(treatmentIndex) && treatmentIndex >= 0 && treatmentIndex < count && treatmentIndex !== currentTreatmentIndex) {
            switchTreatmentTab(treatmentIndex);
        }

        const scrollY = Number(saved?.scrollY);
        if (Number.isFinite(scrollY) && scrollY >= 0) {
            setTimeout(() => window.scrollTo(0, scrollY), 0);
        }
    }

    persistNavigationState(true);
}

async function requestViewSwitch(viewName) {
    if (!viewName) return;

    if (viewName === currentView) {
        closeMobileSidebar();
        return;
    }

    // Auto-save: flush pending changes silently before switching views
    await flushAutoSave();

    switchView(viewName);
    closeMobileSidebar();
}

async function confirmUnsavedChangesBeforeAction(
    message = 'נשמר אוטומטית...'
) {
    // With auto-save, just flush any pending changes and proceed
    await flushAutoSave();
    return true;
}

function pushBrowserNavGuardBufferState() {
    const state = window.history.state || {};
    if (state.__experimentNavGuardBuffer === true) return;

    const bufferState = {
        ...state,
        __experimentNavGuardRoot: true,
        __experimentNavGuardBuffer: true
    };

    window.history.pushState(bufferState, '', window.location.href);
}

function initBrowserNavigationGuard() {
    if (isBrowserNavGuardInitialized) return;
    isBrowserNavGuardInitialized = true;

    const currentState = window.history.state || {};
    if (currentState.__experimentNavGuardRoot !== true) {
        window.history.replaceState({ ...currentState, __experimentNavGuardRoot: true }, '', window.location.href);
    }

    pushBrowserNavGuardBufferState();

    window.addEventListener('popstate', async () => {
        if (skipNextPopstateGuard) {
            skipNextPopstateGuard = false;
            return;
        }

        // Auto-save: flush changes and allow navigation
        await flushAutoSave();
        skipNextPopstateGuard = true;
        window.history.back();
    });
}

async function confirmDeferredDeletion(itemLabel) {
    const confirmed = await showConfirmModal({
        title: 'אישור מחיקה',
        message: `האם למחוק את ${itemLabel}?\nהמחיקה תישמר אוטומטית.`,
        confirmText: 'מחק/י',
        cancelText: 'ביטול',
        tone: 'warning'
    });

    if (confirmed) {
        markUserEdited();
    }

    return confirmed;
}

function confirmImmediateDeletion(itemLabel) {
    return showConfirmModal({
        title: 'אישור מחיקה מיידית',
        message: `האם את/ה בטוח/ה שברצונך למחוק את ${itemLabel}?`,
        confirmText: 'מחק/י עכשיו',
        cancelText: 'ביטול',
        tone: 'error'
    });
}

function alertDeferredChange(changeLabel) {
    // With auto-save, changes are saved automatically - just show a brief info
    showToast(`${changeLabel} – השינוי יישמר אוטומטית`, 'info');
    return Promise.resolve();
}

function getCurrentTreatmentsCount() {
    const fromInput = parseInt(document.getElementById('treatments-count')?.value);
    if (Number.isFinite(fromInput) && fromInput > 0) return fromInput;
    const fromData = parseInt(experimentData?.treatmentsCount);
    if (Number.isFinite(fromData) && fromData > 0) return fromData;
    return 1;
}

function getSectionIdByView(viewName = currentView) {
    return SHARED_VIEW_TO_SECTION[viewName] || null;
}

function getSectionModel(sectionId) {
    if (!sectionId) return null;
    if (!sharedSectionState[sectionId]) {
        sharedSectionState[sectionId] = {
            shared: true,
            sharedData: {},
            byTreatment: []
        };
    }
    return sharedSectionState[sectionId];
}

function ensureModelTreatmentLength(model, treatmentsCount = getCurrentTreatmentsCount()) {
    if (!model) return;
    if (!Array.isArray(model.byTreatment)) model.byTreatment = [];

    if (model.byTreatment.length > treatmentsCount) {
        model.byTreatment = model.byTreatment.slice(0, treatmentsCount);
    }

    while (model.byTreatment.length < treatmentsCount) {
        model.byTreatment.push(deepClone(model.sharedData || {}));
    }
}

function getSectionEffectiveData(sectionId, treatmentIndex = currentTreatmentIndex) {
    const model = getSectionModel(sectionId);
    if (!model) return {};

    ensureModelTreatmentLength(model);

    if (model.shared) {
        return deepClone(model.sharedData || {});
    }

    return deepClone(model.byTreatment[treatmentIndex] || {});
}

function setSectionCurrentData(sectionId, data, treatmentIndex = currentTreatmentIndex) {
    const model = getSectionModel(sectionId);
    if (!model) return;

    if (model.shared) {
        model.sharedData = deepClone(data || {});
        return;
    }

    ensureModelTreatmentLength(model);
    model.byTreatment[treatmentIndex] = deepClone(data || {});
}

function cloneSectionTreatment1ToAll(sectionId) {
    const model = getSectionModel(sectionId);
    if (!model) return;

    const treatmentsCount = getCurrentTreatmentsCount();
    const firstData = model.shared
        ? deepClone(model.sharedData || {})
        : deepClone(model.byTreatment[0] || model.sharedData || {});

    model.sharedData = deepClone(firstData || {});
    model.byTreatment = Array.from({ length: treatmentsCount }, () => deepClone(firstData || {}));
}

function createProgressDefaults() {
    return {
        irrigation: { irrigationData: [], fertilizationData: [] },
        growth: { growthData: [] },
        climate: { climateData: [] },
        agrotechnics: { agrotechnicsData: [], pollinationData: [] },
        plantProtection: {
            plantProtectionData: {
                pests: [],
                diseases: [],
                sprays: [],
                drenches: []
            }
        }
    };
}

function getLegacySectionDataFromExperiment(sectionId, data) {
    const progressDefaults = createProgressDefaults();

    switch (sectionId) {
        case 'crop':
            return deepClone(data?.cropDetails?.data || {});
        case 'structure':
            return deepClone(data?.structureDetails?.data || {});
        case 'soil':
            return deepClone(data?.soilDetails?.data || {});
        case 'drip':
            return deepClone(data?.dripDetails?.data || {});
        case 'irrigation':
            return {
                irrigationData: deepClone(data?.irrigationData || progressDefaults.irrigation.irrigationData),
                fertilizationData: deepClone(data?.fertilizationData || progressDefaults.irrigation.fertilizationData)
            };
        case 'growth':
            return {
                growthData: deepClone(data?.growthData || progressDefaults.growth.growthData)
            };
        case 'climate':
            return {
                climateData: deepClone(data?.climateData || progressDefaults.climate.climateData)
            };
        case 'agrotechnics':
            return {
                agrotechnicsData: deepClone(data?.agrotechnicsData || progressDefaults.agrotechnics.agrotechnicsData),
                pollinationData: deepClone(data?.pollinationData || progressDefaults.agrotechnics.pollinationData)
            };
        case 'plantProtection':
            return {
                plantProtectionData: deepClone(data?.plantProtectionData || progressDefaults.plantProtection.plantProtectionData)
            };
        case 'yield':
            return {
                yieldData: normalizeYieldData(data?.yieldData || {})
            };
        default:
            return {};
    }
}

function normalizeSectionModel(sectionId, data, treatmentsCount) {
    const sectionSharedState = data?.sectionSharedState?.[sectionId];
    const prepKeyMap = {
        crop: 'cropDetails',
        structure: 'structureDetails',
        soil: 'soilDetails',
        drip: 'dripDetails'
    };

    let shared = true;
    let sharedData = {};
    let byTreatment = [];

    if (sectionSharedState) {
        shared = sectionSharedState.shared !== false;
        sharedData = deepClone(sectionSharedState.sharedData || {});
        byTreatment = Array.isArray(sectionSharedState.byTreatment)
            ? deepClone(sectionSharedState.byTreatment)
            : [];
    } else if (prepKeyMap[sectionId]) {
        const block = data?.[prepKeyMap[sectionId]] || {};
        shared = block.shared !== false;
        sharedData = deepClone(block.sharedData || block.data || {});
        byTreatment = Array.isArray(block.byTreatment) ? deepClone(block.byTreatment) : [];
    } else if (sectionId === 'yield') {
        const legacyYield = data?.yieldData || {};
        shared = true;
        sharedData = { yieldData: normalizeYieldData(legacyYield) };
        byTreatment = [];

        if (Array.isArray(legacyYield.byTreatment) && legacyYield.byTreatment.length > 0) {
            shared = false;
            byTreatment = legacyYield.byTreatment.map((entry) => normalizeYieldSectionEntry(entry));
            sharedData = deepClone(byTreatment[0] || { yieldData: normalizeYieldData() });
        }
    } else {
        shared = true;
        sharedData = getLegacySectionDataFromExperiment(sectionId, data);
    }

    const model = { shared, sharedData: sharedData || {}, byTreatment: byTreatment || [] };
    ensureModelTreatmentLength(model, treatmentsCount);

    if (model.shared) {
        cloneSectionTreatment1ToAllTemp(model, treatmentsCount);
    }

    return model;
}

function cloneSectionTreatment1ToAllTemp(model, treatmentsCount = getCurrentTreatmentsCount()) {
    if (!model) return;
    const firstData = model.shared
        ? deepClone(model.sharedData || {})
        : deepClone(model.byTreatment[0] || model.sharedData || {});

    model.sharedData = deepClone(firstData || {});
    model.byTreatment = Array.from({ length: treatmentsCount }, () => deepClone(firstData || {}));
}

function initializeSharedSectionState() {
    const treatmentsCount = getCurrentTreatmentsCount();
    const data = experimentData || {};

    sharedSectionState = {};
    SHARED_SECTION_IDS.forEach((sectionId) => {
        sharedSectionState[sectionId] = normalizeSectionModel(sectionId, data, treatmentsCount);
    });
}

function syncAllSectionTreatmentCounts() {
    const treatmentsCount = getCurrentTreatmentsCount();
    SHARED_SECTION_IDS.forEach((sectionId) => {
        const model = getSectionModel(sectionId);
        ensureModelTreatmentLength(model, treatmentsCount);
        if (model.shared) {
            cloneSectionTreatment1ToAllTemp(model, treatmentsCount);
        }
    });
}

function normalizeUniqueValues(values) {
    const seen = new Set();
    const unique = [];
    (Array.isArray(values) ? values : []).forEach((value) => {
        const normalized = normalizeDynamicValue(value);
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(normalized);
    });
    return unique;
}

function setDatalistOptions(datalistId, options) {
    const datalist = document.getElementById(datalistId);
    if (!datalist) return;
    datalist.innerHTML = '';
    normalizeUniqueValues(options).forEach((value) => {
        const option = document.createElement('option');
        option.value = value;
        datalist.appendChild(option);
    });
}

function applyDynamicFieldOptionsToUI() {
    Object.entries(DYNAMIC_FIELD_CONFIG).forEach(([key, config]) => {
        setDatalistOptions(config.datalistId, dynamicFieldOptions[key]);
    });
}

function applyGlobalKeywordOptionsToUI() {
    setDatalistOptions('datalist-keywords', globalKeywordOptions);

    const legacySelect = document.getElementById('keywords-select');
    if (!legacySelect) return;

    const currentValue = legacySelect.value;
    legacySelect.innerHTML = '<option value="">בחירת מילת מפתח</option>';
    normalizeUniqueValues(globalKeywordOptions).forEach((value) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        legacySelect.appendChild(option);
    });
    legacySelect.insertAdjacentHTML('beforeend', '<option value="__custom__">אחר (הזנה חופשית)...</option>');
    legacySelect.value = currentValue;
}

function registerDynamicOption(fieldKey, value) {
    if (!DYNAMIC_FIELD_CONFIG[fieldKey]) return;
    const normalized = normalizeDynamicValue(value);
    if (!normalized) return;

    const existing = dynamicFieldOptions[fieldKey] || [];
    const hasValue = existing.some((item) => item.toLowerCase() === normalized.toLowerCase());
    if (hasValue) return;

    dynamicFieldOptions[fieldKey] = [...existing, normalized];
    setDatalistOptions(DYNAMIC_FIELD_CONFIG[fieldKey].datalistId, dynamicFieldOptions[fieldKey]);
}

function mergeDynamicFieldOptions(base, additions) {
    const merged = getDefaultDynamicFieldOptions();
    Object.keys(merged).forEach((key) => {
        merged[key] = normalizeUniqueValues([...(base[key] || []), ...(additions[key] || [])]);
    });
    return merged;
}

function createEmptyDynamicBucket() {
    return getDefaultDynamicFieldOptions();
}

function collectDynamicFieldValues(formData) {
    const collected = createEmptyDynamicBucket();

    if (formData?.experimentSiteSelection === 'other') {
        collected.experimentSiteOther.push(formData.experimentSiteOther || '');
    }

    const crop = formData?.cropDetails?.data || {};
    collected.cropType.push(crop.cropType || '');
    getCropVarieties(crop).forEach((item) => collected.variety.push(item));
    collected.nursery.push(crop.nursery || '');

    const soil = formData?.soilDetails?.data || {};
    collected.substrateCompany.push(soil.substrateCompany || '');
    collected.substrateType.push(soil.substrateType || '');
    (soil.disinfectRows || []).forEach((row) => {
        collected.soilDisinfectionMaterial.push(row?.material || '');
    });

    (formData?.fertilizationData || []).forEach((row) => {
        collected.fertilizerType.push(row?.fertType || '');
        collected.fertilizerCompany.push(row?.company || '');
    });

    const plantProtection = formData?.plantProtectionData || {};
    [...(plantProtection.sprays || []), ...(plantProtection.drenches || [])].forEach((row) => {
        collected.plantProtectionMaterial.push(row?.material || '');
    });

    Object.keys(collected).forEach((key) => {
        collected[key] = normalizeUniqueValues(collected[key]);
    });

    return collected;
}

async function loadDynamicFieldOptions() {
    if (!experimentOwnerUid) return;

    try {
        const optionsRef = doc(db, 'users', experimentOwnerUid, 'settings', 'experimentDynamicOptions');
        const optionsSnap = await getDoc(optionsRef);
        const base = getDefaultDynamicFieldOptions();

        if (optionsSnap.exists()) {
            const data = optionsSnap.data() || {};
            Object.keys(base).forEach((key) => {
                base[key] = normalizeUniqueValues(data[key]);
            });
        }

        dynamicFieldOptions = base;
        applyDynamicFieldOptionsToUI();
    } catch (error) {
        if (error?.code === 'permission-denied') {
            dynamicFieldOptions = getDefaultDynamicFieldOptions();
            applyDynamicFieldOptionsToUI();
            console.warn('Skipping dynamic field options load due to permissions (permission-denied).');
            return;
        }
        console.error('Error loading dynamic field options:', error);
    }
}

async function persistDynamicFieldOptions(formData) {
    if (!experimentOwnerUid) return;

    try {
        const additions = collectDynamicFieldValues(formData);
        const merged = mergeDynamicFieldOptions(dynamicFieldOptions, additions);
        const optionsRef = doc(db, 'users', experimentOwnerUid, 'settings', 'experimentDynamicOptions');

        await setDoc(optionsRef, merged, { merge: true });
        dynamicFieldOptions = merged;
        applyDynamicFieldOptionsToUI();
    } catch (error) {
        if (error?.code === 'permission-denied') {
            console.warn('Skipping dynamic field options persist due to permissions (permission-denied).');
            return;
        }
        console.error('Error persisting dynamic field options:', error);
    }
}

// =========================================
// Initialization
// =========================================
document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
});

window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        window.location.reload();
    }
});

window.addEventListener('pagehide', stopExperimentRealtimeListener);

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        stopExperimentRealtimeListener();
        window.location.href = "login.html";
        return;
    }

    currentUser = user;

    // בדיקת אישור משתמש לפני טעינת הניסוי
    const isApproved = await checkUserApproval();
    if (!isApproved) {
        return; // checkUserApproval מטפל בהודעה ובניתוב
    }

    // אתחול זמן שרת
    await initServerTime(db, currentUser);

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

    if (currentExperimentId && experimentOwnerUid) {
        try {
            localStorage.setItem(
                'research-map-active-experiment-context',
                JSON.stringify({ experimentId: currentExperimentId, ownerUid: experimentOwnerUid })
            );
        } catch (error) {
            console.warn('Could not persist research map experiment context', error);
        }
    }

    await loadDynamicFieldOptions();
    await loadGlobalKeywordOptions();

    if (currentExperimentId) {
        isNavigationStateReady = false;
        await loadExperiment();
        restoreNavigationState(section);
        isNavigationStateReady = true;
        persistNavigationState(true);
        if (experimentData) startExperimentRealtimeListener();
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
                window.location.href = "login.html";
                return false;
            }
        } else {
            // אין מסמך משתמש
            await signOut(auth);
            window.location.href = "login.html";
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
            <a href="researcher-activity.html" class="nav-item">
                <i class="fas fa-ranking-star"></i>
                <span>פעילות חוקרים</span>
            </a>
            <a href="bi.html" class="nav-item">
                <i class="fas fa-chart-bar"></i>
                <span>לוח BI מערכת</span>
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
        hasLoadedPublicUsers = true;
    } catch (error) {
        console.error("Error loading users:", error);

        // Check if it's a permission error
        if (error.code === 'permission-denied') {
            showToast('שגיאת הרשאות - לא ניתן לטעון רשימת משתמשים.', 'error', 5000);
        } else {
            showToast('שגיאה בטעינת רשימת משתמשים', 'error');
        }

        allUsers = []; // Empty array so the UI doesn't break
        hasLoadedPublicUsers = false;
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
function refreshPermissionsState() {
    try {
        const trustedNow = getTrustedNow();
        permissionsState = {
            canRead: canRead(experimentData, currentUser, userData, trustedNow, experimentOwnerUid),
            canEdit: canEdit(experimentData, currentUser, userData, trustedNow, experimentOwnerUid),
            canManage: canManage(experimentData, currentUser, userData, experimentOwnerUid),
            role: getRole(experimentData, currentUser, userData, experimentOwnerUid)
        };
    } catch (error) {
        console.warn('Could not evaluate permissions state', error);
        permissionsState = { canRead: false, canEdit: false, canManage: false, role: 'none' };
    }
}

function stopExperimentRealtimeListener() {
    if (unsubscribeExperimentSnapshot) {
        unsubscribeExperimentSnapshot();
        unsubscribeExperimentSnapshot = null;
    }
    queuedRealtimeExperimentData = null;
}

function cancelPendingAutoSaveForRealtimeUpdate() {
    if (autoSaveTimeoutId) {
        clearTimeout(autoSaveTimeoutId);
        autoSaveTimeoutId = null;
    }
    if (autoSaveRetryTimer) {
        clearTimeout(autoSaveRetryTimer);
        autoSaveRetryTimer = null;
    }
    autoSaveQueued = false;
    hasUserEditedSinceSave = false;
}

function applyRealtimeExperimentData(nextExperimentData) {
    const nextSignature = getRealtimeDataSignature(nextExperimentData);

    // A server acknowledgement of this browser's own save contains the same
    // experiment data. Keep the authoritative timestamps without rebuilding UI.
    if (nextSignature && nextSignature === lastRealtimeDataSignature) {
        experimentData = nextExperimentData;
        return;
    }

    // Realtime data is authoritative. If an external update arrives during an
    // unsaved AI review, discard that draft before rebuilding the form.
    experimentAI?.discardForRealtimeUpdate();

    const focusedElement = document.activeElement;
    const focusedElementId = focusedElement?.id || '';
    const selectionStart = Number.isInteger(focusedElement?.selectionStart)
        ? focusedElement.selectionStart
        : null;
    const selectionEnd = Number.isInteger(focusedElement?.selectionEnd)
        ? focusedElement.selectionEnd
        : null;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    // Realtime updates are authoritative. Discard a local debounce/retry that
    // has not started yet so it cannot write the just-replaced values back.
    cancelPendingAutoSaveForRealtimeUpdate();

    experimentData = nextExperimentData;
    lastRealtimeDataSignature = nextSignature;
    refreshPermissionsState();

    const treatmentsCount = Math.max(1, parseInt(experimentData?.treatmentsCount) || 0);
    currentTreatmentIndex = Math.min(currentTreatmentIndex, treatmentsCount - 1);

    populateForm();
    updateUI();
    generateTreatmentTabs();
    loadEvents();
    loadFinancialData();
    enforcePrivateUntilDateMax();
    applyPermissions();
    setLastSavedFormSignatureFromCurrent();
    clearAllFieldDots();
    updateAutoSaveIndicator('saved');
    persistNavigationState(true);

    setTimeout(() => {
        const nextFocusedElement = focusedElementId
            ? document.getElementById(focusedElementId)
            : null;
        if (nextFocusedElement && !nextFocusedElement.disabled) {
            nextFocusedElement.focus({ preventScroll: true });
            if (
                selectionStart !== null &&
                selectionEnd !== null &&
                typeof nextFocusedElement.setSelectionRange === 'function'
            ) {
                try {
                    nextFocusedElement.setSelectionRange(selectionStart, selectionEnd);
                } catch (error) {
                    // Selects and number inputs do not support a text selection.
                }
            }
        }
        window.scrollTo(0, scrollY);
    }, 0);

    showToast('הניסוי עודכן ע״י משתמש אחר ברגע זה', 'info', 2500);
}

function handleRealtimeExperimentData(nextExperimentData) {
    if (!autoSaveInProgress) {
        applyRealtimeExperimentData(nextExperimentData);
        return;
    }

    // Let an already-started write settle first, then apply the newest server
    // snapshot. This prevents the save completion code from restoring stale state.
    queuedRealtimeExperimentData = nextExperimentData;
    if (isRealtimeApplyQueuedAfterSave) return;

    isRealtimeApplyQueuedAfterSave = true;
    Promise.resolve(activeAutoSavePromise).finally(() => {
        isRealtimeApplyQueuedAfterSave = false;
        const queuedData = queuedRealtimeExperimentData;
        queuedRealtimeExperimentData = null;
        if (queuedData) applyRealtimeExperimentData(queuedData);
    });
}

function startExperimentRealtimeListener() {
    stopExperimentRealtimeListener();
    if (!currentExperimentId || !experimentOwnerUid) return;

    const experimentRef = doc(db, "users", experimentOwnerUid, "experiments", currentExperimentId);
    lastRealtimeDataSignature = getRealtimeDataSignature(experimentData);

    unsubscribeExperimentSnapshot = onSnapshot(
        experimentRef,
        { includeMetadataChanges: true },
        (snapshot) => {
            // Local writes already update the in-memory state in the save flow.
            // Wait for the server-confirmed snapshot before considering UI sync.
            if (snapshot.metadata.hasPendingWrites) return;

            if (!snapshot.exists()) {
                stopExperimentRealtimeListener();
                cancelPendingAutoSaveForRealtimeUpdate();
                showToast('הניסוי נמחק או שאינו זמין עוד', 'warning', 4000);
                setTimeout(() => {
                    window.location.href = 'dashboard.html';
                }, 1500);
                return;
            }

            handleRealtimeExperimentData(snapshot.data());
        },
        (error) => {
            console.error('Realtime experiment listener error:', error);
            stopExperimentRealtimeListener();
            if (error?.code === 'permission-denied') {
                cancelPendingAutoSaveForRealtimeUpdate();
                showAccessDeniedMessage();
                return;
            }
            showToast('הסנכרון בזמן אמת הופסק. ניתן לרענן את הדף.', 'error', 5000);
        }
    );
}

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
            // אתחל שותפים לניסוי (multi-select)
            initLeadResearcherAutocomplete();
            initExperimentPartnersAutocomplete();
            // הגבלת תאריך תפוגה לניסוי פרטי
            enforcePrivateUntilDateMax();
            // אתחל את יומן האירועים
            initEventsLog();
            // אתחל את ניתוחים פיננסים
            initFinancialLog();
            // Calculate permissions state for the loaded experiment
            refreshPermissionsState();

            // Apply permissions to UI, then calculate the clean saved signature.
            try { applyPermissions(); } catch (e) { console.warn('applyPermissions failed', e); }
            setLastSavedFormSignatureFromCurrent();
            initExperimentAI();
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

function updateExperimentDisplayName(name = experimentData?.experimentName || 'ניסוי') {
    const sidebarName = document.getElementById('sidebar-experiment-name');
    if (sidebarName) sidebarName.textContent = name;

    document.title = `${name} - מיזם ח"ץ`;
}

// Update UI elements
function updateUI() {
    updateExperimentDisplayName();

    // Update breadcrumb for current view
    switchView(currentView);
}

// =========================================
// Populate Form
// =========================================
function populateForm() {
    const data = experimentData;

    populateLeadResearchers(data);

    // Partners (clear first so repeated realtime population is idempotent)
    const partnersContainer = document.getElementById('partners-container');
    if (partnersContainer) {
        partnersContainer.innerHTML = '';
        (data.partners || []).forEach(partner => addPartnerRow(partner));
    }

    // Experiment Partners (multi-select chips)
    populateExperimentPartners(data.experimentPartners || []);

    // Creator field
    populateCreatorField(data);

    // Basic fields
    const experimentPath = getExperimentDocumentPath();
    setFieldValue('experiment-id', experimentPath || '—');
    const experimentPathInput = document.getElementById('experiment-id');
    if (experimentPathInput) experimentPathInput.title = experimentPath;
    setFieldValue('experiment-name', data.experimentName);
    setFieldValue('experiment-year', data.experimentYear);
    setFieldValue('experiment-month', data.experimentMonth);
    setFieldValue('research-period', data.researchPeriod || data.startDate || '');
    setFieldValue('study-type', STUDY_TYPES.includes(data.studyType) ? data.studyType : 'field');
    setFieldValue('work-package', data.workPackage);
    setExperimentSiteFromData(data.experimentSite, data.experimentSiteSelection, data.experimentSiteOther);
    setFieldValue('site-coordinates', data.siteCoordinates);
    setFieldValue('lab-cell-number', data.labCellNumber);
    setFieldValue('experiment-goal', data.experimentGoal);
    setFieldValue('experiment-summary', data.experimentSummary);

    // תוספת חשיפה
    setFieldValue('experiment-visibility', data.visibility || 'public');
    if (data.privateUntil && data.privateUntil.toDate) {
        const dateObj = data.privateUntil.toDate();
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getDate()).padStart(2, '0');
        setFieldValue('private-until-date', `${yyyy}-${mm}-${dd}`);
    } else {
        setFieldValue('private-until-date', '');
    }
    setFieldValue('treatments-count', data.treatmentsCount || 3);
    setFieldValue('repetitions-count', data.repetitionsCount);
    setFieldValue('levels-count', data.levelsCount);
    setFieldValue('level-value', data.levelValue);

    // Treatments
    generateTreatmentInputs(data.treatmentsCount || 3, data.treatments || [], data.repetitionsCount);

    // Variables (clear first so snapshots never duplicate rows)
    const independentVariablesContainer = document.getElementById('independent-vars-container');
    const dependentVariablesContainer = document.getElementById('dependent-vars-container');
    if (independentVariablesContainer) independentVariablesContainer.innerHTML = '';
    if (dependentVariablesContainer) dependentVariablesContainer.innerHTML = '';
    (data.independentVariables || []).forEach(v => addVariableRow('independent', v));
    (data.dependentVariables || []).forEach(v => addVariableRow('dependent', v));

    // Keywords
    const keywordsContainer = document.getElementById('keywords-list');
    if (keywordsContainer) keywordsContainer.innerHTML = '';
    (data.keywords || []).forEach(k => addKeywordTag(k));

    // Crop details
    if (data.cropDetails && data.cropDetails.data) {
        const crop = data.cropDetails.data;
        let mappedVarietyType = crop.varietyType || '';
        if (mappedVarietyType === 'cherry' || mappedVarietyType === 'cluster') {
            mappedVarietyType = 'regular';
        }
        let mappedSplitPlant = crop.splitPlant || '';
        if (mappedSplitPlant === 'yes') mappedSplitPlant = 'כן';
        if (mappedSplitPlant === 'no') mappedSplitPlant = 'לא';

        setFieldValue('planting-date', crop.plantingDate);
        setFieldValue('inoculation-date-1', crop.inoculationDate1);
        setFieldValue('inoculation-date-2', crop.inoculationDate2);
        setFieldValue('crop-type', crop.cropType);
        const varietiesList = document.getElementById('varieties-list');
        if (varietiesList) varietiesList.innerHTML = '';
        getCropVarieties(crop).forEach((value) => addVarietyTag(value));
        setFieldValue('variety-input', '');
        setFieldValue('grafted-plant', crop.graftedPlant);
        setFieldValue('variety-type', mappedVarietyType);
        setFieldValue('split-plant', mappedSplitPlant);
        setFieldValue('nursery', crop.nursery);
        setFieldValue('seedlings-count', crop.seedlingsCount);
        setFieldValue('planting-density', crop.plantingDensity);
        setFieldValue('pots-count', crop.potsCount);
        setFieldValue('seedlings-per-pot', crop.seedlingsPerPot);
        setFieldValue('planting-structure', crop.plantingStructure);
        setFieldValue('experiment-area', crop.experimentArea);
        setFieldValue('preparation-name', crop.preparationName);
        setFieldValue('crop-notes', crop.notes);

    }

    // Structure details
    if (data.structureDetails && data.structureDetails.data) {
        const structure = data.structureDetails.data;
        setFieldValue('structure-type', structure.type);
        setFieldValue('structure-size', structure.size);
        setFieldValue('roof-covering', structure.roofCovering);
        setFieldValue('cell-temp-mode', getStructureModeForUI(structure.cellTempMode));
        setFieldValue('cell-temp-fixed', structure.cellTempFixed);
        setFieldValue('cell-temp-min-night', structure.cellTempMinNight);
        setFieldValue('cell-temp-max-day', structure.cellTempMaxDay);
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
        setFieldValue('soil-disinfection-adigan', soil.disinfectionAdigan);
        setAdiganAmountFromData(soil.adiganAmount);
        // Dynamic tables
        renderSoilTable('compost-tbody', soil.compostRows || [], ['date','amount','method']);
        renderSoilDisinfectTable('disinfect-tbody', soil.disinfectRows || []);
        renderSoilCultivationTable(soil.cultivationRows || []);
    }

    // Drip details
    if (data.dripDetails && data.dripDetails.data) {
        const drip = data.dripDetails.data;
        setFieldValue('drip-single-double', drip.singleDouble);
        setFieldValue('drip-pipe-diameter', drip.pipeDiameter);
        setFieldValue('drip-emitter-spacing', drip.emitterSpacing);
        setFieldValue('drip-flow-rate', drip.flowRate);
        setFieldValue('drip-type', drip.type);
        setFieldValue('drip-irrigation-duration-minutes', drip.irrigationDurationMinutes);
        setFieldValue('drip-irrigations-per-day', drip.irrigationsPerDay);
        setFieldValue('drip-lines-count', drip.linesCount);
        renderDripIrrigationTimes(drip.irrigationTimes || []);
    }

    // Progress views (מהלך הניסוי + נתוני יבול)
    populateProgressViews(data);

    updateConditionalFieldVisibility();

    // עדכון כפתור Google Maps אחרי שהנתונים נטענו
    updateGoogleMapsButtonVisibility();

    initializeSharedSectionState();
    syncSharedToggleForCurrentView();
    loadCurrentSectionDataFromState();
}

function setExperimentSiteFromData(experimentSiteValue, experimentSiteSelection, experimentSiteOther) {
    const siteSelect = document.getElementById('experiment-site');
    const siteOtherInput = document.getElementById('experiment-site-other');
    if (!siteSelect) return;

    const oldToNewSiteMap = {
        volcani: 'volcani-bet-dagan'
    };

    let normalizedSite = normalizeDynamicValue(experimentSiteValue);
    normalizedSite = oldToNewSiteMap[normalizedSite] || normalizedSite;

    let selection = normalizeDynamicValue(experimentSiteSelection);
    if (!selection) {
        selection = SITE_PRESET_VALUES.includes(normalizedSite) ? normalizedSite : (normalizedSite ? 'other' : '');
    }

    siteSelect.value = selection;

    if (siteOtherInput) {
        const resolvedOther = normalizeDynamicValue(experimentSiteOther) || (selection === 'other' ? normalizedSite : '');
        siteOtherInput.value = resolvedOther;
    }

    updateExperimentSiteOtherVisibility();
}

function setAdiganAmountFromData(value) {
    const adiganAmountSelect = document.getElementById('soil-adigan-amount');
    const adiganAmountCustomInput = document.getElementById('soil-adigan-amount-custom');
    if (!adiganAmountSelect || !adiganAmountCustomInput) return;

    const normalized = normalizeDynamicValue(value);
    const presetValues = ['40', '60', '80', '100', '120'];

    if (!normalized) {
        adiganAmountSelect.value = '';
        adiganAmountCustomInput.value = '';
    } else if (presetValues.includes(normalized)) {
        adiganAmountSelect.value = normalized;
        adiganAmountCustomInput.value = '';
    } else {
        adiganAmountSelect.value = 'other';
        adiganAmountCustomInput.value = normalized;
    }

    updateAdiganAmountVisibility();
}

function getResolvedAdiganAmount() {
    const adiganAmountSelect = document.getElementById('soil-adigan-amount');
    const adiganAmountCustomInput = document.getElementById('soil-adigan-amount-custom');
    if (!adiganAmountSelect || !adiganAmountCustomInput) return '';

    if (adiganAmountSelect.value === 'other') {
        return adiganAmountCustomInput.value.trim();
    }
    return adiganAmountSelect.value || '';
}

function setFieldValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
}

function collectSectionDataFromDOM(sectionId) {
    switch (sectionId) {
        case 'crop':
            const varieties = getVarietiesFromDOM();
            return {
                plantingDate: document.getElementById('planting-date')?.value || '',
                inoculationDate1: document.getElementById('inoculation-date-1')?.value || '',
                inoculationDate2: document.getElementById('inoculation-date-2')?.value || '',
                cropType: document.getElementById('crop-type')?.value || '',
                varieties,
                variety: varieties[0] || '',
                graftedPlant: document.getElementById('grafted-plant')?.value || '',
                varietyType: document.getElementById('variety-type')?.value || '',
                splitPlant: document.getElementById('split-plant')?.value || '',
                nursery: document.getElementById('nursery')?.value || '',
                seedlingsCount: document.getElementById('seedlings-count')?.value || '',
                plantingDensity: document.getElementById('planting-density')?.value || '',
                potsCount: document.getElementById('pots-count')?.value || '',
                seedlingsPerPot: document.getElementById('seedlings-per-pot')?.value || '',
                plantingStructure: document.getElementById('planting-structure')?.value || '',
                experimentArea: document.getElementById('experiment-area')?.value || '',
                preparationName: document.getElementById('preparation-name')?.value || '',
                notes: document.getElementById('crop-notes')?.value || ''
            };
        case 'structure':
            return {
                type: document.getElementById('structure-type')?.value || '',
                size: document.getElementById('structure-size')?.value || '',
                roofCovering: document.getElementById('roof-covering')?.value || '',
                cellTempMode: document.getElementById('cell-temp-mode')?.value || '',
                cellTempFixed: document.getElementById('cell-temp-fixed')?.value || '',
                cellTempMinNight: document.getElementById('cell-temp-min-night')?.value || '',
                cellTempMaxDay: document.getElementById('cell-temp-max-day')?.value || '',
                direction: document.getElementById('structure-direction')?.value || '',
                notes: document.getElementById('structure-notes')?.value || ''
            };
        case 'soil':
            return {
                detachedSubstrate: document.getElementById('detached-substrate')?.value || '',
                substrateCompany: document.getElementById('substrate-company')?.value || '',
                substrateType: document.getElementById('substrate-type')?.value || '',
                substrateVolume: document.getElementById('substrate-volume')?.value || '',
                disinfectionAdigan: document.getElementById('soil-disinfection-adigan')?.value || '',
                adiganAmount: getResolvedAdiganAmount(),
                compostRows: collectSoilTableRows('compost-tbody', ['date','amount','method']),
                disinfectRows: collectSoilDisinfectRows('disinfect-tbody'),
                cultivationRows: collectSoilCultivationRows()
            };
        case 'drip':
            return {
                singleDouble: document.getElementById('drip-single-double')?.value || '',
                pipeDiameter: document.getElementById('drip-pipe-diameter')?.value || '',
                type: document.getElementById('drip-type')?.value || '',
                emitterSpacing: document.getElementById('drip-emitter-spacing')?.value || '',
                flowRate: document.getElementById('drip-flow-rate')?.value || '',
                irrigationDurationMinutes: document.getElementById('drip-irrigation-duration-minutes')?.value || '',
                irrigationsPerDay: document.getElementById('drip-irrigations-per-day')?.value || '',
                irrigationTimes: collectDripIrrigationTimes(),
                linesCount: document.getElementById('drip-lines-count')?.value || '',
            };
        case 'irrigation':
            return {
                irrigationData: collectProgressRows('irrigation-tbody', IRRIGATION_FIELDS),
                fertilizationData: collectProgressRows('fertilization-tbody', FERTILIZATION_FIELDS)
            };
        case 'growth':
            return {
                growthData: collectProgressRows('growth-tbody', GROWTH_FIELDS)
            };
        case 'climate':
            return {
                climateData: collectProgressRows('climate-tbody', CLIMATE_FIELDS)
            };
        case 'agrotechnics':
            return {
                agrotechnicsData: collectProgressRows('agro-tbody', AGRO_FIELDS),
                pollinationData: collectProgressRows('pollination-tbody', POLLINATION_FIELDS)
            };
        case 'plantProtection':
            return {
                plantProtectionData: {
                    pests: collectProgressRows('pest-tbody', PEST_FIELDS),
                    diseases: collectProgressRows('disease-tbody', PEST_FIELDS),
                    sprays: collectProgressRows('spray-prot-tbody', PROTECTION_FIELDS),
                    drenches: collectProgressRows('drench-tbody', PROTECTION_FIELDS)
                }
            };
        case 'yield':
            return {
                yieldData: {
                    measures: collectProgressRows('yield-measure-tbody', YIELD_MEASURE_FIELDS),
                    damages: collectProgressRows('yield-damage-tbody', YIELD_DAMAGE_FIELDS)
                }
            };
        default:
            return {};
    }
}

function applySectionDataToDOM(sectionId, sectionData) {
    const data = sectionData || {};

    switch (sectionId) {
        case 'crop': {
            let mappedVarietyType = data.varietyType || '';
            if (mappedVarietyType === 'cherry' || mappedVarietyType === 'cluster') mappedVarietyType = 'regular';
            let mappedSplitPlant = data.splitPlant || '';
            if (mappedSplitPlant === 'yes') mappedSplitPlant = 'כן';
            if (mappedSplitPlant === 'no') mappedSplitPlant = 'לא';

            setFieldValue('planting-date', data.plantingDate);
            setFieldValue('inoculation-date-1', data.inoculationDate1);
            setFieldValue('inoculation-date-2', data.inoculationDate2);
            setFieldValue('crop-type', data.cropType);
            const varietiesList = document.getElementById('varieties-list');
            if (varietiesList) varietiesList.innerHTML = '';
            getCropVarieties(data).forEach((value) => addVarietyTag(value));
            setFieldValue('variety-input', '');
            setFieldValue('grafted-plant', data.graftedPlant);
            setFieldValue('variety-type', mappedVarietyType);
            setFieldValue('split-plant', mappedSplitPlant);
            setFieldValue('nursery', data.nursery);
            setFieldValue('seedlings-count', data.seedlingsCount);
            setFieldValue('planting-density', data.plantingDensity);
            setFieldValue('pots-count', data.potsCount);
            setFieldValue('seedlings-per-pot', data.seedlingsPerPot);
            setFieldValue('planting-structure', data.plantingStructure);
            setFieldValue('experiment-area', data.experimentArea);
            setFieldValue('preparation-name', data.preparationName);
            setFieldValue('crop-notes', data.notes);
            break;
        }
        case 'structure': {
            setFieldValue('structure-type', data.type);
            setFieldValue('structure-size', data.size);
            setFieldValue('roof-covering', data.roofCovering);
            setFieldValue('cell-temp-mode', getStructureModeForUI(data.cellTempMode));
            setFieldValue('cell-temp-fixed', data.cellTempFixed);
            setFieldValue('cell-temp-min-night', data.cellTempMinNight);
            setFieldValue('cell-temp-max-day', data.cellTempMaxDay);
            setFieldValue('structure-direction', data.direction);
            setFieldValue('structure-notes', data.notes);
            break;
        }
        case 'soil': {
            setFieldValue('detached-substrate', data.detachedSubstrate);
            setFieldValue('substrate-company', data.substrateCompany);
            setFieldValue('substrate-type', data.substrateType);
            setFieldValue('substrate-volume', data.substrateVolume);
            setFieldValue('soil-disinfection-adigan', data.disinfectionAdigan);
            setAdiganAmountFromData(data.adiganAmount);
            renderSoilTable('compost-tbody', data.compostRows || [], ['date','amount','method']);
            renderSoilDisinfectTable('disinfect-tbody', data.disinfectRows || []);
            renderSoilCultivationTable(data.cultivationRows || []);
            break;
        }
        case 'drip': {
            setFieldValue('drip-single-double', data.singleDouble);
            setFieldValue('drip-pipe-diameter', data.pipeDiameter);
            setFieldValue('drip-type', data.type);
            setFieldValue('drip-emitter-spacing', data.emitterSpacing);
            setFieldValue('drip-flow-rate', data.flowRate);
            setFieldValue('drip-irrigation-duration-minutes', data.irrigationDurationMinutes);
            setFieldValue('drip-irrigations-per-day', data.irrigationsPerDay);
            setFieldValue('drip-lines-count', data.linesCount);
            renderDripIrrigationTimes(data.irrigationTimes || []);
            break;
        }
        case 'irrigation': {
            const irrigTbody = document.getElementById('irrigation-tbody');
            if (irrigTbody) {
                irrigTbody.innerHTML = '';
                (data.irrigationData || []).forEach((row) => addProgressRow(irrigTbody, IRRIGATION_FIELDS, IRRIGATION_LABELS, normalizeLegacyRangeDates(row)));
            }

            const fertTbody = document.getElementById('fertilization-tbody');
            if (fertTbody) {
                fertTbody.innerHTML = '';
                (data.fertilizationData || []).forEach((row) => addProgressRow(fertTbody, FERTILIZATION_FIELDS, FERTILIZATION_LABELS, normalizeLegacyRangeDates(row), {
                    dynamicDatalists: FERTILIZATION_DYNAMIC_DATALISTS
                }));
            }
            break;
        }
        case 'growth': {
            renderGrowthTable(data.growthData || []);
            break;
        }
        case 'climate': {
            renderClimateTable(data.climateData || []);
            break;
        }
        case 'agrotechnics': {
            renderAgroTable(data.agrotechnicsData || []);
            renderPollinationTable(data.pollinationData || []);
            break;
        }
        case 'plantProtection': {
            const pp = data.plantProtectionData || {};

            const pestTbody = document.getElementById('pest-tbody');
            if (pestTbody) {
                pestTbody.innerHTML = '';
                (pp.pests || []).forEach((row) => addPestRow('pest-tbody', row));
            }

            const diseaseTbody = document.getElementById('disease-tbody');
            if (diseaseTbody) {
                diseaseTbody.innerHTML = '';
                (pp.diseases || []).forEach((row) => addPestRow('disease-tbody', row));
            }

            const sprayProtTbody = document.getElementById('spray-prot-tbody');
            if (sprayProtTbody) {
                sprayProtTbody.innerHTML = '';
                (pp.sprays || []).forEach((row) => addProtectionRow('spray-prot-tbody', row));
            }

            const drenchTbody = document.getElementById('drench-tbody');
            if (drenchTbody) {
                drenchTbody.innerHTML = '';
                (pp.drenches || []).forEach((row) => addProtectionRow('drench-tbody', row));
            }
            break;
        }
        case 'yield': {
            const yd = data.yieldData || {};

            const ymTbody = document.getElementById('yield-measure-tbody');
            if (ymTbody) {
                ymTbody.innerHTML = '';
                (yd.measures || []).forEach((row) => addYieldMeasureRow(row));
            }

            const ydTbody = document.getElementById('yield-damage-tbody');
            if (ydTbody) {
                ydTbody.innerHTML = '';
                (yd.damages || []).forEach((row) => addYieldDamageRow(row));
            }
            break;
        }
        default:
            break;
    }

    updateConditionalFieldVisibility();
}

function syncSharedToggleForCurrentView() {
    const toggle = document.getElementById('shared-data-toggle');
    const sectionId = getSectionIdByView();
    if (!toggle || !sectionId) return;

    const model = getSectionModel(sectionId);
    isSyncingSharedToggle = true;
    toggle.checked = model?.shared !== false;
    isSyncingSharedToggle = false;
}

function getSharedReadonlyMessageElement() {
    const toggleContainer = document.getElementById('shared-toggle-container');
    if (!toggleContainer) return null;

    let messageEl = document.getElementById('shared-readonly-message');
    if (!messageEl) {
        messageEl = document.createElement('div');
        messageEl.id = 'shared-readonly-message';
        messageEl.style.width = '100%';
        messageEl.style.marginTop = '8px';
        messageEl.style.fontSize = '0.9rem';
        messageEl.style.fontWeight = '600';
        messageEl.style.color = '#666';
        messageEl.style.display = 'none';
        toggleContainer.appendChild(messageEl);
    }

    return messageEl;
}

function applySharedReadonlyForCurrentView() {
    const sectionId = getSectionIdByView();
    const viewElement = document.getElementById(`view-${currentView}`);
    const messageEl = getSharedReadonlyMessageElement();

    if (!sectionId || !viewElement) {
        if (messageEl) messageEl.style.display = 'none';
        return;
    }

    const model = getSectionModel(sectionId);
    const isReadOnlyMode = Boolean(model?.shared && currentTreatmentIndex > 0);
    const controls = viewElement.querySelectorAll('input, select, textarea, button');

    controls.forEach((control) => {
        if (control.type === 'hidden') return;

        if (isReadOnlyMode) {
            if (!control.dataset.sharedReadonlyManaged) {
                control.dataset.sharedReadonlyManaged = '1';
                control.dataset.sharedReadonlyPrevDisabled = control.disabled ? '1' : '0';
            }
            control.disabled = true;
        } else if (control.dataset.sharedReadonlyManaged === '1') {
            control.disabled = control.dataset.sharedReadonlyPrevDisabled === '1';
            delete control.dataset.sharedReadonlyManaged;
            delete control.dataset.sharedReadonlyPrevDisabled;
        }
    });

    if (messageEl) {
        if (isReadOnlyMode) {
            messageEl.textContent = 'נתונים זהים לכלל הטיפולים. אם ברצונך לשנות, בטל/י את הסימון "נתונים זהים לכלל הטיפולים".';
            messageEl.style.display = 'block';
        } else {
            messageEl.style.display = 'none';
        }
    }
}


function persistCurrentSectionDataToState() {
    const sectionId = getSectionIdByView();
    if (!sectionId) return;
    const sectionData = collectSectionDataFromDOM(sectionId);
    setSectionCurrentData(sectionId, sectionData);
}

function loadCurrentSectionDataFromState() {
    const sectionId = getSectionIdByView();
    if (!sectionId) return;
    const sectionData = getSectionEffectiveData(sectionId);
    applySectionDataToDOM(sectionId, sectionData);
    applySharedReadonlyForCurrentView();
}

function setSectionSharedState(sectionId, shouldBeShared) {
    const model = getSectionModel(sectionId);
    if (!model) return;

    if (shouldBeShared === model.shared) return;

    if (shouldBeShared) {
        cloneSectionTreatment1ToAll(sectionId);
        model.shared = true;
        return;
    }

    cloneSectionTreatment1ToAll(sectionId);
    model.shared = false;
}

function buildSectionModelForSave(sectionId) {
    const model = getSectionModel(sectionId);
    if (!model) {
        return { shared: true, sharedData: {}, byTreatment: [], data: {} };
    }

    ensureModelTreatmentLength(model);

    const treatmentOneData = deepClone(model.byTreatment[0] || model.sharedData || {});
    return {
        shared: model.shared !== false,
        data: treatmentOneData,
        sharedData: deepClone(model.sharedData || {}),
        byTreatment: deepClone(model.byTreatment || [])
    };
}

function getSectionValidationEntries(sectionDetails) {
    const entries = [];
    if (!sectionDetails) return entries;

    const byTreatment = Array.isArray(sectionDetails.byTreatment)
        ? sectionDetails.byTreatment.filter(Boolean)
        : [];

    if (sectionDetails.shared === false) {
        entries.push(...byTreatment);
    } else {
        const sharedData = sectionDetails.sharedData && Object.keys(sectionDetails.sharedData).length
            ? sectionDetails.sharedData
            : sectionDetails.data;
        if (sharedData) entries.push(sharedData);
    }

    if (entries.length === 0 && sectionDetails.data) {
        entries.push(sectionDetails.data);
    }

    return entries;
}

function hasFilePathInValue(value, targetFilePath) {
    if (!value || !targetFilePath) return false;

    if (Array.isArray(value)) {
        return value.some((item) => hasFilePathInValue(item, targetFilePath));
    }

    if (typeof value === 'object') {
        if (value.filePath === targetFilePath) return true;
        return Object.values(value).some((child) => hasFilePathInValue(child, targetFilePath));
    }

    return false;
}

function isFilePathSharedAcrossTreatments(sectionId, filePath, currentIndex = currentTreatmentIndex) {
    const model = getSectionModel(sectionId);
    if (!model || !filePath) return false;

    ensureModelTreatmentLength(model);

    return model.byTreatment.some((entry, idx) => idx !== currentIndex && hasFilePathInValue(entry, filePath));
}

// עדכון כפתור Google Maps - פונקציה גלובלית שניתן לקרוא לה מכל מקום
function updateGoogleMapsButtonVisibility() {
    const openGoogleMapsBtn = document.getElementById('open-google-maps-btn');
    const coordsInput = document.getElementById('site-coordinates');
    const isLab = getCurrentStudyType() === 'lab';

    if (openGoogleMapsBtn && coordsInput) {
        if (isLab) {
            openGoogleMapsBtn.style.display = 'none';
        } else if (coordsInput.value && coordsInput.value.trim()) {
            openGoogleMapsBtn.style.display = 'block';
        } else {
            openGoogleMapsBtn.style.display = 'none';
        }
    }
}

// =========================================
// Treatment Tabs
// =========================================
function updateTreatmentTabsScrollControls() {
    const tabsNav = document.getElementById('tabs-nav');
    if (!tabsNav) return;

    const leftButton = document.querySelector('.treatment-tabs-scroll-left');
    const rightButton = document.querySelector('.treatment-tabs-scroll-right');
    const tabs = Array.from(tabsNav.querySelectorAll('.tab-item'));
    const navRect = tabsNav.getBoundingClientRect();
    const overflowTolerance = 2;

    const hasLeftOverflow = navRect.width > 0 && tabs.some((tab) => (
        tab.getBoundingClientRect().left < navRect.left - overflowTolerance
    ));
    const hasRightOverflow = navRect.width > 0 && tabs.some((tab) => (
        tab.getBoundingClientRect().right > navRect.right + overflowTolerance
    ));

    [
        [leftButton, hasLeftOverflow],
        [rightButton, hasRightOverflow]
    ].forEach(([button, isVisible]) => {
        if (!button) return;
        button.classList.toggle('is-visible', isVisible);
        button.disabled = !isVisible;
        button.setAttribute('aria-hidden', String(!isVisible));
    });
}

function scrollTreatmentTabIntoHorizontalView(tab, behavior = 'smooth', edgePadding = 0) {
    const tabsNav = document.getElementById('tabs-nav');
    if (!tabsNav || !tab) return;

    const navRect = tabsNav.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const leftBoundary = navRect.left + edgePadding;
    const rightBoundary = navRect.right - edgePadding;
    let horizontalDelta = 0;

    if (tabRect.left < leftBoundary) {
        horizontalDelta = tabRect.left - leftBoundary;
    } else if (tabRect.right > rightBoundary) {
        horizontalDelta = tabRect.right - rightBoundary;
    }

    if (Math.abs(horizontalDelta) > 1) {
        const scrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : behavior;
        tabsNav.scrollBy({ left: horizontalDelta, behavior: scrollBehavior });
    }
}

function scrollTreatmentTabs(direction) {
    const tabsNav = document.getElementById('tabs-nav');
    if (!tabsNav) return;

    const navRect = tabsNav.getBoundingClientRect();
    const tabPositions = Array.from(tabsNav.querySelectorAll('.tab-item')).map((tab) => ({
        tab,
        rect: tab.getBoundingClientRect()
    }));

    const hiddenTabs = direction === 'left'
        ? tabPositions
            .filter(({ rect }) => rect.left < navRect.left - 1)
            .sort((a, b) => b.rect.left - a.rect.left)
        : tabPositions
            .filter(({ rect }) => rect.right > navRect.right + 1)
            .sort((a, b) => a.rect.right - b.rect.right);

    scrollTreatmentTabIntoHorizontalView(hiddenTabs[0]?.tab, 'smooth', 52);
}

function scrollActiveTreatmentTabIntoView(behavior = 'smooth') {
    const activeTab = document.querySelector(`.tab-item[data-index="${currentTreatmentIndex}"]`);
    scrollTreatmentTabIntoHorizontalView(activeTab, behavior, 8);
}

function initTreatmentTabsScroller() {
    const tabsNav = document.getElementById('tabs-nav');
    if (!tabsNav) return;

    document.querySelectorAll('.treatment-tabs-scroll').forEach((button) => {
        button.addEventListener('click', () => scrollTreatmentTabs(button.dataset.scrollDirection));
    });

    tabsNav.addEventListener('scroll', updateTreatmentTabsScrollControls, { passive: true });
    window.addEventListener('resize', updateTreatmentTabsScrollControls, { passive: true });

    if ('ResizeObserver' in window) {
        const resizeObserver = new ResizeObserver(updateTreatmentTabsScrollControls);
        resizeObserver.observe(tabsNav);
    }

    const mutationObserver = new MutationObserver(() => {
        requestAnimationFrame(updateTreatmentTabsScrollControls);
    });
    mutationObserver.observe(tabsNav, { childList: true, subtree: true, characterData: true });

    updateTreatmentTabsScrollControls();
}

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
        tab.textContent = treatmentName;
        tab.dataset.index = i;

        tab.addEventListener('click', () => switchTreatmentTab(i));
        // In RTL flex layout, appending keeps treatment 1 on the right and later treatments to its left.
        tabsNav.appendChild(tab);
    }

    requestAnimationFrame(() => {
        scrollActiveTreatmentTabIntoView('auto');
        updateTreatmentTabsScrollControls();
    });
}

function switchTreatmentTab(index) {
    persistCurrentSectionDataToState();

    currentTreatmentIndex = index;
    // Match tabs by their data-index attribute instead of DOM order
    document.querySelectorAll('.tab-item').forEach((tab) => {
        const tabIndex = parseInt(tab.dataset.index);
        tab.classList.toggle('active', tabIndex === index);
    });
    scrollActiveTreatmentTabIntoView();

    loadCurrentSectionDataFromState();
    // מעבר בין טיפולים בונה מחדש את הטבלאות/השדות — מסמנים שוב את מה שמולא ע"י AI.
    experimentAI?.refreshView(currentView);
    persistNavigationState();
}

// =========================================
// View Switching
// =========================================
function switchView(viewName) {
    const previousView = currentView;
    if (previousView !== viewName) {
        persistCurrentSectionDataToState();
    }

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
    const viewsWithTabs = ['crop', 'structure', 'soil', 'drip', 'irrigation', 'growth', 'climate', 'agrotechnics', 'plant-protection', 'yield'];

    if (viewsWithTabs.includes(viewName)) {
        if (tabsContainer) tabsContainer.style.display = 'block';
        if (toggleContainer) toggleContainer.style.display = 'flex';
    } else {
        if (tabsContainer) tabsContainer.style.display = 'none';
        if (toggleContainer) toggleContainer.style.display = 'none';
        const messageEl = document.getElementById('shared-readonly-message');
        if (messageEl) messageEl.style.display = 'none';
    }

    requestAnimationFrame(updateTreatmentTabsScrollControls);

    syncSharedToggleForCurrentView();
    loadCurrentSectionDataFromState();
    experimentAI?.refreshView(viewName);

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
        'agrotechnics': 'אגרוטכניקה והאבקה',
        'plant-protection': 'הגנת הצומח',
        'yield': 'נתוני יבול',
        'events': 'יומן אירועים',
        'financial-analysis': 'ניתוחים פיננסים'
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

    persistNavigationState();
    experimentAI?.refreshReview();
}

// =========================================
// Dynamic Elements
// =========================================
function generateTreatmentInputs(count, existingTreatments = [], repetitionsCount = getCurrentRepetitionsCount()) {
    const container = document.getElementById('treatments-container');
    if (!container) return;

    const safeCount = Math.max(1, parseInt(count) || 0);
    const safeRepetitionsCount = Math.min(MAX_REPETITIONS_PER_TREATMENT, Math.max(1, parseInt(repetitionsCount) || 0));

    container.innerHTML = '';

    for (let i = 0; i < safeCount; i++) {
        const existing = existingTreatments[i] || {};
        const repeatLabels = getTreatmentRepeatLabels(existing, i, safeRepetitionsCount);
        const item = document.createElement('div');
        item.className = 'treatment-item';
        item.dataset.index = i;
        item.innerHTML = `
            <label>שם לטיפול ${i + 1}:</label>
            <input type="text" class="treatment-name" data-index="${i}" value="${existing.name || ''}" placeholder="שם הטיפול">
            <div class="treatment-repeats">
                ${repeatLabels.map((repeatLabel, repeatIndex) => `
                    <div class="treatment-repeat-row">
                        <label>חזרה ${repeatIndex + 1}:</label>
                        <input type="text" class="treatment-repeat" data-index="${i}" data-repeat-index="${repeatIndex}" value="${repeatLabel}" placeholder="חזרה ${repeatIndex + 1}">
                    </div>
                `).join('')}
            </div>
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
        deleteBtn.addEventListener('click', async () => {
            if (!(await confirmDeferredDeletion('השותף'))) return;
            row.remove();
        });
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

    row.querySelector('.btn-delete').addEventListener('click', async () => {
        if (!(await confirmDeferredDeletion('המשתנה'))) return;
        row.remove();
    });
    container.appendChild(row);
}

function addKeywordTag(value) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) return;

    const container = document.getElementById('keywords-list');
    if (!container) return;

    // Check if exists
    const duplicate = Array.from(container.querySelectorAll('.keyword-tag'))
        .some((tag) => (tag.dataset.value || '').toLowerCase() === normalizedValue.toLowerCase());
    if (duplicate) return;

    const tag = document.createElement('span');
    tag.className = 'keyword-tag';
    tag.dataset.value = normalizedValue;
    tag.innerHTML = `
        ${normalizedValue}
        <span class="remove"><i class="fas fa-times"></i></span>
    `;

    tag.querySelector('.remove').addEventListener('click', async () => {
        if (!permissionsState?.canEdit) return;
        if (!(await confirmDeferredDeletion('מילת המפתח'))) return;
        tag.remove();
    });
    container.appendChild(tag);
}

async function loadGlobalKeywordOptions() {
    try {
        const keywordsRef = doc(db, ...GLOBAL_KEYWORDS_DOC);
        const keywordsSnap = await getDoc(keywordsRef);
        const savedKeywords = keywordsSnap.exists() ? keywordsSnap.data()?.keywords : [];

        globalKeywordOptions = normalizeUniqueValues([
            ...DEFAULT_GLOBAL_KEYWORDS,
            ...(Array.isArray(savedKeywords) ? savedKeywords : [])
        ]);
        applyGlobalKeywordOptionsToUI();
    } catch (error) {
        globalKeywordOptions = [...DEFAULT_GLOBAL_KEYWORDS];
        applyGlobalKeywordOptionsToUI();

        if (error?.code === 'permission-denied') {
            console.warn('Skipping global keyword options load due to permissions (permission-denied).');
            return;
        }
        console.error('Error loading global keyword options:', error);
    }
}

async function persistGlobalKeywordOptions(keywords) {
    const newKeywords = normalizeUniqueValues(keywords);
    const hasNewLocalKeyword = newKeywords.some((keyword) => {
        const key = keyword.toLowerCase();
        return !globalKeywordOptions.some((existing) => existing.toLowerCase() === key);
    });

    if (!hasNewLocalKeyword) return;

    try {
        const keywordsRef = doc(db, ...GLOBAL_KEYWORDS_DOC);
        const merged = await runTransaction(db, async (transaction) => {
            const currentSnap = await transaction.get(keywordsRef);
            const currentKeywords = currentSnap.exists() ? currentSnap.data()?.keywords : [];
            const nextKeywords = normalizeUniqueValues([
                ...DEFAULT_GLOBAL_KEYWORDS,
                ...(Array.isArray(currentKeywords) ? currentKeywords : []),
                ...newKeywords
            ]);

            transaction.set(keywordsRef, {
                keywords: nextKeywords,
                updatedAt: serverTimestamp(),
                updatedBy: currentUser?.uid || null
            }, { merge: true });

            return nextKeywords;
        });

        globalKeywordOptions = merged;
        applyGlobalKeywordOptionsToUI();
    } catch (error) {
        if (error?.code === 'permission-denied') {
            console.warn('Skipping global keyword options persist due to permissions (permission-denied).');
            return;
        }
        console.error('Error persisting global keyword options:', error);
    }
}

function addVarietyTag(value) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) return;

    const container = document.getElementById('varieties-list');
    if (!container) return;

    const duplicate = Array.from(container.querySelectorAll('.variety-tag'))
        .some((tag) => (tag.dataset.value || '').toLowerCase() === normalizedValue.toLowerCase());
    if (duplicate) return;

    const tag = document.createElement('span');
    tag.className = 'keyword-tag variety-tag';
    tag.dataset.value = normalizedValue;
    tag.innerHTML = `
        ${normalizedValue}
        <span class="remove"><i class="fas fa-times"></i></span>
    `;

    tag.querySelector('.remove').addEventListener('click', async () => {
        if (!permissionsState?.canEdit) return;
        if (!(await confirmDeferredDeletion('הזן'))) return;
        tag.remove();
    });

    container.appendChild(tag);
}

function getVarietiesFromDOM() {
    const values = [];
    document.querySelectorAll('#varieties-list .variety-tag').forEach((tag) => {
        const value = String(tag.dataset.value || '').trim();
        if (value) values.push(value);
    });
    return normalizeVarieties(values);
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
    document.querySelectorAll('.treatment-item').forEach(item => {
        const index = parseInt(item.dataset.index);
        if (!Number.isFinite(index)) return;

        const nameInput = item.querySelector('.treatment-name');
        const repeatInputs = Array.from(item.querySelectorAll('.treatment-repeat'))
            .sort((a, b) => parseInt(a.dataset.repeatIndex) - parseInt(b.dataset.repeatIndex));
        const repeatLabels = repeatInputs.map((repeatInput, repeatIndex) => {
            const fallbackLabel = `חזרה ${repeatIndex + 1}`;
            return String(repeatInput?.value || '').trim() || fallbackLabel;
        });

        treatments.push({
            name: nameInput?.value || '',
            repeatLabels,
            repeatLabel: repeatLabels[0] || '',
            repeatNumber: repeatLabels.length || 1
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
        const value = String(tag.dataset.value || '').trim();
        if (value) keywords.push(value);
    });

    persistCurrentSectionDataToState();

    const cropModel = buildSectionModelForSave('crop');
    const structureModel = buildSectionModelForSave('structure');
    const soilModel = buildSectionModelForSave('soil');
    const dripModel = buildSectionModelForSave('drip');
    const irrigationModel = buildSectionModelForSave('irrigation');
    const growthModel = buildSectionModelForSave('growth');
    const climateModel = buildSectionModelForSave('climate');
    const agrotechnicsModel = buildSectionModelForSave('agrotechnics');
    const plantProtectionModel = buildSectionModelForSave('plantProtection');
    const yieldModel = buildSectionModelForSave('yield');
    const yieldData = {
        ...normalizeYieldData(yieldModel.data?.yieldData || {}),
        sharedData: normalizeYieldData(yieldModel.sharedData?.yieldData || yieldModel.sharedData || {}),
        byTreatment: Array.isArray(yieldModel.byTreatment)
            ? yieldModel.byTreatment.map((entry) => normalizeYieldData(entry?.yieldData || entry))
            : []
    };

    const experimentSiteSelection = document.getElementById('experiment-site')?.value || '';
    const experimentSiteOther = document.getElementById('experiment-site-other')?.value.trim() || '';
    const studyType = getCurrentStudyType();
    const labCellNumber = document.getElementById('lab-cell-number')?.value.trim() || '';
    const resolvedExperimentSite = experimentSiteSelection === 'other'
        ? experimentSiteOther
        : experimentSiteSelection;

    const visibility = getVisibilityFromUI ? getVisibilityFromUI() : (document.getElementById('experiment-visibility')?.value || 'public');
    const privateUntilTimestamp = getPrivateUntilFromUI ? getPrivateUntilFromUI() : null;
    const publicAccess = getPublicAccessFromUI ? getPublicAccessFromUI() : { canRead: true, canWrite: false };

    return {
        visibility: visibility,
        privateUntil: privateUntilTimestamp,
        publicAccess: publicAccess,
        experimentName: document.getElementById('experiment-name')?.value.trim() || experimentData?.experimentName || '',
        leadResearchers: collectLeadResearchers(),
        externalLeadResearchers: collectExternalLeadResearchers(),
        partners,
        experimentPartners: collectExperimentPartners(),
        creatorName: document.getElementById('experiment-creator')?.value || '',
        experimentYear: document.getElementById('experiment-year')?.value || '',
        experimentMonth: document.getElementById('experiment-month')?.value || '',
        researchPeriod: document.getElementById('research-period')?.value || '',
        studyType,
        workPackage: document.getElementById('work-package')?.value || '',
        experimentSite: resolvedExperimentSite,
        experimentSiteSelection,
        experimentSiteOther: experimentSiteSelection === 'other' ? experimentSiteOther : '',
        siteCoordinates: studyType === 'field' ? (document.getElementById('site-coordinates')?.value || '') : '',
        labCellNumber: studyType === 'lab' ? labCellNumber : '',
        experimentGoal: document.getElementById('experiment-goal')?.value || '',
        experimentSummary: document.getElementById('experiment-summary')?.value || '',
        treatmentsCount: parseInt(document.getElementById('treatments-count')?.value) || 0,
        repetitionsCount: getCurrentRepetitionsCount(),
        treatments,
        independentVariables,
        levelsCount: parseInt(document.getElementById('levels-count')?.value) || 0,
        levelValue: document.getElementById('level-value')?.value || '',
        dependentVariables,
        keywords: normalizeUniqueValues(keywords),
        cropDetails: {
            shared: cropModel.shared,
            data: cropModel.data,
            sharedData: cropModel.sharedData,
            byTreatment: cropModel.byTreatment
        },
        structureDetails: {
            shared: structureModel.shared,
            data: structureModel.data,
            sharedData: structureModel.sharedData,
            byTreatment: structureModel.byTreatment
        },
        soilDetails: {
            shared: soilModel.shared,
            data: soilModel.data,
            sharedData: soilModel.sharedData,
            byTreatment: soilModel.byTreatment
        },
        dripDetails: {
            shared: dripModel.shared,
            data: dripModel.data,
            sharedData: dripModel.sharedData,
            byTreatment: dripModel.byTreatment
        },
        irrigationData: irrigationModel.data.irrigationData || [],
        fertilizationData: irrigationModel.data.fertilizationData || [],
        growthData: growthModel.data.growthData || [],
        climateData: climateModel.data.climateData || [],
        agrotechnicsData: agrotechnicsModel.data.agrotechnicsData || [],
        pollinationData: agrotechnicsModel.data.pollinationData || [],
        plantProtectionData: plantProtectionModel.data.plantProtectionData || { pests: [], diseases: [], sprays: [], drenches: [] },
        yieldData,
        sectionSharedState: {
            crop: cropModel,
            structure: structureModel,
            soil: soilModel,
            drip: dripModel,
            irrigation: irrigationModel,
            growth: growthModel,
            climate: climateModel,
            agrotechnics: agrotechnicsModel,
            plantProtection: plantProtectionModel,
            yield: yieldModel
        },
        events: collectEventsData(),
        financialData: collectFinancialData(),
        updatedAt: serverTimestamp()
    };
}

// =========================================
// Save Experiment
// =========================================
async function saveExperiment() {
    if (!currentUser || !currentExperimentId || !experimentOwnerUid) return false;

    if (!permissionsState?.canEdit) {
        showToast('אין הרשאת עריכה', 'error');
        return false;
    }

    const formData = collectFormData();
    let { privacyFallbackApplied } = prepareAccessManagedFieldsForSave(formData);
    let previousRealtimeSignature = '';
    let expectedRealtimeSignature = '';
    let coreExperimentWriteCommitted = false;

    // ולידציית שדות פרטיות
    if (formData.visibility === 'private') {
        if (!formData.privateUntil) {
            showToast('חובה להזין תאריך סיום פרטיות כאשר הניסוי מסומן כחסוי.', 'warning');
            return false;
        }
        const privateUntilDate = formData.privateUntil.toDate();
        if (privateUntilDate <= getTrustedNow()) {
            showToast('תאריך סיום פרטיות חייב להיות עתידי.', 'warning');
            return false;
        }
        const maxPrivateUntilDate = getPrivateUntilResearchYearLimit();
        if (!hasPrivacyExtensionApproval() && privateUntilDate > maxPrivateUntilDate) {
            showToast(`תאריך סיום פרטיות מוגבל עד ${formatHebrewDate(maxPrivateUntilDate)} (סוף שנת המחקר)`, 'warning');
            return false;
        }
    }

    const structureEntries = getSectionValidationEntries(formData.structureDetails);
    for (const entry of structureEntries) {
        if (entry?.cellTempMode === 'קבועה' && !hasValue(entry.cellTempFixed)) {
            showToast("בטמפ' תא קבועה חובה להזין טמפ'", 'warning');
            return false;
        }
        if ((entry?.cellTempMode === 'משתנה' || entry?.cellTempMode === 'משתנה מבוקרת')
            && (!hasValue(entry.cellTempMinNight) || !hasValue(entry.cellTempMaxDay))) {
            showToast("בטמפ' תא משתנה מבוקרת חובה להזין מינימום ומקסימום", 'warning');
            return false;
        }
    }

    const plantProtection = formData.plantProtectionData || {};
    const inoculationRows = [
        ...(plantProtection.pests || []),
        ...(plantProtection.diseases || [])
    ];
    const missingMethod = inoculationRows.find(row => row?.inoculationType === 'מלאכותי' && !hasValue(row?.inoculationMethod));
    if (missingMethod) {
        showToast('כאשר סוג האילוח הוא מלאכותי חובה לבחור שיטת אילוח', 'warning');
        return false;
    }

    try {
        const preparedAccess = prepareAccessManagedFieldsForSave(formData, {
            includePermissions: permissionsState?.canManage
        });
        privacyFallbackApplied = privacyFallbackApplied || preparedAccess.privacyFallbackApplied;

        // שמור לבעלים של הניסוי
        const experimentRef = doc(db, "users", experimentOwnerUid, "experiments", currentExperimentId);
        previousRealtimeSignature = lastRealtimeDataSignature;
        expectedRealtimeSignature = getRealtimeDataSignature({ ...experimentData, ...formData });
        lastRealtimeDataSignature = expectedRealtimeSignature;
        await updateDoc(experimentRef, formData);
        coreExperimentWriteCommitted = true;
        await persistDynamicFieldOptions(formData);
        await persistGlobalKeywordOptions(formData.keywords);

        // עדכן מצביעי dashboard לפי מפת ההרשאות שהיא מקור האמת.
        const syncResult = await syncSharedExperiments(
            getPermissionShareEntries(formData, formData.permissions),
            formData
        );

        experimentData = { ...experimentData, ...formData };
        lastRealtimeDataSignature = getRealtimeDataSignature(experimentData);
        if (privacyFallbackApplied) {
            syncPrivacyFallbackUIToPublic();
            notifyPrivacyFallbackToPublic();
        }
        updateExperimentDisplayName();
        generateTreatmentTabs();
        lastSavedFormSignature = getFormSignatureFromData(formData);
        hasUserEditedSinceSave = false;
        persistNavigationState();

        showToast('נשמר בהצלחה!', 'success');
        updateAutoSaveIndicator('saved');
        return true;
    } catch (error) {
        if (
            !coreExperimentWriteCommitted &&
            lastRealtimeDataSignature === expectedRealtimeSignature
        ) {
            lastRealtimeDataSignature = previousRealtimeSignature;
        }
        console.error("Error saving experiment:", error);
        showToast('שגיאה בשמירת הניסוי: ' + error.message, 'error');
        return false;
    }
}

function updateExperimentSiteOtherVisibility() {
    const siteSelect = document.getElementById('experiment-site');
    const siteOtherInput = document.getElementById('experiment-site-other');
    if (!siteSelect || !siteOtherInput) return;

    const shouldShow = siteSelect.value === 'other';
    siteOtherInput.style.display = shouldShow ? 'block' : 'none';
    if (!shouldShow) siteOtherInput.value = '';
}

function updateStudyTypeVisibility() {
    const isLab = getCurrentStudyType() === 'lab';
    const siteLabel = document.getElementById('site-field-label');
    const coordinatesGroup = document.getElementById('site-coordinates-group');
    const labCellGroup = document.getElementById('lab-cell-number-group');
    const pickLocationBtn = document.getElementById('pick-location-btn');
    const plantingDensityGroup = document.getElementById('planting-density-group');
    const potsCountGroup = document.getElementById('pots-count-group');
    const seedlingsPerPotGroup = document.getElementById('seedlings-per-pot-group');

    syncStudyTypeToggle();

    if (siteLabel) siteLabel.textContent = isLab ? "מס' תא:" : 'קורדינטות אתר הניסוי:';
    if (coordinatesGroup) coordinatesGroup.style.display = isLab ? 'none' : 'block';
    if (labCellGroup) labCellGroup.style.display = isLab ? 'block' : 'none';
    if (pickLocationBtn) pickLocationBtn.disabled = !permissionsState?.canEdit || isLab;

    if (plantingDensityGroup) plantingDensityGroup.style.display = isLab ? 'none' : '';
    if (potsCountGroup) potsCountGroup.style.display = isLab ? '' : 'none';
    if (seedlingsPerPotGroup) seedlingsPerPotGroup.style.display = isLab ? '' : 'none';

    updateIrrigationWaterUnitLabels();
    updateGoogleMapsButtonVisibility();
}

function updateStructureTemperatureVisibility() {
    const mode = document.getElementById('cell-temp-mode')?.value || '';
    const fixedGroup = document.getElementById('cell-temp-fixed-group');
    const minGroup = document.getElementById('cell-temp-min-group');
    const maxGroup = document.getElementById('cell-temp-max-group');
    const fixedInput = document.getElementById('cell-temp-fixed');
    const minInput = document.getElementById('cell-temp-min-night');
    const maxInput = document.getElementById('cell-temp-max-day');

    if (fixedGroup) fixedGroup.style.display = mode === 'קבועה' ? '' : 'none';
    const isControlledVariable = mode === 'משתנה מבוקרת' || mode === 'משתנה';
    if (minGroup) minGroup.style.display = isControlledVariable ? '' : 'none';
    if (maxGroup) maxGroup.style.display = isControlledVariable ? '' : 'none';

    if (mode !== 'קבועה' && fixedInput) fixedInput.value = '';
    if (!isControlledVariable) {
        if (minInput) minInput.value = '';
        if (maxInput) maxInput.value = '';
    }
}

function renderDripIrrigationTimes(times = []) {
    const container = document.getElementById('drip-irrigation-times-container');
    if (!container) return;
    container.innerHTML = '';
    times.forEach((time, index) => {
        const row = document.createElement('div');
        row.className = 'drip-field-row';
        row.innerHTML = `
            <label class="drip-field-label">שעת השקיה ${index + 1}:</label>
            <div class="drip-field-value">
                <input type="time" class="drip-irrigation-time" value="${time || ''}">
            </div>
        `;
        container.appendChild(row);
    });
}

function updateDripIrrigationTimesCount() {
    const count = Math.max(0, parseInt(document.getElementById('drip-irrigations-per-day')?.value || '0', 10) || 0);
    const current = collectDripIrrigationTimes();
    const next = Array.from({ length: count }, (_, idx) => current[idx] || '');
    renderDripIrrigationTimes(next);
}

function collectDripIrrigationTimes() {
    return Array.from(document.querySelectorAll('.drip-irrigation-time'))
        .map((el) => el.value || '')
        .filter((value) => Boolean(value));
}

function updatePreparationNameVisibility() {
    const graftedPlantSelect = document.getElementById('grafted-plant');
    const preparationGroup = document.getElementById('preparation-name-group');
    const varietyTypeGroup = document.getElementById('variety-type-group');
    const varietyTypeSelect = document.getElementById('variety-type');
    const preparationInput = document.getElementById('preparation-name');
    if (!graftedPlantSelect || !preparationGroup || !varietyTypeGroup || !varietyTypeSelect) return;

    const showVarietyType = graftedPlantSelect.value === 'yes' || graftedPlantSelect.value === 'no';
    const showPreparation = graftedPlantSelect.value === 'yes';

    varietyTypeGroup.style.display = showVarietyType ? '' : 'none';
    preparationGroup.style.display = showPreparation ? '' : 'none';

    if (!showVarietyType) {
        varietyTypeSelect.value = '';
    }
    if (!showPreparation && preparationInput) {
        preparationInput.value = '';
    }
}

function updateDetachedSubstrateVisibility() {
    const detachedSubstrateSelect = document.getElementById('detached-substrate');
    if (!detachedSubstrateSelect) return;

    const shouldShow = detachedSubstrateSelect.value === 'כן';
    ['substrate-company', 'substrate-type', 'substrate-volume'].forEach((id) => {
        const input = document.getElementById(id);
        const group = input?.closest('.form-group');
        if (group) {
            group.style.display = shouldShow ? '' : 'none';
        }
    });
}

function updateAdiganAmountVisibility() {
    const disinfectionAdiganSelect = document.getElementById('soil-disinfection-adigan');
    const adiganAmountSelect = document.getElementById('soil-adigan-amount');
    const adiganAmountCustomInput = document.getElementById('soil-adigan-amount-custom');

    if (!disinfectionAdiganSelect || !adiganAmountSelect || !adiganAmountCustomInput) return;

    const shouldShowAmount = disinfectionAdiganSelect.value === 'כן';
    adiganAmountSelect.style.display = shouldShowAmount ? 'block' : 'none';

    if (!shouldShowAmount) {
        adiganAmountSelect.value = '';
        adiganAmountCustomInput.value = '';
        adiganAmountCustomInput.style.display = 'none';
        return;
    }

    const shouldShowCustom = adiganAmountSelect.value === 'other';
    adiganAmountCustomInput.style.display = shouldShowCustom ? 'block' : 'none';
    if (!shouldShowCustom) adiganAmountCustomInput.value = '';
}

function updateConditionalFieldVisibility() {
    updateStudyTypeVisibility();
    updateExperimentSiteOtherVisibility();
    updatePreparationNameVisibility();
    updateStructureTemperatureVisibility();
    updateDripIrrigationTimesCount();
    updateDetachedSubstrateVisibility();
    updateAdiganAmountVisibility();
    updateVisibilityFields();
}

function updateVisibilityFields() {
    const visibilitySelect = document.getElementById('experiment-visibility');
    const privateUntilGroup = document.getElementById('private-until-group');
    if(visibilitySelect && privateUntilGroup) {
        // מניעת הוספת listener כפול
        if (!visibilitySelect.dataset.listenerAttached) {
            visibilitySelect.addEventListener('change', () => {
                privateUntilGroup.style.display = visibilitySelect.value === 'private' ? 'block' : 'none';
            });
            visibilitySelect.dataset.listenerAttached = 'true';
        }
        // סנכרון מצב נוכחי
        privateUntilGroup.style.display = visibilitySelect.value === 'private' ? 'block' : 'none';
    }
}

// =========================================
// Permissions UI – state
// =========================================
let permissionsUIData = {}; // uid → { role, addedAt, addedBy }
let selectedPermissionUser = null; // user object chosen from autocomplete

function normalizePartnerRecord(partner) {
    if (typeof partner === 'string') {
        return { uid: '', name: partner.trim(), email: '' };
    }

    if (!partner || typeof partner !== 'object') {
        return { uid: '', name: '', email: '' };
    }

    return {
        uid: String(partner.uid || '').trim(),
        name: String(partner.name || partner.fullName || '').trim(),
        email: String(partner.email || '').trim()
    };
}

function getPartnerIdentity(partner) {
    const normalized = normalizePartnerRecord(partner);
    if (normalized.uid) return `uid:${normalized.uid}`;
    if (normalized.email) return `email:${normalized.email.toLowerCase()}`;
    return normalized.name ? `name:${normalized.name.toLowerCase()}` : '';
}

function getLegacyPartnerRecords(data = experimentData) {
    const records = [];
    const seen = new Set();

    [
        ...(Array.isArray(data?.experimentPartners) ? data.experimentPartners : []),
        ...(Array.isArray(data?.partners) ? data.partners : [])
    ].forEach((partner) => {
        const normalized = normalizePartnerRecord(partner);
        const identity = getPartnerIdentity(normalized);
        if (!identity || seen.has(identity)) return;
        seen.add(identity);
        records.push(normalized);
    });

    return records;
}

function getPermissionUidForPartner(partner, permissions = permissionsUIData) {
    const normalized = normalizePartnerRecord(partner);
    if (normalized.uid && permissions?.[normalized.uid]) return normalized.uid;

    const user = findUserForPartner(normalized);
    return user?.uid && permissions?.[user.uid] ? user.uid : '';
}

function getPartnerForPermissionUid(uid, sourceData = experimentData) {
    const user = allUsers.find(candidate => candidate.uid === uid);
    if (user) {
        return {
            uid: user.uid,
            name: user.fullName || user.email || user.uid,
            email: user.email || ''
        };
    }

    const legacyPartner = getLegacyPartnerRecords(sourceData).find((partner) => {
        if (partner.uid === uid) return true;
        return findUserForPartner(partner)?.uid === uid;
    });

    if (legacyPartner) {
        return { ...legacyPartner, uid };
    }

    return { uid, name: uid, email: '' };
}

function getSynchronizedExperimentPartners(sourceData = experimentData, permissions = permissionsUIData) {
    const synchronized = [];
    const seen = new Set();

    const addUnique = (partner) => {
        const normalized = normalizePartnerRecord(partner);
        const identity = getPartnerIdentity(normalized);
        if (!identity || seen.has(identity)) return;
        seen.add(identity);
        synchronized.push(normalized);
    };

    Object.keys(permissions || {}).forEach((uid) => {
        addUnique(getPartnerForPermissionUid(uid, sourceData));
    });

    // Preserve historic free-text/deleted-user entries that cannot be mapped to
    // a publicUsers UID. Mapped users are controlled exclusively by permissions.
    getLegacyPartnerRecords(sourceData).forEach((partner) => {
        if (getPermissionUidForPartner(partner, permissions)) return;
        if (findUserForPartner(partner)) return;
        addUnique(partner);
    });

    return synchronized;
}

function synchronizePartnerMembershipUI(sourceData = experimentData) {
    const synchronized = getSynchronizedExperimentPartners(sourceData);
    populateExperimentPartners(synchronized);

    const legacyContainer = document.getElementById('partners-container');
    if (legacyContainer) {
        legacyContainer.innerHTML = '';
        synchronized.forEach((partner) => addPartnerRow({
            name: partner.name,
            email: partner.email
        }));
    }
}

function synchronizePartnerFieldsForSave(formData) {
    const synchronized = getSynchronizedExperimentPartners(experimentData);
    formData.experimentPartners = synchronized;
    formData.partners = synchronized.map((partner) => ({
        name: partner.name,
        email: partner.email
    }));
}

function canSafelyUsePermissionsV2(sourceData = experimentData, permissions = permissionsUIData) {
    if (Number(sourceData?.permissionsSchemaVersion || 0) >= PERMISSIONS_SCHEMA_VERSION) {
        return true;
    }

    if (!hasLoadedPublicUsers) return false;

    return getLegacyPartnerRecords(sourceData).every((partner) => {
        const normalized = normalizePartnerRecord(partner);
        if (normalized.uid && permissions?.[normalized.uid]) return true;
        const user = findUserForPartner(normalized);
        // A resolvable user that is no longer in `permissions` was explicitly
        // removed in the current UI, so migrating without that user is safe.
        return Boolean(user?.uid);
    });
}

function getPermissionShareEntries(sourceData = experimentData, permissions = permissionsUIData) {
    return Object.entries(permissions || {}).map(([uid, permission]) => ({
        ...getPartnerForPermissionUid(uid, sourceData),
        role: permission?.role === 'viewer' ? 'viewer' : 'editor'
    }));
}

function getPartnerUidsFromData(data) {
    const uids = new Set(Object.keys(
        data?.permissions && typeof data.permissions === 'object'
            ? data.permissions
            : {}
    ));

    getLegacyPartnerRecords(data).forEach((partner) => {
        const normalized = normalizePartnerRecord(partner);
        if (normalized.uid) {
            uids.add(normalized.uid);
            return;
        }
        const user = findUserForPartner(normalized);
        if (user?.uid) uids.add(user.uid);
    });

    return uids;
}

// =========================================
// populatePermissionsUI – runs after loadExperiment
// =========================================
function populatePermissionsUI(data) {
    // --- visibility radios ---
    const vis = data.visibility || 'public';
    const radioPublic  = document.getElementById('visibility-public');
    const radioPrivate = document.getElementById('visibility-private');
    if (radioPublic)  radioPublic.checked  = vis === 'public';
    if (radioPrivate) radioPrivate.checked = vis === 'private';

    // Show/hide panels
    syncVisibilityPanels(vis);

    // --- private-until date ---
    const privateUntilInput = document.getElementById('private-until-date');
    if (privateUntilInput) {
        if (data.privateUntil) {
            const d = data.privateUntil.toDate
                ? data.privateUntil.toDate()
                : new Date(data.privateUntil.seconds * 1000);
            privateUntilInput.value = d.toISOString().slice(0, 10);
        } else {
            privateUntilInput.value = '';
        }
    }

    // --- publicAccess.canWrite ---
    const canWriteChk = document.getElementById('public-can-write');
    if (canWriteChk) {
        canWriteChk.checked = data.publicAccess?.canWrite === true;
        syncPublicWriteWarning(canWriteChk.checked);
    }

    // --- permissions table ---
    // Start from existing permissions map; merge in legacy partners as editors
    permissionsUIData = {};

    if (data.permissions && typeof data.permissions === 'object') {
        Object.entries(data.permissions).forEach(([uid, perm]) => {
            permissionsUIData[uid] = {
                role:    perm.role    || 'viewer',
                addedAt: perm.addedAt || null,
                addedBy: perm.addedBy || 'migration'
            };
        });
    }

    // Legacy: partners array → treat as editors if not already in permissions
    if (Array.isArray(data.partners)) {
        data.partners.forEach(partner => {
            if (!partner.email) return;
            const u = allUsers.find(u => u.email?.toLowerCase() === partner.email?.toLowerCase());
            if (u && u.uid && !permissionsUIData[u.uid]) {
                permissionsUIData[u.uid] = { role: 'editor', addedAt: null, addedBy: 'legacy' };
            }
        });
    }

    // Experiment partners are the same collaboration list for permissions purposes.
    if (Array.isArray(data.experimentPartners)) {
        data.experimentPartners.forEach(partner => {
            const u = findUserForPartner(partner);
            if (u && u.uid && !permissionsUIData[u.uid]) {
                permissionsUIData[u.uid] = { role: 'editor', addedAt: null, addedBy: 'experimentPartners' };
            }
        });
    }

    renderPermissionsTable();
    synchronizePartnerMembershipUI(data);
}

// =========================================
// renderPermissionsTable
// =========================================
function renderPermissionsTable() {
    const tbody = document.getElementById('permissions-table-body');
    const emptyState = document.getElementById('permissions-empty-state');
    if (!tbody) return;

    tbody.innerHTML = '';
    const entries = Object.entries(permissionsUIData);

    if (entries.length === 0) {
        if (emptyState) emptyState.style.display = 'flex';
        return;
    }
    if (emptyState) emptyState.style.display = 'none';

    entries.forEach(([uid, perm]) => {
        const user = allUsers.find(u => u.uid === uid);
        const name  = user?.fullName || user?.email || uid;
        const email = user?.email || '';
        const role  = perm.role || 'viewer';

        const tr = document.createElement('tr');

        // Name
        const tdName = document.createElement('td');
        tdName.textContent = name;
        tr.appendChild(tdName);

        // Email
        const tdEmail = document.createElement('td');
        tdEmail.textContent = email;
        tdEmail.style.direction = 'ltr';
        tdEmail.style.textAlign = 'left';
        tr.appendChild(tdEmail);

        // Role
        const tdRole = document.createElement('td');
        if (permissionsState.canManage) {
            const sel = document.createElement('select');
            sel.className = 'perm-inline-role-select';
            sel.dataset.uid = uid;
            [['viewer', 'צפייה בלבד'], ['editor', 'עריכה']].forEach(([val, label]) => {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = label;
                if (val === role) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.addEventListener('change', () => {
                if (permissionsUIData[uid]) {
                    permissionsUIData[uid].role = sel.value;
                }
                markUserEdited();
            });
            tdRole.appendChild(sel);
        } else {
            const badge = document.createElement('span');
            badge.className = `role-badge badge-${role}`;
            badge.textContent = role === 'editor' ? 'עריכה' : 'צפייה בלבד';
            tdRole.appendChild(badge);
        }
        tr.appendChild(tdRole);

        // Actions
        const tdActions = document.createElement('td');
        if (permissionsState.canManage) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-remove-perm';
            removeBtn.innerHTML = '<i class="fas fa-user-minus"></i> הסרה';
            removeBtn.addEventListener('click', async () => {
                const confirmed = await showConfirmModal({
                    title: 'הסרת שותף',
                    message: `האם להסיר את הגישה של ${name}?`,
                    confirmText: 'הסרה',
                    cancelText: 'ביטול',
                    tone: 'warning'
                });
                if (!confirmed) return;
                delete permissionsUIData[uid];
                renderPermissionsTable();
                synchronizePartnerMembershipUI();
                markUserEdited();
            });
            tdActions.appendChild(removeBtn);
        } else {
            tdActions.textContent = '—';
        }
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
    });
}

// =========================================
// collectPermissionsFromUI
// =========================================
function collectPermissionsFromUI() {
    // Read changes from inline role selects (they already update permissionsUIData on change)
    // Also ensure any pending select values are captured
    document.querySelectorAll('.perm-inline-role-select').forEach(sel => {
        const uid = sel.dataset.uid;
        if (uid && permissionsUIData[uid]) {
            permissionsUIData[uid].role = sel.value;
        }
    });

    // Convert to Firestore-ready format
    const result = {};
    Object.entries(permissionsUIData).forEach(([uid, perm]) => {
        result[uid] = {
            role:    perm.role || 'viewer',
            addedAt: perm.addedAt || Timestamp.now(),
            addedBy: perm.addedBy || currentUser?.uid || 'unknown'
        };
    });
    return result;
}

// =========================================
// getVisibilityFromUI
// =========================================
function getVisibilityFromUI() {
    return document.getElementById('visibility-private')?.checked ? 'private' : 'public';
}

// =========================================
// getPublicAccessFromUI
// =========================================
function getPublicAccessFromUI() {
    return {
        canRead:  true,
        canWrite: false
    };
}

// =========================================
// getPrivateUntilFromUI
// =========================================
function getPrivateUntilFromUI() {
    const vis = getVisibilityFromUI();
    const val = document.getElementById('private-until-date')?.value;
    if (vis === 'private' && val) {
        return Timestamp.fromDate(new Date(val + 'T23:59:59'));
    }
    return null;
}

function hasPrivacyExtensionApproval() {
    return experimentData?.privacyExtensionApproved === true;
}

function getPrivateUntilResearchYearLimit() {
    // TEMPORARY OVERRIDE - privacy cutoff for 2026/2027 research year
    // כרגע מאפשרים פרטיות רגילה עד 30/04/2027 כולל.
    //
    // ROLLBACK after 30/04/2027:
    // אם רוצים לחזור לכלל הרגיל של "עד 30/04 של השנה הנוכחית",
    // החלף את ה-return הפעיל בזה:
    //
    // return new Date(
    //     getTrustedNow().getFullYear(),
    //     3, // April - בחודשי JavaScript ינואר = 0, אפריל = 3
    //     30,
    //     23,
    //     59,
    //     59,
    //     999
    // );

    return new Date(
        2027,
        3, // April - בחודשי JavaScript ינואר = 0, אפריל = 3
        30,
        23,
        59,
        59,
        999
    );
}

function formatDateInputValue(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function formatHebrewDate(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${date.getFullYear()}`;
}

function toDateFromTimestampLike(value) {
    if (!value) return null;
    if (value.toDate) return value.toDate();
    if (value instanceof Date) return value;
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isPrivacyDataSavable(data) {
    if (!data || !('visibility' in data)) return true;

    if (data.visibility === 'public') {
        return !data.privateUntil;
    }

    if (data.visibility !== 'private') return false;

    const privateUntilDate = toDateFromTimestampLike(data.privateUntil);
    if (!privateUntilDate || privateUntilDate <= getTrustedNow()) return false;

    return hasPrivacyExtensionApproval() || privateUntilDate <= getPrivateUntilResearchYearLimit();
}

function isPrivacyDataValidForFirestoreUpdate(data) {
    if (!data || !('visibility' in data)) return true;

    if (data.visibility === 'public') {
        return !data.privateUntil;
    }

    if (data.visibility !== 'private') return false;

    const privateUntilDate = toDateFromTimestampLike(data.privateUntil);
    if (!privateUntilDate) return false;

    return hasPrivacyExtensionApproval() || privateUntilDate <= getPrivateUntilResearchYearLimit();
}

function stripUnsavablePrivacyFields(formData) {
    if (isPrivacyDataSavable(formData)) return false;
    applyPublicPrivacyFallback(formData);
    return true;
}

function blockInvalidPrivacyDateChange(event, message) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    clearAllFieldDots();
    showToast(message, 'warning', 5000);
    // The invalid date has already been cleared from the input. Trigger the
    // normal auto-save so privacy falls back to public and all other edits save.
    markUserEdited();
}

// =========================================
// syncVisibilityPanels – show/hide based on radio
// =========================================
function syncVisibilityPanels(vis) {
    const privatePanel = document.getElementById('private-until-panel');
    const publicPanel  = document.getElementById('public-access-panel');
    if (privatePanel) privatePanel.style.display = vis === 'private' ? 'block' : 'none';
    if (publicPanel)  publicPanel.style.display  = vis === 'public'  ? 'block' : 'none';
}

// =========================================
// syncPublicWriteWarning
// =========================================
function syncPublicWriteWarning(checked) {
    const warning = document.getElementById('public-write-warning');
    if (warning) warning.style.display = checked ? 'flex' : 'none';
}

function applyReadOnlyInteractiveLocks() {
    const isReadOnly = !permissionsState?.canEdit;
    const pickLocationBtn = document.getElementById('pick-location-btn');
    const sharedToggle = document.getElementById('shared-data-toggle');

    document.querySelectorAll('.study-type-option').forEach((button) => {
        button.disabled = isReadOnly;
    });

    if (pickLocationBtn) {
        pickLocationBtn.disabled = isReadOnly || getCurrentStudyType() === 'lab';
    }

    if (sharedToggle) {
        sharedToggle.disabled = isReadOnly;
    }
}

// =========================================
// applyPermissions – called after loadExperiment
// =========================================
function applyPermissions() {
    const section = document.getElementById('permissions-section');
    const form    = document.getElementById('experiment-form');
    const viewerNotice = document.getElementById('viewer-notice');
    const addArea = document.getElementById('add-permission-partner-area');

    const role = permissionsState.role;

    // Populate the new permissions UI
    populatePermissionsUI(experimentData);

    // --- Viewer: show notice, lock form ---
    if (!permissionsState.canEdit) {
        if (viewerNotice) viewerNotice.style.display = 'flex';
        if (form) form.classList.add('readonly-mode');
    } else {
        if (viewerNotice) viewerNotice.style.display = 'none';
        if (form) form.classList.remove('readonly-mode');
    }

    applyReadOnlyInteractiveLocks();

    // --- Not manager: lock permissions section ---
    const privateUntilInput = document.getElementById('private-until-date');
    const canWriteChk = document.getElementById('public-can-write');
    if (!permissionsState.canManage) {
        if (section) section.classList.add('locked');
        if (addArea) addArea.style.display = 'none';
        // Disable visibility radios
        document.querySelectorAll('input[name="experiment-visibility"]').forEach(r => r.disabled = true);
        if (privateUntilInput) privateUntilInput.disabled = true;
        if (canWriteChk) canWriteChk.disabled = true;
    } else {
        if (section) section.classList.remove('locked');
        if (addArea) addArea.style.display = 'flex';
        document.querySelectorAll('input[name="experiment-visibility"]').forEach(r => r.disabled = false);
        if (privateUntilInput) privateUntilInput.disabled = false;
        if (canWriteChk) canWriteChk.disabled = false;
    }

    // Hide save button for viewers (just in case readonly-mode isn't enough)
    const saveBtns = document.querySelectorAll('.btn-save, [id="btn-save-experiment"]');
    saveBtns.forEach(btn => {
        btn.style.display = permissionsState.canEdit ? '' : 'none';
    });
}

// =========================================
// initPermissionsUI – event listeners for permission section
// =========================================
function initPermissionsUI() {
    // Toggle header
    const toggleBtn = document.getElementById('permissions-toggle-btn');
    const toggleContent = document.getElementById('permissions-section-content');
    const permissionsSection = document.getElementById('permissions-section');
    
    if (toggleBtn && toggleContent && permissionsSection) {
        toggleBtn.addEventListener('click', () => {
            const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
            toggleBtn.setAttribute('aria-expanded', !isExpanded);
            
            if (isExpanded) {
                toggleContent.style.display = 'none';
                permissionsSection.classList.remove('is-open');
            } else {
                toggleContent.style.display = 'block';
                permissionsSection.classList.add('is-open');
            }
        });
    }

    // Visibility radios
    document.querySelectorAll('input[name="experiment-visibility"]').forEach(radio => {
        radio.addEventListener('change', (event) => {
            if (ignoreUnauthorizedAccessManagementChange(radio, event)) return;

            if (radio.value === 'private') {
                const privateUntilInput = document.getElementById('private-until-date');
                if (privateUntilInput && !privateUntilInput.value) {
                    privateUntilInput.value = formatDateInputValue(getTrustedNow());
                }
                hasShownPrivacyFallbackToast = false;
            }

            syncVisibilityPanels(radio.value);
            markUserEdited();
        });
    });

    // Public-can-write checkbox
    const canWriteChk = document.getElementById('public-can-write');
    if (canWriteChk) {
        canWriteChk.addEventListener('change', (event) => {
            if (ignoreUnauthorizedAccessManagementChange(canWriteChk, event)) return;
            syncPublicWriteWarning(canWriteChk.checked);
            markUserEdited();
        });
    }

    // Autocomplete for permission partner search
    const searchInput = document.getElementById('permission-partner-search');
    const suggestionsDiv = document.getElementById('permission-partner-suggestions');

    if (searchInput && suggestionsDiv) {
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim().toLowerCase();
            suggestionsDiv.innerHTML = '';
            selectedPermissionUser = null;

            if (!query || query.length < 2) {
                suggestionsDiv.classList.remove('active');
                return;
            }

            const filtered = allUsers.filter(u => {
                const alreadyAdded = !!permissionsUIData[u.uid];
                const isOwner = u.uid === experimentOwnerUid;
                const matchQuery = (u.fullName?.toLowerCase().includes(query) ||
                                   u.email?.toLowerCase().includes(query));
                return matchQuery && !alreadyAdded && !isOwner;
            }).slice(0, 8);

            if (!filtered.length) {
                suggestionsDiv.classList.remove('active');
                return;
            }

            filtered.forEach(u => {
                const item = document.createElement('div');
                item.className = 'suggestion-item';
                item.innerHTML = `
                    <div class="suggestion-name">${u.fullName || '—'}</div>
                    <div class="suggestion-email">${u.email || ''}</div>
                `;
                item.addEventListener('click', () => {
                    selectedPermissionUser = u;
                    searchInput.value = u.fullName || u.email || '';
                    suggestionsDiv.innerHTML = '';
                    suggestionsDiv.classList.remove('active');
                });
                suggestionsDiv.appendChild(item);
            });

            suggestionsDiv.classList.add('active');
        });

        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !suggestionsDiv.contains(e.target)) {
                suggestionsDiv.classList.remove('active');
            }
        });
    }

    // Add permission partner button
    const addBtn = document.getElementById('add-permission-partner-btn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            if (!selectedPermissionUser) {
                showToast('יש לבחור משתמש מהרשימה', 'warning');
                return;
            }
            const roleSelect = document.getElementById('permission-role-select');
            const role = roleSelect?.value || 'viewer';
            const uid = selectedPermissionUser.uid;

            if (permissionsUIData[uid]) {
                showToast('המשתמש כבר נמצא ברשימה', 'warning');
                return;
            }

            permissionsUIData[uid] = {
                role,
                addedAt: Timestamp.now(),
                addedBy: currentUser?.uid || 'unknown'
            };

            const addedName = selectedPermissionUser.fullName || selectedPermissionUser.email || 'שותף';

            renderPermissionsTable();
            synchronizePartnerMembershipUI();
            markUserEdited();

            // Reset search
            if (searchInput) searchInput.value = '';
            selectedPermissionUser = null;
            if (suggestionsDiv) {
                suggestionsDiv.innerHTML = '';
                suggestionsDiv.classList.remove('active');
            }

            showToast(`${addedName} נוסף כ${role === 'editor' ? 'עורך' : 'צופה'}`, 'success');
        });
    }
}

// =========================================
// Sync Shared Experiments
// =========================================

async function syncSharedExperiments(currentPartners, latestExperimentData = null) {
    // רק הבעלים המקורי יכול לסנכרן שותפים
    if (experimentOwnerUid !== currentUser.uid) return { added: 0, removed: 0 };

    let addedCount = 0;
    let removedCount = 0;

    try {
        const currentPartnerUids = new Set();

        for (const partner of currentPartners) {
            const normalized = normalizePartnerRecord(partner);
            const partnerUser = normalized.uid
                ? allUsers.find(user => user.uid === normalized.uid)
                : findUserForPartner(normalized);
            const partnerUid = normalized.uid || partnerUser?.uid || '';
            if (!partnerUid || partnerUid === currentUser.uid) continue;

            const role = partner.role === 'viewer' ? 'viewer' : 'editor';
            currentPartnerUids.add(partnerUid);

            const cachedExperiment = {
                experimentName: latestExperimentData?.experimentName ?? experimentData?.experimentName ?? '',
                leadResearchers: normalizeLeadResearchers(latestExperimentData || experimentData),
                externalLeadResearchers: normalizeExternalLeadResearchers(latestExperimentData || experimentData),
                experimentYear: latestExperimentData?.experimentYear ?? experimentData?.experimentYear ?? '',
                experimentSite: latestExperimentData?.experimentSite ?? experimentData?.experimentSite ?? '',
                siteCoordinates: latestExperimentData?.siteCoordinates ?? experimentData?.siteCoordinates ?? '',
                workPackage: latestExperimentData?.workPackage ?? experimentData?.workPackage ?? '',
                keywords: Array.isArray(latestExperimentData?.keywords)
                    ? latestExperimentData.keywords
                    : (Array.isArray(experimentData?.keywords) ? experimentData.keywords : []),
                cropDetails: latestExperimentData?.cropDetails ?? experimentData?.cropDetails ?? null,
                permissionsSchemaVersion: Number(
                    latestExperimentData?.permissionsSchemaVersion
                    || experimentData?.permissionsSchemaVersion
                    || 1
                ),
                permissions: {
                    [partnerUid]: { role }
                },
                createdAt: experimentData?.createdAt || null,
                updatedAt: serverTimestamp()
            };

            const sharedRef = doc(db, "users", partnerUid, "sharedExperiments", currentExperimentId);
            await setDoc(sharedRef, {
                experimentId: currentExperimentId,
                ownerUid: currentUser.uid,
                ownerEmail: currentUser.email,
                role,
                addedAt: serverTimestamp(),
                cachedExperiment
            }, { merge: true });

            addedCount++;
        }

        // While an experiment is still in compatibility mode, unresolved
        // historic members remain current so their legacy pointer is not
        // deleted accidentally.
        if (Number(latestExperimentData?.permissionsSchemaVersion || 0) < PERMISSIONS_SCHEMA_VERSION) {
            getPartnerUidsFromData(latestExperimentData).forEach(uid => currentPartnerUids.add(uid));
        }

        // Compare against every historic representation, not only `partners`.
        const previousPartnerUids = getPartnerUidsFromData(experimentData);
        for (const oldPartnerUid of previousPartnerUids) {
            if (!oldPartnerUid || currentPartnerUids.has(oldPartnerUid)) continue;

            const sharedRef = doc(db, "users", oldPartnerUid, "sharedExperiments", currentExperimentId);
            try {
                await deleteDoc(sharedRef);
                removedCount++;
            } catch (error) {
                console.warn(`Could not remove stale shared experiment for ${oldPartnerUid}`, error);
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
    initBrowserNavigationGuard();
    initTreatmentTabsScroller();

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
        form.setAttribute('novalidate', 'novalidate');
        form.addEventListener('input', (e) => {
            if (ignoreUnauthorizedAccessManagementChange(e.target, e)) return;
            trackFieldEdit(e.target);
            markUserEdited();
        });
        form.addEventListener('change', (e) => {
            if (ignoreUnauthorizedAccessManagementChange(e.target, e)) return;
            trackFieldEdit(e.target);
            markUserEdited();
        });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (experimentAI?.isActive()) await experimentAI.saveCurrentPage();
            else await performAutoSave();
        });
    }

    window.addEventListener('scroll', schedulePersistNavigationState, { passive: true });
    window.addEventListener('beforeunload', persistNavigationState);
    window.addEventListener('beforeunload', (event) => {
        // Block navigation if there are unsaved changes or active save
        if (hasUserEditedSinceSave || autoSaveInProgress || autoSaveTimeoutId) {
            event.preventDefault();
            event.returnValue = 'יש שינויים שטרם נשמרו. האם אתה בטוח שברצונך לעזוב?';
            return event.returnValue;
        }
    });


    // Treatment count change
    const treatmentsCount = document.getElementById('treatments-count');
    if (treatmentsCount) {
        treatmentsCount.addEventListener('change', () => {
            persistCurrentSectionDataToState();
            const count = parseInt(treatmentsCount.value) || 0;
            const existingTreatments = collectTreatmentInputsFromDOM();
            generateTreatmentInputs(count, existingTreatments, getCurrentRepetitionsCount());
            syncAllSectionTreatmentCounts();
            currentTreatmentIndex = Math.max(0, Math.min(currentTreatmentIndex, Math.max(count - 1, 0)));
            generateTreatmentTabs();
            loadCurrentSectionDataFromState();
        });
    }

    const repetitionsCount = document.getElementById('repetitions-count');
    if (repetitionsCount) {
        repetitionsCount.addEventListener('change', () => {
            persistCurrentSectionDataToState();
            const existingTreatments = collectTreatmentInputsFromDOM();
            const rawValue = parseInt(repetitionsCount.value);
            const clampedRepetitionsCount = Math.min(MAX_REPETITIONS_PER_TREATMENT, Math.max(1, rawValue || 0));
            if (Number.isFinite(rawValue) && rawValue > MAX_REPETITIONS_PER_TREATMENT) {
                showToast(`המספר הוגבל ל־${MAX_REPETITIONS_PER_TREATMENT} כדי למנוע עומס על הדפדפן`, 'warning');
            }
            repetitionsCount.value = String(clampedRepetitionsCount);
            generateTreatmentInputs(getCurrentTreatmentsCount(), existingTreatments, clampedRepetitionsCount);
        });
    }

    const sharedToggle = document.getElementById('shared-data-toggle');
    if (sharedToggle) {
        sharedToggle.addEventListener('change', async () => {
            if (isSyncingSharedToggle) return;

            const sectionId = getSectionIdByView();
            if (!sectionId) return;

            persistCurrentSectionDataToState();

            const model = getSectionModel(sectionId);
            const targetShared = sharedToggle.checked;

            if (model?.shared === false && targetShared === true) {
                const confirmed = await showConfirmModal({
                    title: 'אישור הפעלת נתונים זהים',
                    message: 'שימו לב: הפעלת מצב "נתונים זהים לכלל הטיפולים" תדרוס נתונים ייחודיים בטיפולים האחרים ותחליף אותם בנתוני טיפול 1.\nהשינוי יישמר אוטומטית. האם להמשיך?',
                    confirmText: 'כן, להמשיך',
                    cancelText: 'ביטול',
                    tone: 'warning'
                });
                if (!confirmed) {
                    isSyncingSharedToggle = true;
                    sharedToggle.checked = false;
                    isSyncingSharedToggle = false;
                    return;
                }
            }

           setSectionSharedState(sectionId, targetShared);
            loadCurrentSectionDataFromState();
            syncSharedToggleForCurrentView();
            markUserEdited();
            await alertDeferredChange('השינוי במצב "נתונים זהים לכלל הטיפולים"');
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
    const keywordInput = document.getElementById('keyword-input');
    const keywordsSelect = document.getElementById('keywords-select');
    const customKeywordContainer = document.getElementById('custom-keyword-container');
    const customKeywordInput = document.getElementById('custom-keyword-input');
    const addCustomKeyword = document.getElementById('add-custom-keyword');
    const cancelCustomKeyword = document.getElementById('cancel-custom-keyword');

    if (addKeyword && keywordInput) {
        addKeyword.addEventListener('click', () => {
            const value = keywordInput.value.trim();
            if (!value) return;
            addKeywordTag(value);
            keywordInput.value = '';
        });

        keywordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addKeyword.click();
            }
        });
    } else if (addKeyword && keywordsSelect) {
        addKeyword.addEventListener('click', () => {
            if (keywordsSelect.value === '__custom__') {
                // Show custom input field
                if (customKeywordContainer) {
                    customKeywordContainer.style.display = 'flex';
                    if (customKeywordInput) customKeywordInput.focus();
                }
                keywordsSelect.value = '';
            } else if (keywordsSelect.value) {
                addKeywordTag(keywordsSelect.value);
                keywordsSelect.value = '';
            }
        });
    }

    // Add custom keyword from free text input
    if (addCustomKeyword && customKeywordInput) {
        addCustomKeyword.addEventListener('click', () => {
            const val = customKeywordInput.value.trim();
            if (val) {
                addKeywordTag(val);
                customKeywordInput.value = '';
                if (customKeywordContainer) customKeywordContainer.style.display = 'none';
            }
        });

        // Also support Enter key
        customKeywordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addCustomKeyword.click();
            }
        });
    }

    // Cancel custom keyword input
    if (cancelCustomKeyword && customKeywordContainer) {
        cancelCustomKeyword.addEventListener('click', () => {
            if (customKeywordInput) customKeywordInput.value = '';
            customKeywordContainer.style.display = 'none';
        });
    }

    const addVarietyBtn = document.getElementById('add-variety');
    const varietyInput = document.getElementById('variety-input');
    if (addVarietyBtn && varietyInput) {
        addVarietyBtn.addEventListener('click', () => {
            const value = varietyInput.value.trim();
            if (!value) return;
            addVarietyTag(value);
            varietyInput.value = '';
        });
        varietyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addVarietyBtn.click();
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
            requestViewSwitch(item.dataset.view);
        });
    });

    document.querySelectorAll('.sub-item[data-view]').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            requestViewSwitch(item.dataset.view);
        });
    });

    document.querySelectorAll('.sidebar-nav a[href]:not([href="#"])').forEach(link => {
        link.addEventListener('click', async (e) => {
            const targetHref = link.getAttribute('href');
            if (!targetHref) return;

            e.preventDefault();
            // Auto-save: flush pending changes before leaving page
            await flushAutoSave();

            persistNavigationState(true);
            window.location.href = targetHref;
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
            // Auto-save: flush pending changes before logout
            await flushAutoSave();

            await signOut(auth);
            window.location.href = "login.html";
        });
    }

    // Copy Experiment ID
    const copyIdBtn = document.getElementById('copy-experiment-id-btn');
    if (copyIdBtn) {
        copyIdBtn.addEventListener('click', async () => {
            const experimentIdInput = document.getElementById('experiment-id');
            const experimentPath = getExperimentDocumentPath() || experimentIdInput?.value;
            
            if (!experimentPath || experimentPath === '—') {
                showToast('אין נתיב ניסוי להעתקה', 'warning');
                return;
            }

            try {
                await navigator.clipboard.writeText(experimentPath);
                
                // Visual feedback
                copyIdBtn.classList.add('copied');
                
                showToast('נתיב הניסוי הועתק ללוח', 'success');
                
                // Reset button after 2 seconds
                setTimeout(() => {
                    copyIdBtn.classList.remove('copied');
                }, 2000);
            } catch (err) {
                console.error('Failed to copy:', err);
                showToast('שגיאה בהעתקת נתיב הניסוי', 'error');
            }
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
            if (!permissionsState?.canEdit) return;
            const target = document.getElementById(btn.dataset.target);
            if (target) target.focus();
        });
    });

    document.getElementById('experiment-site')?.addEventListener('change', () => {
        updateExperimentSiteOtherVisibility();
        markUserEdited();
    });
    document.getElementById('experiment-year')?.addEventListener('change', enforcePrivateUntilDateMax);
    document.getElementById('study-type')?.addEventListener('change', () => {
        updateStudyTypeVisibility();
        markUserEdited();
    });
    document.querySelectorAll('.study-type-option').forEach((button) => {
        button.addEventListener('click', () => {
            const selectedType = button.dataset.studyType;
            if (!selectedType) return;
            setStudyTypeValue(selectedType);
            updateStudyTypeVisibility();
            markUserEdited();
        });
    });
    document.getElementById('grafted-plant')?.addEventListener('change', updatePreparationNameVisibility);
    document.getElementById('cell-temp-mode')?.addEventListener('change', updateStructureTemperatureVisibility);
    document.getElementById('drip-irrigations-per-day')?.addEventListener('change', updateDripIrrigationTimesCount);
    document.getElementById('detached-substrate')?.addEventListener('change', updateDetachedSubstrateVisibility);
    document.getElementById('soil-disinfection-adigan')?.addEventListener('change', updateAdiganAmountVisibility);
    document.getElementById('soil-adigan-amount')?.addEventListener('change', updateAdiganAmountVisibility);

    updateConditionalFieldVisibility();

    // Partners Autocomplete - נקרא אחרי טעינת הניסוי ב-loadExperiment
    // initPartnersAutocomplete();

    // Permissions UI event listeners
    initPermissionsUI();
}

// =========================================
// OpenStreetMap Location Picker (Leaflet - Free!)
// =========================================
let map = null;
let marker = null;
let selectedLocation = null;
let locationSearchDebounceId = null;
let locationSearchAbortController = null;

function initLocationPicker() {
    const pickLocationBtn = document.getElementById('pick-location-btn');
    const openGoogleMapsBtn = document.getElementById('open-google-maps-btn');
    const modal = document.getElementById('location-picker-modal');
    const closeBtn = document.getElementById('close-location-modal');
    const cancelBtn = document.getElementById('cancel-location');
    const confirmBtn = document.getElementById('confirm-location');
    const coordsInput = document.getElementById('site-coordinates');
    const searchInput = document.getElementById('location-search-input');
    const searchBtn = document.getElementById('location-search-btn');
    const currentBtn = document.getElementById('location-current-btn');
    const suggestionsContainer = document.getElementById('location-search-suggestions');

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

    if (searchBtn) {
        searchBtn.addEventListener('click', () => searchLocationFromInput());
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim();
            if (locationSearchDebounceId) {
                clearTimeout(locationSearchDebounceId);
            }

            if (query.length < 2) {
                hideLocationSuggestions();
                return;
            }

            locationSearchDebounceId = setTimeout(() => {
                showLocationAutocomplete(query);
            }, 300);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchLocationFromInput();
            }
        });
    }

    if (currentBtn) {
        currentBtn.addEventListener('click', () => setCurrentLocationOnMap());
    }

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

    document.addEventListener('click', (e) => {
        if (!suggestionsContainer || !searchInput) return;
        const clickedInsideSuggestions = suggestionsContainer.contains(e.target);
        const clickedSearchInput = searchInput.contains(e.target);
        if (!clickedInsideSuggestions && !clickedSearchInput) {
            hideLocationSuggestions();
        }
    });

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
    updateLocationSearchStatus('');
    hideLocationSuggestions();

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

    marker.bindPopup('גרירה או לחיצה על המפה').openPopup();

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

function updateLocationSearchStatus(message = '', type = 'info') {
    const statusEl = document.getElementById('location-search-status');
    if (!statusEl) return;

    statusEl.textContent = message;
    if (!message) {
        statusEl.style.color = '#666';
        return;
    }

    if (type === 'error') {
        statusEl.style.color = '#dc2626';
    } else if (type === 'success') {
        statusEl.style.color = '#15803d';
    } else {
        statusEl.style.color = '#666';
    }
}

function hideLocationSuggestions() {
    const suggestionsContainer = document.getElementById('location-search-suggestions');
    if (!suggestionsContainer) return;
    suggestionsContainer.style.display = 'none';
    suggestionsContainer.innerHTML = '';
}

function renderLocationSuggestions(results) {
    const suggestionsContainer = document.getElementById('location-search-suggestions');
    if (!suggestionsContainer) return;

    suggestionsContainer.innerHTML = '';
    if (!Array.isArray(results) || results.length === 0) {
        hideLocationSuggestions();
        return;
    }

    results.forEach((result) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.style.width = '100%';
        item.style.textAlign = 'right';
        item.style.padding = '8px 10px';
        item.style.border = 'none';
        item.style.borderBottom = '1px solid #f1f5f9';
        item.style.background = '#fff';
        item.style.cursor = 'pointer';
        item.style.fontSize = '13px';
        item.textContent = result.display_name || `${result.lat}, ${result.lon}`;

        item.addEventListener('mouseenter', () => {
            item.style.background = '#f8fafc';
        });
        item.addEventListener('mouseleave', () => {
            item.style.background = '#fff';
        });
        item.addEventListener('click', () => {
            const searchInput = document.getElementById('location-search-input');
            if (searchInput) searchInput.value = result.display_name || '';
            setSelectedLocationOnMap(result.lat, result.lon);
            hideLocationSuggestions();
            updateLocationSearchStatus(`נבחר: ${result.display_name}`, 'success');
        });

        suggestionsContainer.appendChild(item);
    });

    const lastChild = suggestionsContainer.lastElementChild;
    if (lastChild) {
        lastChild.style.borderBottom = 'none';
    }

    suggestionsContainer.style.display = 'block';
}

async function fetchLocationSearchResults(query, limit = 5) {
    if (locationSearchAbortController) {
        locationSearchAbortController.abort();
    }

    locationSearchAbortController = new AbortController();
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
        signal: locationSearchAbortController.signal,
        headers: {
            'Accept': 'application/json',
            'Accept-Language': 'he'
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const results = await response.json();
    return Array.isArray(results) ? results : [];
}

async function showLocationAutocomplete(query) {
    try {
        const results = await fetchLocationSearchResults(query, 5);
        renderLocationSuggestions(results);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Location autocomplete failed:', error);
        hideLocationSuggestions();
    }
}

function setSelectedLocationOnMap(lat, lng, zoom = 15) {
    if (!map || !marker) {
        showToast('המפה עדיין בטעינה, נסה שוב בעוד רגע', 'warning');
        return;
    }

    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return;

    const position = L.latLng(parsedLat, parsedLng);
    marker.setLatLng(position);
    map.setView(position, zoom);
    selectedLocation = { lat: parsedLat, lng: parsedLng };
    updateSelectedCoordinates(selectedLocation);
}

async function searchLocationFromInput() {
    const searchInput = document.getElementById('location-search-input');
    const query = searchInput?.value.trim();

    if (!query) {
        updateLocationSearchStatus('יש להזין טקסט לחיפוש.', 'error');
        return;
    }

    if (!map || !marker) {
        updateLocationSearchStatus('המפה עדיין בטעינה, נסה שוב בעוד רגע.', 'error');
        return;
    }

    updateLocationSearchStatus('מחפש מיקום...');
    hideLocationSuggestions();

    try {
        const results = await fetchLocationSearchResults(query, 1);
        if (!Array.isArray(results) || results.length === 0) {
            updateLocationSearchStatus('לא נמצאו תוצאות לחיפוש.', 'error');
            return;
        }

        const result = results[0];
        setSelectedLocationOnMap(result.lat, result.lon);
        updateLocationSearchStatus(`נמצא: ${result.display_name}`, 'success');
    } catch (error) {
        console.error('Location search failed:', error);
        updateLocationSearchStatus('חיפוש נכשל. נסה שוב בעוד רגע.', 'error');
    }
}

function setCurrentLocationOnMap() {
    if (!navigator.geolocation) {
        updateLocationSearchStatus('הדפדפן לא תומך בזיהוי מיקום.', 'error');
        return;
    }

    if (!map || !marker) {
        updateLocationSearchStatus('המפה עדיין בטעינה, נסה שוב בעוד רגע.', 'error');
        return;
    }

    updateLocationSearchStatus('מאתר את המיקום הנוכחי...');

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            setSelectedLocationOnMap(latitude, longitude);
            updateLocationSearchStatus('המיקום הנוכחי עודכן בהצלחה.', 'success');
        },
        (error) => {
            console.error('Geolocation failed:', error);
            updateLocationSearchStatus('לא ניתן לאתר את המיקום הנוכחי. בדוק הרשאות מיקום בדפדפן.', 'error');
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        }
    );
}

function confirmLocation() {
    if (selectedLocation) {
        const coordsInput = document.getElementById('site-coordinates');
        if (coordsInput) {
            coordsInput.value = `${selectedLocation.lat.toFixed(6)}, ${selectedLocation.lng.toFixed(6)}`;
            // Trigger change event to update Google Maps button
            coordsInput.dispatchEvent(new Event('change'));
            // Trigger auto-save
            markUserEdited();
        }
        closeLocationModal();
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
// Experiment Partners (multi-select chips)
// =========================================
let selectedExperimentPartner = null;

function findUserForPartner(partner = {}) {
    if (!partner || typeof partner !== 'object') return null;
    const partnerUid = partner.uid || '';
    const partnerEmail = partner.email || '';

    return allUsers.find(u => {
        if (partnerUid && u.uid === partnerUid) return true;
        return partnerEmail && u.email?.toLowerCase() === partnerEmail.toLowerCase();
    }) || null;
}

function canManageExperimentPartnersPermissions() {
    return permissionsState?.canManage ||
        (currentUser && experimentOwnerUid && currentUser.uid === experimentOwnerUid);
}

function syncExperimentPartnerToPermissions(partner, shouldRender = true) {
    if (!canManageExperimentPartnersPermissions()) return;

    const user = findUserForPartner(partner);
    if (!user?.uid || user.uid === experimentOwnerUid) return;
    if (permissionsUIData[user.uid]) return;

    permissionsUIData[user.uid] = {
        role: 'editor',
        addedAt: Timestamp.now(),
        addedBy: 'experimentPartners'
    };

    if (shouldRender) renderPermissionsTable();
}

function removeExperimentPartnerFromPermissions(partner, shouldRender = true) {
    if (!canManageExperimentPartnersPermissions()) return;

    const user = findUserForPartner(partner);
    if (!user?.uid) return;

    delete permissionsUIData[user.uid];
    if (shouldRender) {
        renderPermissionsTable();
        synchronizePartnerMembershipUI();
    }
}

function populateExperimentPartners(experimentPartners = []) {
    const listContainer = document.getElementById('experiment-partners-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    (experimentPartners || []).forEach(partner => {
        addExperimentPartnerChip(partner);
    });
}

function addExperimentPartnerChip(partnerData) {
    const listContainer = document.getElementById('experiment-partners-list');
    if (!listContainer) return;

    let name = '', email = '', uid = '';
    if (typeof partnerData === 'string') {
        name = partnerData;
    } else if (partnerData && typeof partnerData === 'object') {
        name = partnerData.name || '';
        email = partnerData.email || '';
        uid = partnerData.uid || '';
    }

    // Check for duplicate
    const existingChips = listContainer.querySelectorAll('.experiment-partner-chip');
    for (const chip of existingChips) {
        if (email && chip.dataset.email?.toLowerCase() === email.toLowerCase()) return;
        if (uid && chip.dataset.uid === uid) return;
    }

    const chip = document.createElement('span');
    chip.className = 'experiment-partner-chip';
    chip.dataset.email = email;
    chip.dataset.uid = uid;
    chip.dataset.name = name;

    const isOwner = currentUser && experimentOwnerUid && currentUser.uid === experimentOwnerUid;

    chip.innerHTML = `
        <span class="chip-name">${name || email || '\u05dc\u05d0 \u05e6\u05d5\u05d9\u05df'}</span>
        ${email ? `<span style="font-size:11px; color:#7889a4;">(${email})</span>` : ''}
        <button type="button" class="chip-remove ${isOwner ? '' : 'disabled'}" title="${isOwner ? '\u05d4\u05e1\u05e8\u05ea \u05e9\u05d5\u05ea\u05e3' : '\u05e8\u05e7 \u05de\u05e7\u05d9\u05dd \u05d4\u05e0\u05d9\u05e1\u05d5\u05d9 \u05d9\u05db\u05d5\u05dc \u05dc\u05d4\u05e1\u05d9\u05e8 \u05e9\u05d5\u05ea\u05e4\u05d9\u05dd'}">
            <i class="fas fa-times"></i>
        </button>
    `;

    const removeBtn = chip.querySelector('.chip-remove');
    if (isOwner && removeBtn) {
        removeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!(await confirmDeferredDeletion('\u05d4\u05e9\u05d5\u05ea\u05e3'))) return;
            removeExperimentPartnerFromPermissions({ name, email, uid });
            if (chip.isConnected) chip.remove();
            markUserEdited();
        });
    }

    listContainer.appendChild(chip);
}

function collectExperimentPartners() {
    const listContainer = document.getElementById('experiment-partners-list');
    if (!listContainer) return [];

    const partners = [];
    listContainer.querySelectorAll('.experiment-partner-chip').forEach(chip => {
        const name = chip.dataset.name || '';
        const email = chip.dataset.email || '';
        const uid = chip.dataset.uid || '';
        if (name || email) {
            partners.push({ name, email, uid });
        }
    });
    return partners;
}

function populateLeadResearchers(data = {}) {
    const listContainer = document.getElementById('lead-researchers-list');
    if (!listContainer) return;
    listContainer.replaceChildren();

    normalizeLeadResearchers(data).forEach((researcher) => {
        addLeadResearcherChip(researcher, false);
    });
    normalizeExternalLeadResearchers(data).forEach((researcherName) => {
        addExternalLeadResearcherChip(researcherName, false);
    });
}

function addLeadResearcherChip(researcherData, markEdited = true) {
    const listContainer = document.getElementById('lead-researchers-list');
    const researcher = normalizeLeadResearchers([researcherData])[0];
    if (!listContainer || !researcher) return false;

    const existing = listContainer.querySelector(`[data-uid="${CSS.escape(researcher.uid)}"]`);
    if (existing) return false;
    if (listContainer.querySelectorAll('.lead-researcher-chip').length >= MAX_LEAD_RESEARCHERS) {
        showToast(`ניתן לבחור עד ${MAX_LEAD_RESEARCHERS} חוקרים מובילים`, 'warning');
        return false;
    }

    const chip = document.createElement('span');
    chip.className = 'experiment-partner-chip lead-researcher-chip';
    chip.dataset.uid = researcher.uid;
    chip.dataset.name = researcher.name;
    chip.dataset.email = researcher.email;

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = researcher.name || researcher.email || researcher.uid;
    chip.appendChild(name);

    if (researcher.email) {
        const email = document.createElement('span');
        email.className = 'chip-email';
        email.style.fontSize = '11px';
        email.style.color = '#7889a4';
        email.textContent = `(${researcher.email})`;
        chip.appendChild(email);
    }

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'chip-remove';
    removeButton.title = 'הסרת חוקר מוביל';
    removeButton.setAttribute('aria-label', `הסרת ${researcher.name || researcher.email}`);
    removeButton.innerHTML = '<i class="fas fa-times" aria-hidden="true"></i>';
    removeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!permissionsState?.canEdit) {
            showToast('אין הרשאת עריכה', 'error');
            return;
        }
        chip.remove();
        markUserEdited();
    });
    chip.appendChild(removeButton);
    listContainer.appendChild(chip);

    if (markEdited) markUserEdited();
    return true;
}

function collectLeadResearchers() {
    const listContainer = document.getElementById('lead-researchers-list');
    if (!listContainer) return [];
    const researchers = Array.from(listContainer.querySelectorAll('.lead-researcher-chip:not(.external-lead-researcher-chip)')).map((chip) => ({
        uid: chip.dataset.uid || '',
        name: chip.dataset.name || '',
        email: chip.dataset.email || ''
    }));
    return normalizeLeadResearchers(researchers);
}

function addExternalLeadResearcherChip(researcherName, markEdited = true) {
    const listContainer = document.getElementById('lead-researchers-list');
    const name = normalizeExternalLeadResearchers(researcherName)[0];
    if (!listContainer || !name) return false;

    const normalizedName = normalizeLeadResearcherValue(name);
    const exists = collectExternalLeadResearchers()
        .some((existingName) => normalizeLeadResearcherValue(existingName) === normalizedName);
    if (exists) return false;
    if (listContainer.querySelectorAll('.lead-researcher-chip').length >= MAX_LEAD_RESEARCHERS) {
        showToast(`ניתן לבחור עד ${MAX_LEAD_RESEARCHERS} חוקרים מובילים`, 'warning');
        return false;
    }

    const chip = document.createElement('span');
    chip.className = 'experiment-partner-chip lead-researcher-chip external-lead-researcher-chip';
    chip.dataset.externalName = name;

    const nameElement = document.createElement('span');
    nameElement.className = 'chip-name';
    nameElement.textContent = name;
    chip.appendChild(nameElement);

    const badge = document.createElement('span');
    badge.className = 'external-researcher-badge';
    badge.textContent = '(משתמש לא רשום במערכת)';
    chip.appendChild(badge);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'chip-remove';
    removeButton.title = 'הסרת חוקר מוביל חיצוני';
    removeButton.setAttribute('aria-label', `הסרת ${name}`);
    removeButton.innerHTML = '<i class="fas fa-times" aria-hidden="true"></i>';
    removeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!permissionsState?.canEdit) {
            showToast('אין הרשאת עריכה', 'error');
            return;
        }
        chip.remove();
        markUserEdited();
    });
    chip.appendChild(removeButton);
    listContainer.appendChild(chip);

    if (markEdited) markUserEdited();
    return true;
}

function collectExternalLeadResearchers() {
    const listContainer = document.getElementById('lead-researchers-list');
    if (!listContainer) return [];
    return normalizeExternalLeadResearchers(
        Array.from(listContainer.querySelectorAll('.external-lead-researcher-chip'))
            .map((chip) => chip.dataset.externalName || '')
    );
}

function normalizeLeadResearcherValue(value) {
    return String(value || '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase('he');
}

function getExternalLeadResearcherCandidates(rawValue) {
    if (!hasLoadedPublicUsers) return [];
    const registeredValues = new Set();
    allUsers.forEach((user) => {
        [user.fullName, user.email].forEach((value) => {
            const normalized = normalizeLeadResearcherValue(value);
            if (normalized) registeredValues.add(normalized);
        });
    });
    const selectedExternal = new Set(
        collectExternalLeadResearchers().map(normalizeLeadResearcherValue)
    );

    return normalizeExternalLeadResearchers(rawValue).filter((name) => {
        const normalized = normalizeLeadResearcherValue(name);
        return normalized.length >= 2
            && !registeredValues.has(normalized)
            && !selectedExternal.has(normalized);
    });
}

function addExternalLeadResearchers(names) {
    const listContainer = document.getElementById('lead-researchers-list');
    if (!listContainer) return 0;
    const normalizedNames = normalizeExternalLeadResearchers(names);
    const availableSlots = Math.max(
        0,
        MAX_LEAD_RESEARCHERS - listContainer.querySelectorAll('.lead-researcher-chip').length
    );
    if (availableSlots === 0) {
        showToast(`ניתן לבחור עד ${MAX_LEAD_RESEARCHERS} חוקרים מובילים`, 'warning');
        return 0;
    }

    let addedCount = 0;
    normalizedNames.slice(0, availableSlots).forEach((name) => {
        if (addExternalLeadResearcherChip(name, false)) addedCount += 1;
    });
    if (normalizedNames.length > availableSlots) {
        showToast(`נוספו ${addedCount} חוקרים. ניתן לבחור עד ${MAX_LEAD_RESEARCHERS} חוקרים מובילים בסך הכול`, 'warning');
    }
    if (addedCount > 0) {
        markUserEdited();
    }
    return addedCount;
}

function clearLeadResearcherSearch() {
    const searchInput = document.getElementById('lead-researcher-search');
    const suggestionsDiv = document.getElementById('lead-researcher-suggestions');
    selectedLeadResearcher = null;
    if (searchInput) searchInput.value = '';
    if (suggestionsDiv) {
        suggestionsDiv.replaceChildren();
        suggestionsDiv.classList.remove('active');
    }
}

function commitSelectedLeadResearcher() {
    const searchInput = document.getElementById('lead-researcher-search');
    if (!selectedLeadResearcher) {
        if (searchInput?.value.trim()) {
            showToast('נא לבחור משתמש רשום מהרשימה או באפשרות להוספת חוקר שאינו רשום', 'warning');
        }
        return false;
    }

    const added = addLeadResearcherChip({
        uid: selectedLeadResearcher.uid,
        name: selectedLeadResearcher.fullName || '',
        email: selectedLeadResearcher.email || ''
    });
    clearLeadResearcherSearch();
    return added;
}

function initLeadResearcherAutocomplete() {
    const searchInput = document.getElementById('lead-researcher-search');
    const suggestionsDiv = document.getElementById('lead-researcher-suggestions');
    const addButton = document.getElementById('add-lead-researcher');
    if (!searchInput || !suggestionsDiv) return;

    searchInput.addEventListener('input', () => {
        const searchTerm = searchInput.value.trim().toLowerCase();
        selectedLeadResearcher = null;
        suggestionsDiv.replaceChildren();

        if (searchTerm.length < 2) {
            suggestionsDiv.classList.remove('active');
            return;
        }

        const selectedUids = new Set(collectLeadResearchers().map((researcher) => researcher.uid));
        const matches = allUsers.filter((user) => {
            if (!user.uid || selectedUids.has(user.uid)) return false;
            return user.fullName?.toLowerCase().includes(searchTerm)
                || user.email?.toLowerCase().includes(searchTerm);
        }).slice(0, 8);

        matches.forEach((user) => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.dataset.suggestionType = 'registered';
            const name = document.createElement('div');
            name.className = 'suggestion-name';
            name.textContent = user.fullName || '—';
            const email = document.createElement('div');
            email.className = 'suggestion-email';
            email.textContent = user.email || '';
            item.append(name, email);
            item.addEventListener('click', () => {
                selectedLeadResearcher = user;
                searchInput.value = user.fullName || user.email || '';
                suggestionsDiv.replaceChildren();
                suggestionsDiv.classList.remove('active');
            });
            suggestionsDiv.appendChild(item);
        });

        const externalCandidates = getExternalLeadResearcherCandidates(searchInput.value);
        if (externalCandidates.length > 0) {
            const externalItem = document.createElement('div');
            externalItem.className = 'suggestion-item external-lead-researcher-option';
            externalItem.dataset.suggestionType = 'external';

            const title = document.createElement('div');
            title.className = 'suggestion-name';
            const icon = document.createElement('i');
            icon.className = 'fas fa-user-plus';
            icon.setAttribute('aria-hidden', 'true');
            const titleText = document.createElement('span');
            titleText.textContent = externalCandidates.length === 1
                ? `הוספת "${externalCandidates[0]}" כחוקר מוביל חיצוני`
                : `הוספת ${externalCandidates.length} חוקרים מובילים חיצוניים`;
            title.append(icon, titleText);

            const description = document.createElement('div');
            description.className = 'suggestion-email';
            description.textContent = externalCandidates.length === 1
                ? 'השם יישמר כמשתמש לא רשום במערכת'
                : `${externalCandidates.join(', ')} — השמות יישמרו כמשתמשים שאינם רשומים במערכת`;

            externalItem.append(title, description);
            externalItem.addEventListener('click', () => {
                addExternalLeadResearchers(externalCandidates);
                clearLeadResearcherSearch();
            });
            suggestionsDiv.appendChild(externalItem);
        }

        suggestionsDiv.classList.toggle(
            'active',
            matches.length > 0 || externalCandidates.length > 0
        );
    });

    searchInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (selectedLeadResearcher) {
            commitSelectedLeadResearcher();
            return;
        }
        const firstRegisteredSuggestion = suggestionsDiv.querySelector('[data-suggestion-type="registered"]');
        if (firstRegisteredSuggestion) {
            firstRegisteredSuggestion.click();
            commitSelectedLeadResearcher();
            return;
        }
        const externalSuggestion = suggestionsDiv.querySelector('[data-suggestion-type="external"]');
        if (externalSuggestion) {
            externalSuggestion.click();
            return;
        }
        commitSelectedLeadResearcher();
    });

    addButton?.addEventListener('click', (event) => {
        event.preventDefault();
        if (selectedLeadResearcher) {
            commitSelectedLeadResearcher();
            return;
        }
        const registeredSuggestion = suggestionsDiv.querySelector('[data-suggestion-type="registered"]');
        const externalSuggestion = suggestionsDiv.querySelector('[data-suggestion-type="external"]');
        if (!registeredSuggestion && externalSuggestion) {
            externalSuggestion.click();
            return;
        }
        commitSelectedLeadResearcher();
    });

    document.addEventListener('click', (event) => {
        if (!searchInput.contains(event.target) && !suggestionsDiv.contains(event.target)) {
            suggestionsDiv.classList.remove('active');
        }
    });
}

function initExperimentPartnersAutocomplete() {
    const searchInput = document.getElementById('experiment-partner-search');
    const suggestionsDiv = document.getElementById('experiment-partner-suggestions');
    const addBtn = document.getElementById('add-experiment-partner');

    if (!searchInput || !suggestionsDiv) return;

    const isOwner = currentUser && experimentOwnerUid && currentUser.uid === experimentOwnerUid;
    if (!isOwner) {
        searchInput.disabled = true;
        searchInput.placeholder = '\u05e8\u05e7 \u05de\u05e7\u05d9\u05dd \u05d4\u05e0\u05d9\u05e1\u05d5\u05d9 \u05d9\u05db\u05d5\u05dc \u05dc\u05d4\u05d5\u05e1\u05d9\u05e3 \u05e9\u05d5\u05ea\u05e4\u05d9\u05dd';
        if (addBtn) {
            addBtn.disabled = true;
            addBtn.classList.add('disabled');
        }
        return;
    }

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        suggestionsDiv.innerHTML = '';
        selectedExperimentPartner = null;

        if (!query || query.length < 2) {
            suggestionsDiv.classList.remove('active');
            return;
        }

        const existingChips = document.querySelectorAll('#experiment-partners-list .experiment-partner-chip');
        const existingUids = new Set();
        const existingEmails = new Set();
        existingChips.forEach(chip => {
            if (chip.dataset.uid) existingUids.add(chip.dataset.uid);
            if (chip.dataset.email) existingEmails.add(chip.dataset.email.toLowerCase());
        });

        const filtered = allUsers.filter(u => {
            if (u.uid === currentUser?.uid) return false;
            if (existingUids.has(u.uid)) return false;
            if (u.email && existingEmails.has(u.email.toLowerCase())) return false;
            return (u.fullName?.toLowerCase().includes(query) || u.email?.toLowerCase().includes(query));
        }).slice(0, 8);

        if (!filtered.length) {
            suggestionsDiv.classList.remove('active');
            return;
        }

        filtered.forEach(u => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.innerHTML = `
                <div class="suggestion-name">${u.fullName || '\u2014'}</div>
                <div class="suggestion-email">${u.email || ''}</div>
            `;
            item.addEventListener('click', () => {
                selectedExperimentPartner = u;
                searchInput.value = u.fullName || u.email || '';
                suggestionsDiv.innerHTML = '';
                suggestionsDiv.classList.remove('active');
            });
            suggestionsDiv.appendChild(item);
        });

        suggestionsDiv.classList.add('active');
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !suggestionsDiv.contains(e.target)) {
            suggestionsDiv.classList.remove('active');
        }
    });

    if (addBtn) {
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedExperimentPartner) {
                if (searchInput.value.trim()) {
                    showToast('\u05e0\u05d0 \u05dc\u05d1\u05d7\u05d5\u05e8 \u05e9\u05d5\u05ea\u05e3 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4', 'warning');
                }
                return;
            }

            addExperimentPartnerChip({
                name: selectedExperimentPartner.fullName || '',
                email: selectedExperimentPartner.email || '',
                uid: selectedExperimentPartner.uid || ''
            });
            syncExperimentPartnerToPermissions({
                name: selectedExperimentPartner.fullName || '',
                email: selectedExperimentPartner.email || '',
                uid: selectedExperimentPartner.uid || ''
            });
            markUserEdited();
            showToast(`${selectedExperimentPartner.fullName || selectedExperimentPartner.email} \u05e0\u05d5\u05e1\u05e3 \u05db\u05e9\u05d5\u05ea\u05e3`, 'success');
            searchInput.value = '';
            selectedExperimentPartner = null;
            suggestionsDiv.innerHTML = '';
            suggestionsDiv.classList.remove('active');
        });
    }

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const firstSuggestion = suggestionsDiv.querySelector('.suggestion-item');
            if (firstSuggestion) firstSuggestion.click();
        }
    });
}

// =========================================
// Creator Field
// =========================================
function populateCreatorField(data) {
    const creatorInput = document.getElementById('experiment-creator');
    if (!creatorInput) return;

    if (data.creatorName) {
        creatorInput.value = data.creatorName;
        return;
    }

    if (experimentOwnerUid && allUsers.length > 0) {
        const ownerUser = allUsers.find(u => u.uid === experimentOwnerUid);
        if (ownerUser) {
            creatorInput.value = ownerUser.fullName || ownerUser.email || '';
            return;
        }
    }

    if (currentUser && experimentOwnerUid === currentUser.uid && userData) {
        creatorInput.value = `${userData.firstName || ''} ${userData.lastName || ''}`.trim();
        return;
    }

    creatorInput.value = '';
}

// =========================================
// Private Until Date Max Enforcement
// =========================================
function enforcePrivateUntilDateMax() {
    const privateUntilInput = document.getElementById('private-until-date');
    if (!privateUntilInput) return;

    const now = getTrustedNow();
    const todayStr = now.toISOString().slice(0, 10);
    const maxDate = getPrivateUntilResearchYearLimit();
    const maxDateStr = formatDateInputValue(maxDate);
    privateUntilInput.setAttribute('min', todayStr);
    if (hasPrivacyExtensionApproval()) {
        privateUntilInput.removeAttribute('max');
    } else {
        privateUntilInput.setAttribute('max', maxDateStr);
    }

    if (privateUntilInput.value && privateUntilInput.value < todayStr) {
        privateUntilInput.value = '';
    } else if (!hasPrivacyExtensionApproval() && privateUntilInput.value && privateUntilInput.value > maxDateStr) {
        privateUntilInput.value = '';
    }

    if (!privateUntilInput.dataset.maxEnforced) {
        privateUntilInput.dataset.maxEnforced = '1';
        privateUntilInput.addEventListener('change', (event) => {
            if (ignoreUnauthorizedAccessManagementChange(privateUntilInput, event)) return;
            const val = privateUntilInput.value;
            const recalcMin = getTrustedNow().toISOString().slice(0, 10);
            const recalcMaxDate = getPrivateUntilResearchYearLimit();
            const recalcMax = formatDateInputValue(recalcMaxDate);
            privateUntilInput.setAttribute('min', recalcMin);
            if (hasPrivacyExtensionApproval()) {
                privateUntilInput.removeAttribute('max');
            } else {
                privateUntilInput.setAttribute('max', recalcMax);
            }
            if (!val) {
                privateUntilInput.value = '';
                blockInvalidPrivacyDateChange(event, 'יש לבחור תאריך סיום פרטיות תקין. הניסוי יועבר לציבורי והשינויים יישמרו.');
            } else if (val < recalcMin) {
                privateUntilInput.value = '';
                blockInvalidPrivacyDateChange(event, 'תאריך סיום פרטיות חייב להיות עתידי. הניסוי יועבר לציבורי והשינויים יישמרו.');
            } else if (!hasPrivacyExtensionApproval() && val && val > recalcMax) {
                privateUntilInput.value = '';
                blockInvalidPrivacyDateChange(event, `תאריך סיום פרטיות מוגבל עד ${formatHebrewDate(recalcMaxDate)}. הניסוי יועבר לציבורי והשינויים יישמרו.`);
            } else {
                showToast('תאריך הפרטיות תקין ויישמר אוטומטית.', 'info', 2500);
            }
        });
    }
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
                showToast('נא לבצע בחירת שותף מהרשימה', 'warning');
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
        addEventBtn.addEventListener('click', () => openEventModal());
    }

    // Event modal buttons
    document.getElementById('event-modal-cancel')?.addEventListener('click', () => closeModal('event-modal'));
    document.getElementById('event-modal-save')?.addEventListener('click', () => saveEventFromModal());
    initDropzone('event-modal-dropzone', 'event-modal-file', 'event-modal-file-name');

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
            <textarea class="event-description" placeholder="תיאור האירוע..." data-index="${index}">${event.description || ''}</textarea>
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

function openEventModal() {
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('event-modal-date').value = today;
    document.getElementById('event-modal-description').value = '';
    document.getElementById('event-modal-file').value = '';
    document.getElementById('event-modal-file-name').textContent = 'גרירת קובץ לכאן או לחיצה לבחירה (עד 10MB)';
    document.getElementById('event-modal-progress')?.classList.add('hidden');
    openModal('event-modal');
}

async function saveEventFromModal() {
    const date = document.getElementById('event-modal-date').value;
    const description = document.getElementById('event-modal-description').value.trim();
    const fileInput = document.getElementById('event-modal-file');
    const file = fileInput?.files[0];

    if (!date && !description) {
        showToast('יש להזין תאריך או תיאור', 'error');
        return;
    }

    // Check file size
    if (file) {
        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        if (file.size > MAX_FILE_SIZE) {
            showToast('גודל הקובץ חורג מהמגבלה (10MB מקסימום)', 'error');
            return;
        }
    }

    let fileName = null, fileUrl = null, filePath = null;

    if (file) {
        try {
            const result = await uploadProgressFile(file, 'events', 'event-modal-progress', 'event-modal-progress-fill', 'event-modal-progress-text');
            fileName = file.name;
            fileUrl = result.url;
            filePath = result.path;
        } catch (err) {
            showToast('שגיאה בהעלאת הקובץ: ' + err.message, 'error');
            return;
        }
    }

    eventsData.push({
        date: date,
        description: description,
        fileName: fileName,
        fileUrl: fileUrl,
        filePath: filePath,
        createdAt: new Date().toISOString()
    });

    renderEventsTable();
    markUserEdited();
    closeModal('event-modal');
    showToast('אירוע חדש נוסף בהצלחה', 'success');
}

function updateEventData(index) {
    const row = document.querySelector(`tr[data-event-index="${index}"]`);
    if (!row) return;

    const dateInput = row.querySelector('.event-date');
    const descInput = row.querySelector('.event-description');

    if (eventsData[index]) {
        const newDate = dateInput?.value || '';
        const newDesc = descInput?.value || '';
        const changed = newDate !== eventsData[index].date || newDesc !== eventsData[index].description;
        eventsData[index].date = newDate;
        eventsData[index].description = newDesc;
        if (changed) markUserEdited();
    }
}

async function handleFileUpload(e, eventIndex) {
    const file = e.target.files[0];
    if (!file) return;

    const targetEvent = eventsData[eventIndex];
    if (!targetEvent) return;

    if (!permissionsState?.canEdit) {
        showToast('אין הרשאה לקבצים', 'error');
        e.target.value = '';
        return;
    }

    // בדיקת גודל קובץ – מקסימום 10MB (בהתאם ל-Storage Rules)
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
        showToast('גודל הקובץ חורג מהמגבלה (10MB מקסימום)', 'error');
        e.target.value = '';
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

                // A realtime refresh replaces the row objects. Never attach a
                // completed upload to a different row that now has this index.
                if (!eventsData.includes(targetEvent)) {
                    try {
                        await deleteObject(uploadTask.snapshot.ref);
                    } catch (cleanupError) {
                        console.warn('Could not clean up superseded event upload:', cleanupError);
                    }
                    showToast('הניסוי עודכן בזמן ההעלאה, לכן הקובץ לא צורף. ניתן להעלות שוב.', 'warning', 5000);
                    return;
                }

                // עדכן את האירוע עם פרטי הקובץ
                targetEvent.fileName = file.name;
                targetEvent.fileUrl = downloadURL;
                targetEvent.filePath = filePath;

                // רענן את הטבלה
                renderEventsTable();

                // Mark as edited to trigger auto-save
                markUserEdited();

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

    if (!permissionsState?.canEdit) {
        showToast('אין הרשאה לקבצים', 'error');
        return;
    }

    if (!(await confirmImmediateDeletion('הקובץ'))) return;

    try {
        const storageRef = ref(storage, event.filePath);
        await deleteObject(storageRef);

        // עדכן את האירוע
        eventsData[eventIndex].fileName = null;
        eventsData[eventIndex].fileUrl = null;
        eventsData[eventIndex].filePath = null;

        renderEventsTable();
        
        // Mark as edited to trigger auto-save
        markUserEdited();
        
        showToast('הקובץ נמחק בהצלחה', 'success');
    } catch (error) {
        console.error('Error deleting file:', error);
        // אם הקובץ לא קיים - נקה את הנתונים בכל מקרה
        if (error.code === 'storage/object-not-found') {
            eventsData[eventIndex].fileName = null;
            eventsData[eventIndex].fileUrl = null;
            eventsData[eventIndex].filePath = null;
            renderEventsTable();
            
            // Mark as edited to trigger auto-save
            markUserEdited();
        } else {
            showToast('שגיאה במחיקת הקובץ: ' + error.message, 'error');
        }
    }
}

async function deleteEvent(eventIndex) {
    const event = eventsData[eventIndex];

    // Block deletion if a file is still attached
    if (event?.fileUrl) {
        showToast('זוהה קובץ - יש למחוק את הקובץ המצורף לפני מחיקת האירוע', 'error');
        return;
    }

    if (!(await confirmDeferredDeletion('האירוע'))) return;

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
    // Silent collect — read DOM without triggering markUserEdited
    eventsData.forEach((_, index) => {
        const row = document.querySelector(`tr[data-event-index="${index}"]`);
        if (!row || !eventsData[index]) return;

        const dateInput = row.querySelector('.event-date');
        const descInput = row.querySelector('.event-description');

        if (dateInput) eventsData[index].date = dateInput.value;
        if (descInput) eventsData[index].description = descInput.value;
    });

    return eventsData;
}

// =========================================
// Financial Analysis Log (ניתוחים פיננסים)
// =========================================
let financialData = []; // מערך לשמירת נתונים פיננסיים

function initFinancialLog() {
    const addFinancialBtn = document.getElementById('add-financial-entry-btn');
    if (addFinancialBtn) {
        addFinancialBtn.addEventListener('click', () => openFinancialModal());
    }

    document.getElementById('financial-modal-cancel')?.addEventListener('click', () => closeModal('financial-modal'));
    document.getElementById('financial-modal-save')?.addEventListener('click', () => saveFinancialFromModal());
    initDropzone('financial-modal-dropzone', 'financial-modal-file', 'financial-modal-file-name');

    loadFinancialData();
}

function loadFinancialData() {
    financialData = experimentData?.financialData || [];
    renderFinancialTable();
}

function renderFinancialTable() {
    const tableBody = document.getElementById('financial-table-body');
    const container = document.querySelector('#view-financial-analysis .events-table-container');

    if (!tableBody || !container) return;

    tableBody.innerHTML = '';

    if (financialData.length === 0) {
        container.classList.remove('has-events');
        return;
    }

    container.classList.add('has-events');

    financialData.forEach((entry, index) => {
        const row = createFinancialRow(entry, index);
        tableBody.appendChild(row);
    });
}

function createFinancialRow(entry = {}, index) {
    const row = document.createElement('tr');
    row.dataset.financialIndex = index;

    const today = new Date().toISOString().split('T')[0];

    row.innerHTML = `
        <td data-label="תאריך">
            <input type="date" class="financial-date" value="${entry.date || today}" data-index="${index}">
        </td>
        <td data-label="תיאור">
            <textarea class="financial-description" placeholder="תיאור הנתון..." data-index="${index}">${entry.description || ''}</textarea>
        </td>
        <td data-label="קובץ">
            <div class="file-upload-cell">
                ${entry.fileUrl ? `
                    <div class="file-info">
                        <i class="fas fa-file"></i>
                        <span class="file-name" title="${entry.fileName || 'קובץ'}">${truncateFileName(entry.fileName || 'קובץ')}</span>
                        <button type="button" class="btn-file-action btn-download" title="הורד קובץ" data-url="${entry.fileUrl}">
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
                        <input type="file" class="financial-file-input" data-index="${index}" accept="*/*">
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
                <button type="button" class="btn-delete-event" title="מחק נתון" data-index="${index}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </td>
    `;

    const fileInput = row.querySelector('.financial-file-input');
    if (fileInput) {
        fileInput.addEventListener('change', (e) => handleFinancialFileUpload(e, index));
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
        deleteFileBtn.addEventListener('click', () => deleteFinancialFile(index));
    }

    const deleteFinancialBtn = row.querySelector('.btn-delete-event');
    if (deleteFinancialBtn) {
        deleteFinancialBtn.addEventListener('click', () => deleteFinancialEntry(index));
    }

    const dateInput = row.querySelector('.financial-date');
    const descInput = row.querySelector('.financial-description');

    if (dateInput) {
        dateInput.addEventListener('change', () => updateFinancialEntryData(index));
    }
    if (descInput) {
        descInput.addEventListener('blur', () => updateFinancialEntryData(index));
    }

    return row;
}

function openFinancialModal() {
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('financial-modal-date').value = today;
    document.getElementById('financial-modal-description').value = '';
    document.getElementById('financial-modal-file').value = '';
    document.getElementById('financial-modal-file-name').textContent = 'גרירת קובץ לכאן או לחיצה לבחירה (עד 10MB)';
    document.getElementById('financial-modal-progress')?.classList.add('hidden');
    openModal('financial-modal');
}

async function saveFinancialFromModal() {
    const date = document.getElementById('financial-modal-date').value;
    const description = document.getElementById('financial-modal-description').value.trim();
    const fileInput = document.getElementById('financial-modal-file');
    const file = fileInput?.files[0];

    if (!date && !description) {
        showToast('יש להזין תאריך או תיאור', 'error');
        return;
    }

    if (file) {
        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        if (file.size > MAX_FILE_SIZE) {
            showToast('גודל הקובץ חורג מהמגבלה (10MB מקסימום)', 'error');
            return;
        }
    }

    let fileName = null, fileUrl = null, filePath = null;

    if (file) {
        try {
            const result = await uploadProgressFile(file, 'financialData', 'financial-modal-progress', 'financial-modal-progress-fill', 'financial-modal-progress-text');
            fileName = file.name;
            fileUrl = result.url;
            filePath = result.path;
        } catch (err) {
            showToast('שגיאה בהעלאת הקובץ: ' + err.message, 'error');
            return;
        }
    }

    financialData.push({
        date,
        description,
        fileName,
        fileUrl,
        filePath,
        createdAt: new Date().toISOString()
    });

    renderFinancialTable();
    markUserEdited();
    closeModal('financial-modal');
    showToast('נתון פיננסי חדש נוסף בהצלחה', 'success');
}

function updateFinancialEntryData(index) {
    const row = document.querySelector(`tr[data-financial-index="${index}"]`);
    if (!row) return;

    const dateInput = row.querySelector('.financial-date');
    const descInput = row.querySelector('.financial-description');

    if (financialData[index]) {
        const newDate = dateInput?.value || '';
        const newDesc = descInput?.value || '';
        const changed = newDate !== financialData[index].date || newDesc !== financialData[index].description;
        financialData[index].date = newDate;
        financialData[index].description = newDesc;
        if (changed) markUserEdited();
    }
}

async function handleFinancialFileUpload(e, financialIndex) {
    const file = e.target.files[0];
    if (!file) return;

    const targetFinancialEntry = financialData[financialIndex];
    if (!targetFinancialEntry) return;

    if (!permissionsState?.canEdit) {
        showToast('אין הרשאה לקבצים', 'error');
        e.target.value = '';
        return;
    }

    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
        showToast('גודל הקובץ חורג מהמגבלה (10MB מקסימום)', 'error');
        e.target.value = '';
        return;
    }

    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `users/${experimentOwnerUid}/experiments/${currentExperimentId}/financialData/${timestamp}_${safeName}`;

    const storageRef = ref(storage, filePath);
    const uploadTask = uploadBytesResumable(storageRef, file);

    const progressContainer = document.querySelector(`tr[data-financial-index="${financialIndex}"] .upload-progress[data-index="${financialIndex}"]`);
    const progressBarFill = progressContainer?.querySelector('.progress-bar-fill');
    const progressText = progressContainer?.querySelector('.progress-text');

    if (progressContainer) {
        progressContainer.style.display = 'flex';
    }

    const uploadWrapper = document.querySelector(`tr[data-financial-index="${financialIndex}"] .file-input-wrapper`);
    if (uploadWrapper) {
        uploadWrapper.style.display = 'none';
    }

    uploadTask.on('state_changed',
        (snapshot) => {
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            if (progressBarFill) {
                progressBarFill.style.width = progress + '%';
            }
            if (progressText) {
                progressText.textContent = Math.round(progress) + '%';
            }
        },
        (error) => {
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
            try {
                const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);

                if (!financialData.includes(targetFinancialEntry)) {
                    try {
                        await deleteObject(uploadTask.snapshot.ref);
                    } catch (cleanupError) {
                        console.warn('Could not clean up superseded financial upload:', cleanupError);
                    }
                    showToast('הניסוי עודכן בזמן ההעלאה, לכן הקובץ לא צורף. ניתן להעלות שוב.', 'warning', 5000);
                    return;
                }

                targetFinancialEntry.fileName = file.name;
                targetFinancialEntry.fileUrl = downloadURL;
                targetFinancialEntry.filePath = filePath;

                renderFinancialTable();

                // Mark as edited to trigger auto-save
                markUserEdited();

                showToast('הקובץ הועלה בהצלחה!', 'success');
            } catch (error) {
                console.error('Error getting download URL:', error);
                showToast('שגיאה בקבלת קישור לקובץ', 'error');
            }
        }
    );
}

async function deleteFinancialFile(financialIndex) {
    const entry = financialData[financialIndex];
    if (!entry || !entry.filePath) return;

    if (!permissionsState?.canEdit) {
        showToast('אין הרשאה לקבצים', 'error');
        return;
    }

    if (!(await confirmImmediateDeletion('הקובץ'))) return;

    try {
        const storageRef = ref(storage, entry.filePath);
        await deleteObject(storageRef);

        financialData[financialIndex].fileName = null;
        financialData[financialIndex].fileUrl = null;
        financialData[financialIndex].filePath = null;

        renderFinancialTable();
        
        // Mark as edited to trigger auto-save
        markUserEdited();
        
        showToast('הקובץ נמחק בהצלחה', 'success');
    } catch (error) {
        console.error('Error deleting file:', error);
        if (error.code === 'storage/object-not-found') {
            financialData[financialIndex].fileName = null;
            financialData[financialIndex].fileUrl = null;
            financialData[financialIndex].filePath = null;
            renderFinancialTable();
            
            // Mark as edited to trigger auto-save
            markUserEdited();
        } else {
            showToast('שגיאה במחיקת הקובץ: ' + error.message, 'error');
        }
    }
}

async function deleteFinancialEntry(financialIndex) {
    const entry = financialData[financialIndex];

    if (entry?.fileUrl) {
        showToast('זוהה קובץ - יש למחוק את הקובץ המצורף לפני מחיקת הנתון', 'error');
        return;
    }

    if (!(await confirmDeferredDeletion('הנתון הפיננסי'))) return;

    financialData.splice(financialIndex, 1);

    renderFinancialTable();
    showToast('הנתון הפיננסי נמחק בהצלחה', 'success');
}

function collectFinancialData() {
    // Silent collect — read DOM without triggering markUserEdited
    financialData.forEach((_, index) => {
        const row = document.querySelector(`tr[data-financial-index="${index}"]`);
        if (!row || !financialData[index]) return;

        const dateInput = row.querySelector('.financial-date');
        const descInput = row.querySelector('.financial-description');

        if (dateInput) financialData[index].date = dateInput.value;
        if (descInput) financialData[index].description = descInput.value;
    });

    return financialData;
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
    delBtn.addEventListener('click', async () => {
        if (!(await confirmDeferredDeletion('השורה'))) return;
        tr.remove();
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    wireProgressRowConditionalLogic(tr);
    tbody.appendChild(tr);
}

function updateAgroActionOtherRowVisibility(row) {
    const actionSelect = row.querySelector('[data-field="action"]');
    const otherInput = row.querySelector('[data-field="actionOther"]');
    if (!actionSelect || !otherInput) return;
    const otherCell = otherInput.closest('td');
    const shouldShow = actionSelect.value === 'אחר';
    if (otherCell) otherCell.style.display = shouldShow ? '' : 'none';
    if (!shouldShow) otherInput.value = '';
}

function updateInoculationMethodRowVisibility(row) {
    const typeSelect = row.querySelector('[data-field="inoculationType"]');
    const methodSelect = row.querySelector('[data-field="inoculationMethod"]');
    if (!typeSelect || !methodSelect) return;
    const methodCell = methodSelect.closest('td');
    const shouldShow = typeSelect.value === 'מלאכותי';
    if (methodCell) methodCell.style.display = shouldShow ? '' : 'none';
    if (!shouldShow) methodSelect.value = '';
}

function wireProgressRowConditionalLogic(row) {
    const actionSelect = row.querySelector('[data-field="action"]');
    if (actionSelect) {
        actionSelect.addEventListener('change', () => updateAgroActionOtherRowVisibility(row));
        updateAgroActionOtherRowVisibility(row);
    }

    const inoculationTypeSelect = row.querySelector('[data-field="inoculationType"]');
    if (inoculationTypeSelect) {
        inoculationTypeSelect.addEventListener('change', () => updateInoculationMethodRowVisibility(row));
        updateInoculationMethodRowVisibility(row);
    }
}

function renderSoilDisinfectTable(tbodyId, rows) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = '';
    rows.forEach(row => addSoilDisinfectRow(tbody, row));
}

function addSoilDisinfectRow(tbody, data = {}) {
    registerDynamicOption('soilDisinfectionMaterial', data.material);

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
        if (field === 'material') {
            inp.setAttribute('list', 'datalist-soil-disinfection-material');
        }
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
    delBtn.addEventListener('click', async () => {
        if (!(await confirmDeferredDeletion('השורה'))) return;
        tr.remove();
    });
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

const SOIL_CULTIVATION_FIELDS = ['date', 'action'];
const SOIL_CULTIVATION_LABELS = { date: 'תאריך', action: 'פעולת העיבוד' };
const SOIL_CULTIVATION_OPTIONS = ['טיחוח', 'משטט', 'עיבוד קרקע', 'פינוי'];

function renderSoilCultivationTable(rows = []) {
    const tbody = document.getElementById('cultivation-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    (rows || []).forEach(row => addSoilCultivationRow(row));
}

function addSoilCultivationRow(data = {}) {
    addProgressRow(
        document.getElementById('cultivation-tbody'),
        SOIL_CULTIVATION_FIELDS,
        SOIL_CULTIVATION_LABELS,
        data,
        { fieldOptions: { action: SOIL_CULTIVATION_OPTIONS } }
    );
}

function collectSoilCultivationRows() {
    return collectProgressRows('cultivation-tbody', SOIL_CULTIVATION_FIELDS);
}

function initSoilTableListeners() {
    const compostTbody = document.getElementById('compost-tbody');
    const disinfectTbody = document.getElementById('disinfect-tbody');
    const SOIL_LABELS = { date: 'תאריך', amount: 'כמות', method: 'אופן יישום', material: 'חומר החיטוי' };

    // Compost – popup modal (spec: פופ אפ)
    document.getElementById('add-compost-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת פיזור קומפוסט',
            fields: ['date', 'amount', 'method'],
            labels: SOIL_LABELS,
            onSave: (data) => addSoilTableRow(compostTbody, ['date', 'amount', 'method'], data)
        })
    );

    // Soil disinfection – popup modal (spec: פופ אפ)
    document.getElementById('add-disinfect-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת חיטוי קרקע',
            fields: ['date', 'material', 'amount', 'method'],
            labels: SOIL_LABELS,
            dynamicDatalists: { material: 'datalist-soil-disinfection-material' },
            onSave: (data) => addSoilDisinfectRow(disinfectTbody, data)
        })
    );

    document.getElementById('add-cultivation-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת עיבוד קרקע',
            fields: SOIL_CULTIVATION_FIELDS,
            labels: SOIL_CULTIVATION_LABELS,
            fieldOptions: { action: SOIL_CULTIVATION_OPTIONS },
            onSave: (data) => addSoilCultivationRow(data)
        })
    );
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

    // Store file metadata on row if provided
    if (data.fileUrl) tr.dataset.fileUrl = data.fileUrl;
    if (data.filePath) tr.dataset.filePath = data.filePath;
    if (data.originalFileName) tr.dataset.originalFileName = data.originalFileName;

    fields.forEach(field => {
        const td = document.createElement('td');
        td.dataset.label = labels[field] || field;

        // For 'fileName' field
        if (field === 'fileName') {
            if (options.enableFileUpload) {
                renderProgressFileCell(td, tr, data, labels, field, options.uploadFolder || 'files');
            } else if (data.fileUrl) {
                td.innerHTML = `
                    <div class="progress-file-info">
                        <i class="fas fa-file"></i>
                        <span class="progress-file-name" title="${data.fileName || ''}">${data.fileName || ''}</span>
                        <button type="button" class="btn-file-action btn-download" title="הורדת קובץ" data-url="${data.fileUrl}">
                            <i class="fas fa-download"></i>
                        </button>
                        <button type="button" class="btn-file-action btn-delete-progress-file" title="מחיקת קובץ">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                `;
                const hiddenInp = document.createElement('input');
                hiddenInp.type = 'hidden';
                hiddenInp.dataset.field = field;
                hiddenInp.value = data.fileName || '';
                td.appendChild(hiddenInp);

                td.querySelector('.btn-download')?.addEventListener('click', (e) => {
                    const url = e.currentTarget.dataset.url;
                    if (url) window.open(url, '_blank');
                });

                td.querySelector('.btn-delete-progress-file')?.addEventListener('click', async () => {
                    const filePath = tr.dataset.filePath;
                    if (!filePath) return;
                    if (!(await confirmImmediateDeletion('הקובץ'))) return;
                    const sectionId = getSectionIdByView();
                    const shouldDeletePhysicalFile = !sectionId || !isFilePathSharedAcrossTreatments(sectionId, filePath);
                    try {
                        if (shouldDeletePhysicalFile) {
                            const storageRef = ref(storage, filePath);
                            await deleteObject(storageRef);
                            showToast('הקובץ נמחק בהצלחה', 'success');
                        } else {
                            showToast('הקובץ נותק מהרשומה הנוכחית בלבד (קיים גם בטיפול נוסף)', 'info');
                        }
                    } catch (err) {
                        if (err.code !== 'storage/object-not-found') {
                            showToast('שגיאה במחיקת הקובץ: ' + err.message, 'error');
                            return;
                        }
                    }
                    delete tr.dataset.fileUrl;
                    delete tr.dataset.filePath;
                    td.innerHTML = '';
                    const inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'soil-input';
                    inp.dataset.field = field;
                    inp.value = data.fileName || '';
                    inp.placeholder = labels[field] || '';
                    td.appendChild(inp);
                });
            } else {
                const inp = document.createElement('input');
                inp.type = 'text';
                inp.className = 'soil-input';
                inp.dataset.field = field;
                inp.value = data[field] || '';
                if (labels[field]) inp.placeholder = labels[field];
                td.appendChild(inp);
            }
        } else {
            // Normal input
            const isReadonly = options.readonlyFields && options.readonlyFields.includes(field) && data[field];
            const fieldOptions = options.fieldOptions && options.fieldOptions[field];

            if (fieldOptions && Array.isArray(fieldOptions)) {
                const select = document.createElement('select');
                select.className = 'soil-input';
                select.dataset.field = field;

                const selectOptions = normalizeUniqueValues([
                    ...fieldOptions,
                    ...(data[field] !== undefined && data[field] !== null && String(data[field]).trim() ? [String(data[field]).trim()] : [])
                ]);

                const emptyOpt = document.createElement('option');
                emptyOpt.value = '';
                emptyOpt.textContent = `בחירת ${labels[field] || field}`;
                select.appendChild(emptyOpt);

                selectOptions.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    option.textContent = opt;
                    select.appendChild(option);
                });

                select.value = data[field] || '';
                if (isReadonly) {
                    select.disabled = true;
                    select.style.fontWeight = '600';
                }
                td.appendChild(select);
            } else {
                // Auto-detect input type: date fields → calendar, number fields → numeric
                let inputType = 'text';
                if (options.inputTypes && options.inputTypes[field]) {
                    inputType = options.inputTypes[field];
                } else if (field === 'date' || field.endsWith('Date')) {
                    inputType = 'date';
                } else if (['hours','workers','dosage','quantity','fruitFloor','damageValue','totalWater','totalFert','hives'].includes(field)) {
                    inputType = 'number';
                }
                const inp = document.createElement('input');
                inp.type = inputType;
                if (inputType === 'number') inp.step = 'any';
                inp.className = 'soil-input';
                inp.dataset.field = field;
                inp.value = data[field] || '';
                const fieldDatalist = options.dynamicDatalists && options.dynamicDatalists[field];
                if (fieldDatalist && inputType === 'text') {
                    inp.setAttribute('list', fieldDatalist);
                }
                if (labels[field]) inp.placeholder = labels[field];
                if (isReadonly) { inp.readOnly = true; inp.style.fontWeight = '600'; }
                td.appendChild(inp);
            }
        }
        tr.appendChild(td);
    });

    // Delete row button
    const tdDel = document.createElement('td');
    tdDel.dataset.label = '';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-del-soil-row';
    delBtn.innerHTML = '<i class="fas fa-trash"></i>';
    delBtn.addEventListener('click', async () => {
        // Block deletion if a file is still attached
        if (tr.dataset.fileUrl) {
            showToast('זוהה קובץ - יש למחוק את הקובץ המצורף לפני מחיקת השורה', 'error');
            return;
        }
        if (!(await confirmDeferredDeletion('השורה'))) return;
        tr.remove();
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
}

function renderProgressFileCell(td, tr, data, labels, field, uploadFolder) {
    const renderEmptyState = () => {
        td.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.className = 'file-input-wrapper';

        const uploadBtn = document.createElement('button');
        uploadBtn.type = 'button';
        uploadBtn.className = 'btn-upload-file';
        uploadBtn.innerHTML = '<i class="fas fa-upload"></i><span>בחירת קובץ</span>';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '*/*';
        fileInput.className = 'event-file-input';
        fileInput.style.display = 'none';

        const hiddenInp = document.createElement('input');
        hiddenInp.type = 'hidden';
        hiddenInp.dataset.field = field;
        hiddenInp.value = '';

        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const selectedFile = fileInput.files && fileInput.files[0];
            if (!selectedFile) return;

            // בדיקת גודל קובץ – מקסימום 10MB
            const MAX_FILE_SIZE = 10 * 1024 * 1024;
            if (selectedFile.size > MAX_FILE_SIZE) {
                showToast('גודל הקובץ חורג מהמגבלה (10MB מקסימום)', 'error');
                fileInput.value = '';
                return;
            }

            uploadBtn.disabled = true;
            uploadBtn.querySelector('span').textContent = 'העלאה...';
            try {
                const result = await uploadProgressFile(selectedFile, uploadFolder);
                if (!tr.isConnected) {
                    try {
                        await deleteObject(ref(storage, result.path));
                    } catch (cleanupError) {
                        console.warn('Could not clean up superseded progress upload:', cleanupError);
                    }
                    showToast('הניסוי עודכן בזמן ההעלאה, לכן הקובץ לא צורף. ניתן להעלות שוב.', 'warning', 5000);
                    return;
                }
                tr.dataset.fileUrl = result.url;
                tr.dataset.filePath = result.path;
                hiddenInp.value = selectedFile.name;
                data.fileName = selectedFile.name;
                renderFileState(selectedFile.name);
                showToast('הקובץ הועלה בהצלחה', 'success');
            } catch (err) {
                showToast('שגיאה בהעלאת הקובץ: ' + err.message, 'error');
                uploadBtn.disabled = false;
                uploadBtn.querySelector('span').textContent = 'בחירת קובץ';
            }
        });

        wrapper.appendChild(uploadBtn);
        wrapper.appendChild(fileInput);
        td.appendChild(wrapper);
        td.appendChild(hiddenInp);
    };

    const renderFileState = (fileDisplayName) => {
        td.innerHTML = `
            <div class="progress-file-info">
                <i class="fas fa-file"></i>
                <span class="progress-file-name" title="${fileDisplayName || ''}">${fileDisplayName || ''}</span>
                <button type="button" class="btn-file-action btn-download" title="הורדת קובץ" data-url="${tr.dataset.fileUrl || ''}">
                    <i class="fas fa-download"></i>
                </button>
                <button type="button" class="btn-file-action btn-delete-progress-file" title="מחיקת קובץ">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;

        const hiddenInp = document.createElement('input');
        hiddenInp.type = 'hidden';
        hiddenInp.dataset.field = field;
        hiddenInp.value = fileDisplayName || '';
        td.appendChild(hiddenInp);

        td.querySelector('.btn-download')?.addEventListener('click', (e) => {
            const url = e.currentTarget.dataset.url;
            if (url) window.open(url, '_blank');
        });

        td.querySelector('.btn-delete-progress-file')?.addEventListener('click', async () => {
            const filePath = tr.dataset.filePath;
            if (!filePath) return;
            if (!(await confirmImmediateDeletion('הקובץ'))) return;
            const sectionId = getSectionIdByView();
            const shouldDeletePhysicalFile = !sectionId || !isFilePathSharedAcrossTreatments(sectionId, filePath);
            try {
                if (shouldDeletePhysicalFile) {
                    await deleteObject(ref(storage, filePath));
                    showToast('הקובץ נמחק בהצלחה', 'success');
                } else {
                    showToast('הקובץ נותק מהרשומה הנוכחית בלבד (קיים גם בטיפול נוסף)', 'info');
                }
            } catch (err) {
                if (err.code !== 'storage/object-not-found') {
                    showToast('שגיאה במחיקת הקובץ: ' + err.message, 'error');
                    return;
                }
            }

            delete tr.dataset.fileUrl;
            delete tr.dataset.filePath;
            data.fileName = '';
            renderEmptyState();
        });
    };

    if (data.fileUrl && data.fileName) {
        tr.dataset.fileUrl = data.fileUrl;
        if (data.filePath) tr.dataset.filePath = data.filePath;
        renderFileState(data.fileName);
    } else {
        renderEmptyState();
    }
}

function collectProgressRows(tbodyId, fields) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return [];
    const rows = [];
    tbody.querySelectorAll('tr').forEach(tr => {
        const obj = {};
        fields.forEach(field => {
            const inp = tr.querySelector(`[data-field="${field}"]`);
            obj[field] = inp ? inp.value : '';
        });
        // Include file metadata if present
        if (tr.dataset.fileUrl) obj.fileUrl = tr.dataset.fileUrl;
        if (tr.dataset.filePath) obj.filePath = tr.dataset.filePath;
        if (tr.dataset.originalFileName) obj.originalFileName = tr.dataset.originalFileName;
        rows.push(obj);
    });
    return rows;
}

function normalizeLegacyRangeDates(row = {}) {
    const normalized = { ...row };
    const hasStart = Boolean(normalized.startDate);
    const hasEnd = Boolean(normalized.endDate);
    if (hasStart || hasEnd) return normalized;

    const legacy = String(normalized.measureDates || '').trim();
    if (!legacy) return normalized;

    const isoDates = legacy.match(/\d{4}-\d{2}-\d{2}/g) || [];
    if (isoDates.length >= 2) {
        normalized.startDate = isoDates[0];
        normalized.endDate = isoDates[1];
    } else if (isoDates.length === 1) {
        normalized.startDate = isoDates[0];
        normalized.endDate = isoDates[0];
    }

    return normalized;
}

// =========================================
// Irrigation & Fertilization
// =========================================
const IRRIGATION_FIELDS = ['fileName','uploadDate','startDate','endDate','totalWater','notes'];
const IRRIGATION_LABELS = { fileName:'שם הקובץ', uploadDate:'תאריך העלאה', startDate:'תאריך התחלה', endDate:'תאריך סיום', totalWater:'סה"כ כמות מים (ליטר)', notes:'הערות' };
const FERTILIZATION_FIELDS = ['fileName','uploadDate','startDate','endDate','fertType','company','totalFert','notes'];
const FERTILIZATION_LABELS = { fileName:'שם הקובץ', uploadDate:'תאריך העלאה', startDate:'תאריך התחלה', endDate:'תאריך סיום', fertType:'סוג הדשן', company:'חברה', totalFert:'סה"כ כמות דשן', notes:'הערות' };
const FERTILIZATION_DYNAMIC_DATALISTS = { fertType: 'datalist-fertilizer-type', company: 'datalist-fertilizer-company' };

function getIrrigationWaterUnit() {
    return getCurrentStudyType() === 'lab' ? 'ליטר' : 'קוב';
}

function getIrrigationWaterLabel() {
    return `סה"כ כמות מים (${getIrrigationWaterUnit()})`;
}

function updateIrrigationWaterUnitLabels() {
    IRRIGATION_LABELS.totalWater = getIrrigationWaterLabel();

    const header = document.querySelector('#irrigation-table thead th:nth-child(5)');
    if (header) header.textContent = IRRIGATION_LABELS.totalWater;

    const modalLabel = document.getElementById('irr-modal-total-label');
    if (modalLabel) modalLabel.textContent = `${IRRIGATION_LABELS.totalWater}:`;

    document.querySelectorAll('#irrigation-tbody td[data-label]').forEach((cell) => {
        const input = cell.querySelector('[data-field="totalWater"]');
        if (input) {
            cell.dataset.label = IRRIGATION_LABELS.totalWater;
            input.placeholder = IRRIGATION_LABELS.totalWater;
        }
    });
}

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
const CLIMATE_FIELDS = ['name','location','sensorPosition','sensorDepth','startDate','endDate','fileName','notes'];
const CLIMATE_LABELS = { name:'נתון', location:'מיקום מדידה', sensorPosition:'מיקום חיישן במרחב', sensorDepth:'גובה/עומק חיישן', startDate:'תאריך התחלה', endDate:'תאריך סיום', fileName:'קובץ מצורף', notes:'הערות' };
const CLIMATE_NAME_OPTIONS = [...new Set(DEFAULT_CLIMATE_ROWS.map(item => item.name))];
const CLIMATE_LOCATION_OPTIONS = ['חממה', 'קרקע'];

function renderClimateTable(rows) {
    const tbody = document.getElementById('climate-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    (rows || []).forEach(row => addProgressRow(
        tbody,
        CLIMATE_FIELDS,
        CLIMATE_LABELS,
        normalizeLegacyRangeDates(row),
        {
            fieldOptions: {
                name: CLIMATE_NAME_OPTIONS,
                location: CLIMATE_LOCATION_OPTIONS
            },
            enableFileUpload: true,
            uploadFolder: 'climate'
        }
    ));
}

// =========================================
// Agrotechnics
// =========================================
const AGRO_FIELDS = ['action','actionOther','actionDate','hours','workers'];
const AGRO_LABELS = { action:'פעולה', actionOther:'פירוט פעולה', actionDate:'תאריך ביצוע הפעולה', hours:'כמות שעות לפעולה', workers:'כמות עובדים לפעולה' };
const AGRO_ACTION_OPTIONS = ['שוצים', 'הדליות', 'עישוב', 'גיזום', 'עקירה', 'אחר'];
const POLLINATION_FIELDS = ['date', 'hives'];
const POLLINATION_LABELS = { date: 'תאריך', hives: 'כמות כוורות' };

function renderAgroTable(rows) {
    const tbody = document.getElementById('agro-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    (rows || []).forEach(row => addProgressRow(tbody, AGRO_FIELDS, AGRO_LABELS, row, { fieldOptions: { action: AGRO_ACTION_OPTIONS } }));
}

function renderPollinationTable(rows) {
    const tbody = document.getElementById('pollination-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    (rows || []).forEach(row => addProgressRow(tbody, POLLINATION_FIELDS, POLLINATION_LABELS, row));
}

// =========================================
// Plant Protection
// =========================================
const PEST_FIELDS = ['pest','date','inoculationType','inoculationMethod','inoculationAmount','notes'];
const PEST_LABELS = {
    pest:'מפגע',
    date:'תאריך',
    inoculationType:'סוג האילוח',
    inoculationMethod:'שיטת האילוח',
    inoculationAmount:'כמות האילוח',
    notes:'הערות'
};
const PROTECTION_FIELDS = ['material','date','dosage','combined','notes'];
const PROTECTION_LABELS = { material:'חומר', date:'תאריך', dosage:'מינון לטיפול', combined:'משולב עם חומרים נוספים', notes:'הערות' };

function addPestRow(tbodyId, data) {
    addProgressRow(document.getElementById(tbodyId), PEST_FIELDS, PEST_LABELS, data || {}, {
        fieldOptions: {
            inoculationType: ['טבעי', 'מלאכותי'],
            inoculationMethod: ['ערבוב בקרקע', 'ריסוס', 'שחרור (חרקים)', 'טבילה', 'שפשוף', 'דקירה', 'אחר']
        }
    });
}
function addProtectionRow(tbodyId, data) {
    registerDynamicOption('plantProtectionMaterial', data?.material);

    addProgressRow(document.getElementById(tbodyId), PROTECTION_FIELDS, PROTECTION_LABELS, data || {}, {
        fieldOptions: {
            combined: ['לא', 'כן']
        },
        dynamicDatalists: {
            material: 'datalist-plant-protection-material'
        }
    });
}

// =========================================
// Yield
// =========================================
const YIELD_MEASURE_FIELDS = ['measureDate','repeatCount','fruitFloor','quality','quantity','fruitDesc','notes'];
const YIELD_MEASURE_LABELS = { measureDate:'תאריך מדידה', repeatCount:'חזרה', fruitFloor:'קומת הפרי', quality:'איכות (לק"ג)', quantity:'כמות (ק"ג)', fruitDesc:'תיאור הפרי', notes:'הערות' };
const YIELD_DAMAGE_FIELDS = ['measureDate','repeatCount','damage','damageIndex','damageValue','damageDesc'];
const YIELD_DAMAGE_LABELS = { measureDate:'תאריך מדידה', repeatCount:'חזרה', damage:'הפגע הנמדד', damageIndex:'מדד נזק (%/ס"מ/No.)', damageValue:'ערך הנזק', damageDesc:'תיאור הנזק' };

function addYieldMeasureRow(data) {
    addProgressRow(document.getElementById('yield-measure-tbody'), YIELD_MEASURE_FIELDS, YIELD_MEASURE_LABELS, data || {}, {
        fieldOptions: {
            repeatCount: getYieldRepeatOptionsForTreatment(),
            quality: ['מובחר', "סוג א'", "סוג ב'", "סוג ג'"]
        }
    });
}
function addYieldDamageRow(data) {
    addProgressRow(document.getElementById('yield-damage-tbody'), YIELD_DAMAGE_FIELDS, YIELD_DAMAGE_LABELS, data || {}, {
        fieldOptions: {
            repeatCount: getYieldRepeatOptionsForTreatment(),
            damageIndex: ['%', 'ס"מ', 'No.']
        }
    });
}

// =========================================
// Progress Views – Populate
// =========================================
function populateProgressViews(data) {
    // Irrigation
    const irrigTbody = document.getElementById('irrigation-tbody');
    if (irrigTbody) {
        irrigTbody.innerHTML = '';
        (data.irrigationData || []).forEach(r => addProgressRow(irrigTbody, IRRIGATION_FIELDS, IRRIGATION_LABELS, normalizeLegacyRangeDates(r)));
    }
    // Fertilization
    const fertTbody = document.getElementById('fertilization-tbody');
    if (fertTbody) {
        fertTbody.innerHTML = '';
        (data.fertilizationData || []).forEach(r => addProgressRow(fertTbody, FERTILIZATION_FIELDS, FERTILIZATION_LABELS, normalizeLegacyRangeDates(r), {
            dynamicDatalists: FERTILIZATION_DYNAMIC_DATALISTS
        }));
    }
    // Growth, Climate, Agro – use their render functions (handle defaults)
    renderGrowthTable(data.growthData);
    renderClimateTable(data.climateData);
    renderAgroTable(data.agrotechnicsData);
    renderPollinationTable(data.pollinationData);
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
    const yd = getYieldDataForTreatment(data, currentTreatmentIndex);
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
        pollinationData: collectProgressRows('pollination-tbody', POLLINATION_FIELDS),
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

    // Climate – popup modal (spec: פופ אפ)
    document.getElementById('add-climate-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת נתון אקלים חדש',
            fields: CLIMATE_FIELDS,
            labels: CLIMATE_LABELS,
            skipFields: ['fileName'],
            fieldOptions: { name: CLIMATE_NAME_OPTIONS, location: CLIMATE_LOCATION_OPTIONS },
            onSave: (data) => addProgressRow(document.getElementById('climate-tbody'), CLIMATE_FIELDS, CLIMATE_LABELS, data, {
                fieldOptions: { name: CLIMATE_NAME_OPTIONS, location: CLIMATE_LOCATION_OPTIONS },
                enableFileUpload: true,
                uploadFolder: 'climate'
            })
        })
    );

    // Agrotechnics – popup modal (spec: פופ אפ)
    document.getElementById('add-agro-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת פעולה חדשה',
            fields: AGRO_FIELDS,
            labels: AGRO_LABELS,
            fieldOptions: { action: AGRO_ACTION_OPTIONS },
            onSave: (data) => addProgressRow(document.getElementById('agro-tbody'), AGRO_FIELDS, AGRO_LABELS, data, {
                fieldOptions: { action: AGRO_ACTION_OPTIONS }
            })
        })
    );

    document.getElementById('add-pollination-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת האבקה',
            fields: POLLINATION_FIELDS,
            labels: POLLINATION_LABELS,
            onSave: (data) => addProgressRow(document.getElementById('pollination-tbody'), POLLINATION_FIELDS, POLLINATION_LABELS, data)
        })
    );

    // Pests – popup modal (spec: פופ אפ)
    document.getElementById('add-pest-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת מזיק חדש',
            fields: PEST_FIELDS,
            labels: PEST_LABELS,
            fieldOptions: {
                inoculationType: ['טבעי', 'מלאכותי'],
                inoculationMethod: ['ערבוב בקרקע', 'ריסוס', 'שחרור (חרקים)', 'טבילה', 'שפשוף', 'דקירה', 'אחר']
            },
            onSave: (data) => addPestRow('pest-tbody', data)
        })
    );

    // Diseases – popup modal (spec: פופ אפ)
    document.getElementById('add-disease-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת מחלה חדשה',
            fields: PEST_FIELDS,
            labels: PEST_LABELS,
            fieldOptions: {
                inoculationType: ['טבעי', 'מלאכותי'],
                inoculationMethod: ['ערבוב בקרקע', 'ריסוס', 'שחרור (חרקים)', 'טבילה', 'שפשוף', 'דקירה', 'אחר']
            },
            onSave: (data) => addPestRow('disease-tbody', data)
        })
    );

    // Sprays – popup modal (spec: פופ אפ)
    document.getElementById('add-spray-prot-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת ריסוס חדש',
            fields: PROTECTION_FIELDS,
            labels: PROTECTION_LABELS,
            fieldOptions: { combined: ['לא', 'כן'] },
            dynamicDatalists: { material: 'datalist-plant-protection-material' },
            onSave: (data) => addProtectionRow('spray-prot-tbody', data)
        })
    );

    // Drenches – popup modal (spec: פופ אפ)
    document.getElementById('add-drench-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת הגמעה חדשה',
            fields: PROTECTION_FIELDS,
            labels: PROTECTION_LABELS,
            fieldOptions: { combined: ['לא', 'כן'] },
            dynamicDatalists: { material: 'datalist-plant-protection-material' },
            onSave: (data) => addProtectionRow('drench-tbody', data)
        })
    );

    // Yield Measure – popup modal (spec: פופ אפ)
    document.getElementById('add-yield-measure-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת מדידה חדשה',
            fields: YIELD_MEASURE_FIELDS,
            labels: YIELD_MEASURE_LABELS,
            fieldOptions: {
                repeatCount: getYieldRepeatOptionsForTreatment(),
                quality: ['מובחר', "סוג א'", "סוג ב'", "סוג ג'"]
            },
            onSave: (data) => addYieldMeasureRow(data)
        })
    );

    // Yield Damage – popup modal (spec: פופ אפ)
    document.getElementById('add-yield-damage-row')?.addEventListener('click', () =>
        openGenericRowModal({
            title: 'הוספת פגע חדש',
            fields: YIELD_DAMAGE_FIELDS,
            labels: YIELD_DAMAGE_LABELS,
            fieldOptions: {
                repeatCount: getYieldRepeatOptionsForTreatment(),
                damageIndex: ['%', 'ס"מ', 'No.']
            },
            onSave: (data) => addYieldDamageRow(data)
        })
    );

    // Modal buttons – existing modals
    document.getElementById('irr-modal-cancel')?.addEventListener('click', () => closeModal('irrigation-file-modal'));
    document.getElementById('irr-modal-save')?.addEventListener('click', () => saveIrrigationFile());
    document.getElementById('fert-modal-cancel')?.addEventListener('click', () => closeModal('fertilization-file-modal'));
    document.getElementById('fert-modal-save')?.addEventListener('click', () => saveFertilizationFile());
    document.getElementById('growth-modal-cancel')?.addEventListener('click', () => closeModal('growth-data-modal'));
    document.getElementById('growth-modal-save')?.addEventListener('click', () => saveGrowthData());
    document.getElementById('growth-modal-name')?.addEventListener('change', () => {
        const nameSelect = document.getElementById('growth-modal-name');
        const customRow = document.getElementById('growth-modal-custom-name-row');
        const customInput = document.getElementById('growth-modal-custom-name');
        if (!nameSelect || !customRow || !customInput) return;

        if (nameSelect.value === 'other') {
            customRow.classList.remove('hidden');
            customInput.focus();
        } else {
            customRow.classList.add('hidden');
            customInput.value = '';
        }
    });

    // Generic modal buttons
    document.getElementById('generic-modal-cancel')?.addEventListener('click', () => {
        closeModal('generic-row-modal');
        _genericModalConfig = null;
    });
    document.getElementById('generic-modal-save')?.addEventListener('click', () => saveGenericRow());

    // Dropzone visual
    initDropzone('irr-modal-dropzone', 'irr-modal-file', 'irr-modal-file-name');
    initDropzone('fert-modal-dropzone', 'fert-modal-file', 'fert-modal-file-name');

    document.getElementById('irr-modal-start-date')?.addEventListener('change', () => {
        syncModalDateRange('irr-modal-start-date', 'irr-modal-end-date');
    });
    document.getElementById('fert-modal-start-date')?.addEventListener('change', () => {
        syncModalDateRange('fert-modal-start-date', 'fert-modal-end-date');
    });
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

// =========================================
// Generic Add-Row Modal
// =========================================
let _genericModalConfig = null;

function openGenericRowModal(config) {
    _genericModalConfig = config;
    const title = document.getElementById('generic-modal-title');
    const body = document.getElementById('generic-modal-body');
    if (!title || !body) return;

    title.textContent = config.title;
    body.innerHTML = '';

    const visibleFields = config.fields.filter(f => !(config.skipFields && config.skipFields.includes(f)));

    // Group fields in pairs for 2-column layout
    for (let i = 0; i < visibleFields.length; i += 2) {
        const field1 = visibleFields[i];
        const field2 = visibleFields[i + 1];

        if (field2) {
            const grid = document.createElement('div');
            grid.className = 'modal-form-grid';
            grid.appendChild(_createGenericField(field1, config));
            grid.appendChild(_createGenericField(field2, config));
            body.appendChild(grid);
        } else {
            const wrapper = _createGenericField(field1, config);
            wrapper.className = 'modal-form-row-single';
            body.appendChild(wrapper);
        }
    }

    if (visibleFields.includes('startDate') && visibleFields.includes('endDate')) {
        syncModalDateRange('generic-modal-startDate', 'generic-modal-endDate');
        const startInput = document.getElementById('generic-modal-startDate');
        startInput?.addEventListener('change', () => syncModalDateRange('generic-modal-startDate', 'generic-modal-endDate'));
    }

    wireGenericModalConditionalLogic();

    openModal('generic-row-modal');
    setTimeout(() => {
        const firstInput = body.querySelector('input, select');
        if (firstInput) firstInput.focus();
    }, 100);
}

function updateModalActionOtherVisibility() {
    const actionSelect = document.getElementById('generic-modal-action');
    const otherInput = document.getElementById('generic-modal-actionOther');
    if (!actionSelect || !otherInput) return;
    const otherRow = otherInput.closest('.modal-form-row');
    const shouldShow = actionSelect.value === 'אחר';
    if (otherRow) otherRow.style.display = shouldShow ? '' : 'none';
    if (!shouldShow) otherInput.value = '';
}

function updateModalInoculationMethodVisibility() {
    const typeSelect = document.getElementById('generic-modal-inoculationType');
    const methodSelect = document.getElementById('generic-modal-inoculationMethod');
    if (!typeSelect || !methodSelect) return;
    const methodRow = methodSelect.closest('.modal-form-row');
    const shouldShow = typeSelect.value === 'מלאכותי';
    if (methodRow) methodRow.style.display = shouldShow ? '' : 'none';
    if (!shouldShow) methodSelect.value = '';
}

function wireGenericModalConditionalLogic() {
    const actionSelect = document.getElementById('generic-modal-action');
    if (actionSelect) {
        actionSelect.addEventListener('change', updateModalActionOtherVisibility);
        updateModalActionOtherVisibility();
    }

    const inoculationTypeSelect = document.getElementById('generic-modal-inoculationType');
    if (inoculationTypeSelect) {
        inoculationTypeSelect.addEventListener('change', updateModalInoculationMethodVisibility);
        updateModalInoculationMethodVisibility();
    }
}

function _createGenericField(field, config) {
    const row = document.createElement('div');
    row.className = 'modal-form-row';

    const label = document.createElement('label');
    label.textContent = (config.labels[field] || field) + ':';
    row.appendChild(label);

    const fieldOpts = config.fieldOptions && config.fieldOptions[field];
    if (fieldOpts && Array.isArray(fieldOpts)) {
        const select = document.createElement('select');
        select.className = 'modal-input-sm modal-select';
        select.id = `generic-modal-${field}`;

        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = `בחירת ${config.labels[field] || field}`;
        select.appendChild(emptyOpt);

        fieldOpts.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            select.appendChild(option);
        });
        row.appendChild(select);
    } else {
        const input = document.createElement('input');
        if (field === 'date' || field.endsWith('Date')) {
            input.type = 'date';
        } else if (['hours','workers','dosage','quantity','fruitFloor','damageValue','totalWater','totalFert','amount','hives'].includes(field)) {
            input.type = 'number';
            input.step = 'any';
        } else {
            input.type = 'text';
        }
        input.className = 'modal-input-sm';
        input.id = `generic-modal-${field}`;
        const fieldDatalist = config.dynamicDatalists && config.dynamicDatalists[field];
        if (fieldDatalist && input.type === 'text') {
            input.setAttribute('list', fieldDatalist);
        }
        input.placeholder = config.labels[field] || '';
        row.appendChild(input);
    }

    return row;
}

function saveGenericRow() {
    if (!_genericModalConfig) return;
    const data = {};
    const visibleFields = _genericModalConfig.fields.filter(f => !(_genericModalConfig.skipFields && _genericModalConfig.skipFields.includes(f)));

    visibleFields.forEach(field => {
        const el = document.getElementById(`generic-modal-${field}`);
        if (el) data[field] = el.value;
    });

    if (data.startDate && data.endDate && data.endDate < data.startDate) {
        showToast('תאריך הסיום חייב להיות מאוחר או שווה לתאריך ההתחלה', 'error');
        return;
    }

    if (data.inoculationType === 'מלאכותי' && !hasValue(data.inoculationMethod)) {
        showToast('יש לבחור שיטת אילוח כאשר סוג האילוח הוא מלאכותי', 'error');
        return;
    }

    _genericModalConfig.onSave(data);
    markUserEdited();
    closeModal('generic-row-modal');
    _genericModalConfig = null;
}

function initDropzone(dropzoneId, fileInputId, labelId) {
    const dropzone = document.getElementById(dropzoneId);
    const fileInput = document.getElementById(fileInputId);
    const label = document.getElementById(labelId);
    if (!dropzone || !fileInput) return;

    dropzone.addEventListener('click', (e) => {
        // Don't trigger again if the click came from the file input itself
        if (e.target === fileInput) return;
        fileInput.click();
    });
    // Prevent the file input's native click from bubbling to the dropzone
    fileInput.addEventListener('click', (e) => e.stopPropagation());
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

function syncModalDateRange(startId, endId) {
    const startInput = document.getElementById(startId);
    const endInput = document.getElementById(endId);
    if (!startInput || !endInput) return;

    const startValue = startInput.value;
    if (startValue) {
        endInput.min = startValue;
        if (endInput.value && endInput.value < startValue) {
            endInput.value = startValue;
        }
    } else {
        endInput.removeAttribute('min');
    }
}

// =========================================
// Irrigation Modal
// =========================================
function openIrrigationModal() {
    updateIrrigationWaterUnitLabels();
    document.getElementById('irr-modal-filename').value = '';
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('irr-modal-start-date').value = today;
    document.getElementById('irr-modal-end-date').value = today;
    document.getElementById('irr-modal-total').value = '';
    document.getElementById('irr-modal-notes').value = '';
    document.getElementById('irr-modal-file').value = '';
    document.getElementById('irr-modal-file-name').textContent = 'גרירת קובץ לכאן או לחיצה לבחירה';
    document.getElementById('irr-modal-progress')?.classList.add('hidden');
    syncModalDateRange('irr-modal-start-date', 'irr-modal-end-date');
    openModal('irrigation-file-modal');
}

async function saveIrrigationFile() {
    const fileName = document.getElementById('irr-modal-filename').value.trim();
    const startDate = document.getElementById('irr-modal-start-date').value;
    const endDate = document.getElementById('irr-modal-end-date').value;
    const totalWater = document.getElementById('irr-modal-total').value.trim();
    const notes = document.getElementById('irr-modal-notes').value.trim();
    const fileInput = document.getElementById('irr-modal-file');
    const file = fileInput?.files[0];

    if (!fileName) {
        showToast('יש להזין שם קובץ', 'error');
        return;
    }

    if (!startDate || !endDate) {
        showToast('יש לבחור תאריך התחלה ותאריך סיום', 'error');
        return;
    }

    if (endDate < startDate) {
        showToast('תאריך הסיום חייב להיות מאוחר או שווה לתאריך ההתחלה', 'error');
        return;
    }

    let fileUrl = '';
    let filePath = '';
    const today = new Date().toISOString().split('T')[0];

    if (file) {
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
        startDate,
        endDate,
        totalWater: totalWater,
        notes,
        fileUrl: fileUrl || '',
        filePath: filePath || '',
        originalFileName: file ? file.name : ''
    });

    markUserEdited();
    closeModal('irrigation-file-modal');
    showToast('קובץ השקיה נוסף בהצלחה', 'success');
}

// =========================================
// Fertilization Modal
// =========================================
function openFertilizationModal() {
    document.getElementById('fert-modal-filename').value = '';
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('fert-modal-start-date').value = today;
    document.getElementById('fert-modal-end-date').value = today;
    document.getElementById('fert-modal-type').value = '';
    document.getElementById('fert-modal-company').value = '';
    document.getElementById('fert-modal-total').value = '';
    document.getElementById('fert-modal-notes').value = '';
    document.getElementById('fert-modal-file').value = '';
    document.getElementById('fert-modal-file-name').textContent = 'גרירת קובץ לכאן או לחיצה לבחירה';
    document.getElementById('fert-modal-progress')?.classList.add('hidden');
    syncModalDateRange('fert-modal-start-date', 'fert-modal-end-date');
    openModal('fertilization-file-modal');
}

async function saveFertilizationFile() {
    const fileName = document.getElementById('fert-modal-filename').value.trim();
    const startDate = document.getElementById('fert-modal-start-date').value;
    const endDate = document.getElementById('fert-modal-end-date').value;
    const fertType = document.getElementById('fert-modal-type').value.trim();
    const company = document.getElementById('fert-modal-company').value.trim();
    const totalFert = document.getElementById('fert-modal-total').value.trim();
    const notes = document.getElementById('fert-modal-notes').value.trim();
    const fileInput = document.getElementById('fert-modal-file');
    const file = fileInput?.files[0];

    if (!fileName) {
        showToast('יש להזין שם קובץ', 'error');
        return;
    }

    if (!startDate || !endDate) {
        showToast('יש לבחור תאריך התחלה ותאריך סיום', 'error');
        return;
    }

    if (endDate < startDate) {
        showToast('תאריך הסיום חייב להיות מאוחר או שווה לתאריך ההתחלה', 'error');
        return;
    }

    let fileUrl = '';
    let filePath = '';
    const today = new Date().toISOString().split('T')[0];

    if (file) {
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
    registerDynamicOption('fertilizerType', fertType);
    registerDynamicOption('fertilizerCompany', company);

    addProgressRow(tbody, FERTILIZATION_FIELDS, FERTILIZATION_LABELS, {
        fileName: fileName,
        uploadDate: today,
        startDate,
        endDate,
        fertType: fertType,
        company: company,
        totalFert: totalFert,
        notes,
        fileUrl: fileUrl || '',
        filePath: filePath || '',
        originalFileName: file ? file.name : ''
    }, {
        dynamicDatalists: FERTILIZATION_DYNAMIC_DATALISTS
    });

    markUserEdited();
    closeModal('fertilization-file-modal');
    showToast('קובץ דישון נוסף בהצלחה', 'success');
}

// =========================================
// Growth Modal
// =========================================
function openGrowthModal() {
    document.getElementById('growth-modal-name').value = '';
    const customNameInput = document.getElementById('growth-modal-custom-name');
    if (customNameInput) customNameInput.value = '';
    document.getElementById('growth-modal-date').value = '';
    document.getElementById('growth-modal-value').value = '';
    document.getElementById('growth-modal-custom-name-row')?.classList.add('hidden');
    openModal('growth-data-modal');
}

function saveGrowthData() {
    let name = document.getElementById('growth-modal-name').value;
    const customNameInput = document.getElementById('growth-modal-custom-name');
    const measureDate = document.getElementById('growth-modal-date').value;
    const value = document.getElementById('growth-modal-value').value.trim();

    if (name === 'other') {
        const customName = customNameInput?.value.trim() || '';
        if (!customName) {
            showToast('יש להזין שם נתון', 'error');
            return;
        }
        name = customName;
    }

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

    markUserEdited();
    closeModal('growth-data-modal');
    showToast('נתון צימוח נוסף בהצלחה', 'success');
}

// =========================================
// Upload File to Firebase Storage (shared)
// =========================================
async function uploadProgressFile(file, folder, progressId, fillId, textId) {
    // בדיקת גודל קובץ – מקסימום 10MB (בהתאם ל-Storage Rules)
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
        throw new Error('גודל הקובץ חורג מהמגבלה (10MB מקסימום)');
    }
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
                    resolve({ url, path, originalName: file.name });
                } catch (err) { reject(err); }
            }
        );
    });
}

// =========================================
// AI-assisted experiment import adapter
// =========================================
function initExperimentAI() {
    // Intentionally disabled until the planned AI/LLM launch. The single
    // release switch lives in experiment-ai-config.js.
    if (window.EXPERIMENT_AI_ENABLED !== true) return;

    if (!experimentAI) {
        experimentAI = createExperimentAIIntegration({
            state: {
                get currentUser() { return currentUser; },
                get currentExperimentId() { return currentExperimentId; },
                get currentView() { return currentView; },
                get currentTreatmentIndex() { return currentTreatmentIndex; },
                get permissionsState() { return permissionsState; },
                get experimentOwnerUid() { return experimentOwnerUid; },
                get experimentData() { return experimentData; },
                set experimentData(value) { experimentData = value; },
                get eventsData() { return eventsData; },
                set eventsData(value) { eventsData = value; },
                get financialData() { return financialData; },
                set financialData(value) { financialData = value; },
                get lastRealtimeDataSignature() { return lastRealtimeDataSignature; },
                set lastRealtimeDataSignature(value) { lastRealtimeDataSignature = value; },
                set hasUserEditedSinceSave(value) { hasUserEditedSinceSave = value; },
                get isAutoSaveEnabled() { return isAutoSaveEnabled; },
                set isAutoSaveEnabled(value) { isAutoSaveEnabled = value; },
                get autoSaveQueued() { return autoSaveQueued; },
                set autoSaveQueued(value) { autoSaveQueued = value; },
                get autoSaveTimeoutId() { return autoSaveTimeoutId; },
                set autoSaveTimeoutId(value) { autoSaveTimeoutId = value; }
            },
            SHARED_SECTION_IDS,
            STUDY_TYPES,
            addKeywordTag,
            addVariableRow,
            collectEventsData,
            collectFinancialData,
            collectFormData,
            collectTreatmentInputsFromDOM,
            deepClone,
            ensureModelTreatmentLength,
            generateTreatmentInputs,
            generateTreatmentTabs,
            getCurrentRepetitionsCount,
            getCurrentStudyType,
            getCurrentTreatmentsCount,
            getPermissionShareEntries,
            getRealtimeDataSignature,
            getResolvedAdiganAmount,
            getSectionIdByView,
            getSectionModel,
            loadCurrentSectionDataFromState,
            persistCurrentSectionDataToState,
            persistDynamicFieldOptions,
            persistGlobalKeywordOptions,
            renderEventsTable,
            renderFinancialTable,
            saveExperiment,
            setFieldValue,
            setLastSavedFormSignatureFromCurrent,
            setStudyTypeValue,
            switchTreatmentTab,
            switchView,
            syncAllSectionTreatmentCounts,
            syncSharedExperiments,
            updateAutoSaveIndicator,
            updateConditionalFieldVisibility,
            updateExperimentDisplayName,
            updateExperimentSiteOtherVisibility
        });
    }
    experimentAI.init();
}
