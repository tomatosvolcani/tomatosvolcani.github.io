// js/experiment-ai-integration.js
// Integration layer between the experiment form and the AI import controller.
// Experiment-specific mappings, draft application and AI review persistence live here.

import { db } from "./firebase-config.js";
import {
    doc,
    updateDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast, showConfirmModal } from "./toast.js";
import { ExperimentAIController } from "./experiment-ai.js?v=20260802-cloud-function";
import { wireExperimentAIController, AIFieldMark } from "./experiment-ai-enhance.js?v=20260731-ai-pro4";

export function createExperimentAIIntegration(adapter) {
    const {
        state,
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
    } = adapter;

    let aiController = null;
    let aiModeActive = false;
    const aiDirtyViews = new Set();
    let aiAppliedCount = 0;

    // AI-assisted experiment import integration
    const AI_VIEW_LABELS = {
        basic: 'תוכנית הניסוי',
        crop: 'פרטי הגידול',
        structure: 'מבנה',
        soil: 'טיפול בקרקע',
        drip: 'סוג ופריסת הטפטוף',
        irrigation: 'השקיה ודשן',
        growth: 'צימוח',
        climate: 'נתוני אקלים וסנסורים',
        agrotechnics: 'אגרוטכניקה והאבקה',
        'plant-protection': 'הגנת הצומח',
        yield: 'נתוני יבול',
        events: 'יומן אירועים',
        'financial-analysis': 'ניתוחים פיננסים'
    };
    
    const AI_SECTION_TO_VIEW = {
        crop: 'crop',
        structure: 'structure',
        soil: 'soil',
        drip: 'drip',
        irrigation: 'irrigation',
        growth: 'growth',
        climate: 'climate',
        agrotechnics: 'agrotechnics',
        plantProtection: 'plant-protection',
        yield: 'yield'
    };
    
    const AI_BASIC_FIELDS = {
        experimentName: { id: 'experiment-name', label: 'שם הניסוי' },
        experimentYear: { id: 'experiment-year', label: 'שנת הניסוי', valueType: 'integer' },
        experimentMonth: { id: 'experiment-month', label: 'חודש הניסוי' },
        researchPeriod: { id: 'research-period', label: 'תקופת מחקר' },
        studyType: { id: 'study-type', label: 'סוג מחקר', allowedValues: ['field', 'lab'] },
        workPackage: { id: 'work-package', label: 'חבילת עבודה' },
        experimentSiteSelection: { id: 'experiment-site', label: 'אתר הניסוי' },
        experimentSiteOther: { id: 'experiment-site-other', label: 'אתר אחר' },
        siteCoordinates: { id: 'site-coordinates', label: 'קואורדינטות אתר הניסוי' },
        labCellNumber: { id: 'lab-cell-number', label: 'מספר תא מעבדה' },
        experimentGoal: { id: 'experiment-goal', label: 'מטרת הניסוי' },
        experimentSummary: { id: 'experiment-summary', label: 'תקציר הניסוי' },
        treatmentsCount: { id: 'treatments-count', label: 'מספר טיפולים', valueType: 'integer' },
        repetitionsCount: { id: 'repetitions-count', label: 'מספר חזרות', valueType: 'integer' },
        levelsCount: { id: 'levels-count', label: 'מספר רמות', valueType: 'integer' },
        levelValue: { id: 'level-value', label: 'ערך רמה' }
    };
    
    // שדות סקלריים לפי מקטע. רק crop / structure / soil / drip מופיעים כאן —
    // המקטעים irrigation, growth, climate, agrotechnics, plantProtection, yield
    // אינם מכילים שדות בודדים אלא טבלאות בלבד, והם מכוסים ב-AI_SECTION_COLLECTIONS.
    const AI_SECTION_FIELDS = {
        crop: {
            plantingDate: { id: 'planting-date', label: 'תאריך שתילה', valueType: 'date' },
            inoculationDate1: { id: 'inoculation-date-1', label: 'תאריך אילוח ראשון', valueType: 'date' },
            inoculationDate2: { id: 'inoculation-date-2', label: 'תאריך אילוח שני', valueType: 'date' },
            cropType: { id: 'crop-type', label: 'סוג גידול' },
            graftedPlant: { id: 'grafted-plant', label: 'צמח מורכב' },
            varietyType: { id: 'variety-type', label: 'סוג זן' },
            splitPlant: { id: 'split-plant', label: 'צמח מפוצל' },
            nursery: { id: 'nursery', label: 'משתלה' },
            seedlingsCount: { id: 'seedlings-count', label: 'מספר שתילים', valueType: 'integer' },
            plantingDensity: { id: 'planting-density', label: 'צפיפות שתילה', valueType: 'number' },
            potsCount: { id: 'pots-count', label: 'מספר עציצים', valueType: 'integer' },
            seedlingsPerPot: { id: 'seedlings-per-pot', label: 'שתילים לעציץ', valueType: 'integer' },
            plantingStructure: { id: 'planting-structure', label: 'מבנה השתילה' },
            experimentArea: { id: 'experiment-area', label: 'שטח הניסוי', valueType: 'number' },
            preparationName: { id: 'preparation-name', label: 'שם הכנה' },
            notes: { id: 'crop-notes', label: 'הערות גידול' }
        },
        structure: {
            type: { id: 'structure-type', label: 'סוג מבנה' },
            size: { id: 'structure-size', label: 'גודל המבנה', valueType: 'number' },
            roofCovering: { id: 'roof-covering', label: 'חיפוי גג' },
            cellTempMode: { id: 'cell-temp-mode', label: 'אופן טמפרטורת תא' },
            cellTempFixed: { id: 'cell-temp-fixed', label: 'טמפרטורה קבועה', valueType: 'number' },
            cellTempMinNight: { id: 'cell-temp-min-night', label: 'טמפרטורת מינימום בלילה', valueType: 'number' },
            cellTempMaxDay: { id: 'cell-temp-max-day', label: 'טמפרטורת מקסימום ביום', valueType: 'number' },
            direction: { id: 'structure-direction', label: 'כיוון המבנה' },
            notes: { id: 'structure-notes', label: 'הערות מבנה' }
        },
        soil: {
            detachedSubstrate: { id: 'detached-substrate', label: 'מצע מנותק' },
            substrateCompany: { id: 'substrate-company', label: 'חברת מצע' },
            substrateType: { id: 'substrate-type', label: 'סוג מצע' },
            substrateVolume: { id: 'substrate-volume', label: 'נפח מצע', valueType: 'number' },
            disinfectionAdigan: { id: 'soil-disinfection-adigan', label: 'חיטוי אדיגן' },
            adiganAmount: { id: 'soil-adigan-amount', label: 'כמות אדיגן' }
        },
        drip: {
            singleDouble: { id: 'drip-single-double', label: 'שלוחה יחידה או כפולה' },
            pipeDiameter: { id: 'drip-pipe-diameter', label: 'קוטר צינור', valueType: 'number' },
            type: { id: 'drip-type', label: 'סוג טפטוף' },
            emitterSpacing: { id: 'drip-emitter-spacing', label: 'מרווח טפטפות', valueType: 'number' },
            flowRate: { id: 'drip-flow-rate', label: 'ספיקת טפטפת', valueType: 'number' },
            irrigationDurationMinutes: { id: 'drip-irrigation-duration-minutes', label: 'משך השקיה בדקות', valueType: 'integer' },
            irrigationsPerDay: { id: 'drip-irrigations-per-day', label: 'השקיות ביום', valueType: 'integer' },
            linesCount: { id: 'drip-lines-count', label: 'מספר שלוחות', valueType: 'integer' }
        }
    };
    
    const AI_COLLECTIONS = {
        'collection.basic.treatments': {
            page: 'basic', label: 'טיפולים וחזרות', current: () => collectTreatmentInputsFromDOM(),
            rowSchema: { name: 'string', repeatLabels: 'array of strings' }
        },
        'collection.basic.independentVariables': {
            page: 'basic', label: 'משתנים בלתי תלויים', current: () => Array.from(document.querySelectorAll('.independent-var-input')).map(el => el.value.trim()).filter(Boolean),
            rowSchema: { value: 'string' }
        },
        'collection.basic.dependentVariables': {
            page: 'basic', label: 'משתנים תלויים', current: () => Array.from(document.querySelectorAll('.dependent-var-input')).map(el => el.value.trim()).filter(Boolean),
            rowSchema: { value: 'string' }
        },
        'collection.basic.keywords': {
            page: 'basic', label: 'מילות מפתח', current: () => Array.from(document.querySelectorAll('#keywords-list .keyword-tag')).map(el => el.dataset.value).filter(Boolean),
            rowSchema: { value: 'string' }
        },
        'collection.events': {
            page: 'events', label: 'יומן אירועים', current: () => collectEventsData(),
            rowSchema: { date: 'YYYY-MM-DD', description: 'string' }
        },
        'collection.financial': {
            page: 'financial-analysis', label: 'ניתוחים פיננסיים', current: () => collectFinancialData(),
            rowSchema: { date: 'YYYY-MM-DD', description: 'string' }
        }
    };
    
    const AI_SECTION_COLLECTIONS = {
        crop: {
            varieties: { label: 'זנים', rowSchema: { value: 'string' } }
        },
        soil: {
            compostRows: { label: 'קומפוסט', rowSchema: { date: 'YYYY-MM-DD', amount: 'string', method: 'string' } },
            disinfectRows: { label: 'חיטויי קרקע', rowSchema: { date: 'YYYY-MM-DD', material: 'string', amount: 'string', method: 'string' } },
            cultivationRows: { label: 'עיבודי קרקע', rowSchema: { date: 'YYYY-MM-DD', action: 'string', depth: 'string', notes: 'string' } }
        },
        drip: {
            irrigationTimes: { label: 'שעות השקיה ביום', rowSchema: { time: 'HH:MM' } }
        },
        irrigation: {
            irrigationData: { label: 'נתוני השקיה', rowSchema: { fileName: 'string', uploadDate: 'YYYY-MM-DD', startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', totalWater: 'string', notes: 'string' } },
            fertilizationData: { label: 'נתוני דישון', rowSchema: { fileName: 'string', uploadDate: 'YYYY-MM-DD', startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', fertType: 'string', company: 'string', totalFert: 'string', notes: 'string' } }
        },
        growth: {
            growthData: { label: 'מדדי צימוח', rowSchema: { name: 'string', value: 'string', measureDate: 'YYYY-MM-DD' } }
        },
        climate: {
            climateData: { label: 'נתוני אקלים וסנסורים', rowSchema: { name: 'string', location: 'string', sensorPosition: 'string', sensorDepth: 'string', startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', fileName: 'string', notes: 'string' } }
        },
        agrotechnics: {
            agrotechnicsData: { label: 'פעולות אגרוטכניות', rowSchema: { action: 'string', actionOther: 'string', actionDate: 'YYYY-MM-DD', hours: 'string', workers: 'string' } },
            pollinationData: { label: 'האבקה', rowSchema: { date: 'YYYY-MM-DD', hives: 'string' } }
        },
        plantProtection: {
            pests: { label: 'מזיקים', rowSchema: { pest: 'string', date: 'YYYY-MM-DD', inoculationType: 'string', inoculationMethod: 'string', inoculationAmount: 'string', notes: 'string' } },
            diseases: { label: 'מחלות', rowSchema: { pest: 'string', date: 'YYYY-MM-DD', inoculationType: 'string', inoculationMethod: 'string', inoculationAmount: 'string', notes: 'string' } },
            sprays: { label: 'ריסוסים', rowSchema: { material: 'string', date: 'YYYY-MM-DD', dosage: 'string', combined: 'string', notes: 'string' } },
            drenches: { label: 'הגמעות', rowSchema: { material: 'string', date: 'YYYY-MM-DD', dosage: 'string', combined: 'string', notes: 'string' } }
        },
        yield: {
            measures: { label: 'מדידות יבול', rowSchema: { measureDate: 'YYYY-MM-DD', repeatCount: 'string', fruitFloor: 'string', quality: 'string', quantity: 'string', fruitDesc: 'string', notes: 'string' } },
            damages: { label: 'נזקי יבול', rowSchema: { measureDate: 'YYYY-MM-DD', repeatCount: 'string', damage: 'string', damageIndex: 'string', damageValue: 'string', damageDesc: 'string' } }
        }
    };
    
    // מיפוי כל טבלת collection ל-tbody שלה, לצורך סימון שורות שנוספו ע"י AI.
    const AI_COLLECTION_TBODY = {
        soil: { compostRows: 'compost-tbody', disinfectRows: 'disinfect-tbody', cultivationRows: 'cultivation-tbody' },
        irrigation: { irrigationData: 'irrigation-tbody', fertilizationData: 'fertilization-tbody' },
        growth: { growthData: 'growth-tbody' },
        climate: { climateData: 'climate-tbody' },
        agrotechnics: { agrotechnicsData: 'agro-tbody', pollinationData: 'pollination-tbody' },
        plantProtection: { pests: 'pest-tbody', diseases: 'disease-tbody', sprays: 'spray-prot-tbody', drenches: 'drench-tbody' },
        yield: { measures: 'yield-measure-tbody', damages: 'yield-damage-tbody' }
    };
    
    // קורא את ערכי השדות של שורת <tr> לפי data-field.
    function readAiRowData(tr) {
        const data = {};
        tr.querySelectorAll('[data-field]').forEach((el) => {
            const key = el.dataset.field;
            if (key && !(key in data)) data[key] = String(el.value ?? '').trim();
        });
        return data;
    }
    
    // בודק אם שורת ה-DOM תואמת לשורת ה-AI. משווים רק על השדות שקיימים בפועל
    // בשורת ה-DOM (החיתוך), כדי שגם טבלה שמציגה תת-קבוצה של הסכימה תזוהה נכון.
    function aiRowMatches(rowData, aiRow) {
        if (!aiRow || typeof aiRow !== 'object') return false;
        const keys = Object.keys(aiRow)
            .filter((k) => hasAiMeaningfulValue(aiRow[k]) && k in rowData);
        if (!keys.length) return false;
        return keys.every((k) => String(rowData[k] ?? '').trim() === String(aiRow[k] ?? '').trim());
    }
    
    // מחזיר את שורות ה-<tr> בטבלה הנוכחית שתואמות לשורות שה-AI הוסיף.
    function resolveAiCollectionRows(sectionId, scope, key, update) {
        const tbodyId = AI_COLLECTION_TBODY[sectionId]?.[key];
        if (!tbodyId) return null;
        if (AI_SECTION_TO_VIEW[sectionId] !== state.currentView) return null;
        if (scope !== 'shared') {
            const index = Number(scope.replace('treatment_', '')) - 1;
            if (!Number.isInteger(index) || index !== state.currentTreatmentIndex) return null;
        }
        let aiRows = [];
        try {
            const decoded = JSON.parse(update?.value_json || '[]');
            aiRows = Array.isArray(decoded) ? decoded : [decoded];
        } catch { return null; }
        if (!aiRows.length) return null;
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return null;
        return [...tbody.querySelectorAll('tr')].filter((tr) => aiRows.some((ai) => aiRowMatches(readAiRowData(tr), ai)));
    }
    
    function init() {
        if (aiController || !document.getElementById('btn-ai-mode')) return;
        aiController = new ExperimentAIController({
            canEdit: () => Boolean(state.permissionsState?.canEdit),
            enterMode: enterAiReviewMode,
            exitMode: exitAiReviewMode,
            getAuthToken: () => state.currentUser?.getIdToken?.() || '',
            buildContext: buildAiExperimentContext,
            applyExtraction: applyAiExtraction,
            saveCurrentPage: saveAiCurrentPage,
            saveAll: saveAiAll,
            cancelDraft: cancelAiDraft,
            getReviewState: () => ({ dirtyViews: [...aiDirtyViews], appliedCount: aiAppliedCount }),
            notify: (message, type = 'info') => showToast(message, type)
        });
        aiController.init();
        wireExperimentAIController(aiController, {
            resolveField(path, update) {
                // שדות תאריך משתמשים ב-flatpickr, שמסתיר את ה-input המקורי ומציג
                // altInput נפרד. מסמנים את השדה הנראה כדי שהמסגרת תופיע במקום הנכון.
                const visible = (el) => (el && el._flatpickr && el._flatpickr.altInput) ? el._flatpickr.altInput : el;
                const parts = path.split('.');
                if (parts[0] === 'basic' && parts.length === 2) {
                    const desc = AI_BASIC_FIELDS[parts[1]];
                    return desc ? visible(document.getElementById(desc.id)) : null;
                }
                if (parts[0] === 'section' && parts.length === 4) {
                    const sectionId = parts[1], scope = parts[2], key = parts[3];
                    const desc = AI_SECTION_FIELDS[sectionId]?.[key];
                    // מפתח שאינו שדה רגיל אך הוא טבלה (collection) — מסמנים את שורות ה-<tr>.
                    if (!desc) {
                        if (AI_SECTION_COLLECTIONS[sectionId]?.[key]) {
                            return resolveAiCollectionRows(sectionId, scope, key, update);
                        }
                        return null;
                    }
                    if (AI_SECTION_TO_VIEW[sectionId] !== state.currentView) return null;
                    if (scope !== 'shared') {
                        const index = Number(scope.replace('treatment_', '')) - 1;
                        if (!Number.isInteger(index) || index !== state.currentTreatmentIndex) return null;
                    }
                    return visible(document.getElementById(desc.id));
                }
                // זן הוא collection שמוצג כ-chip עם X. מסמנים את ה-chip עצמו.
                if (parts[0] === 'collection' && parts[1] === 'section' && parts[2] === 'crop' && parts[4] === 'varieties') {
                    const scope = parts[3];
                    if (state.currentView !== 'crop') return null;
                    if (scope !== 'shared') {
                        const index = Number(scope.replace('treatment_', '')) - 1;
                        if (!Number.isInteger(index) || index !== state.currentTreatmentIndex) return null;
                    }
                    let wanted = [];
                    try {
                        const decoded = JSON.parse(update?.value_json || '[]');
                        wanted = (Array.isArray(decoded) ? decoded : [decoded]).map(v => String(v?.variety || v?.value || v).trim());
                    } catch { /* הדוח עדיין מאפשר ניווט */ }
                    return [...document.querySelectorAll('#varieties-list .variety-tag')]
                        .filter(tag => !wanted.length || wanted.includes(String(tag.dataset.value || '').trim()));
                }
                return null;
            },
            describeField(path) {
                const parts = path.split('.');
                if (parts[0] === 'basic') {
                    const desc = AI_BASIC_FIELDS[parts[1]];
                    return { view: 'basic', viewLabel: AI_VIEW_LABELS.basic, fieldLabel: desc?.label || parts[1] };
                }
                if (parts[0] === 'section' || (parts[0] === 'collection' && parts[1] === 'section')) {
                    const offset = parts[0] === 'section' ? 0 : 1;
                    const sectionId = parts[1 + offset], key = parts[3 + offset];
                    const view = AI_SECTION_TO_VIEW[sectionId] || sectionId;
                    const label = AI_SECTION_FIELDS[sectionId]?.[key]?.label || AI_SECTION_COLLECTIONS[sectionId]?.[key]?.label || (sectionId === 'crop' && key === 'varieties' ? 'זן' : key);
                    return { view, viewLabel: AI_VIEW_LABELS[view] || view, fieldLabel: label };
                }
                return { view: 'basic', viewLabel: AI_VIEW_LABELS.basic, fieldLabel: path };
            },
            navigateTo(record) {
                const parts = record.path.split('.');
                const offset = parts[0] === 'collection' ? 1 : 0;
                const scope = (parts[0] === 'section' || parts[0] === 'collection') ? parts[2 + offset] : '';
                switchView(record.view || 'basic');
                if (scope && scope !== 'shared') {
                    const index = Number(scope.replace('treatment_', '')) - 1;
                    if (Number.isInteger(index) && index >= 0) switchTreatmentTab(index);
                }
            }
        });
        // Keep the AI assistant visible in the sidebar. The controller still enforces
        // edit permissions when the user tries to use it.
    }
    
    function enterAiReviewMode() {
        aiModeActive = true;
        state.isAutoSaveEnabled = false;
        state.autoSaveQueued = false;
        if (state.autoSaveTimeoutId) {
            clearTimeout(state.autoSaveTimeoutId);
            state.autoSaveTimeoutId = null;
        }
        document.body.classList.add('ai-review-mode');
        updateAutoSaveIndicator('ai-review');
    }
    
    function exitAiReviewMode(force = false) {
        if (aiDirtyViews.size && !force) return false;
        aiModeActive = false;
        state.isAutoSaveEnabled = true;
        document.body.classList.remove('ai-review-mode');
        document.getElementById('ai-review-bar')?.classList.add('hidden');
        updateAutoSaveIndicator('idle');
        return true;
    }
    
    function getAiAllowedValues(element) {
        if (!element || element.tagName !== 'SELECT') return [];
        return Array.from(element.options)
            .map(option => option.value)
            .filter(value => value !== '');
    }
    
    function getAiDomValue(id) {
        if (id === 'study-type') return getCurrentStudyType();
        if (id === 'soil-adigan-amount') return getResolvedAdiganAmount();
        return document.getElementById(id)?.value ?? '';
    }
    
    function normalizeAiValueForType(value, valueType = 'string') {
        if (valueType === 'integer') {
            const parsed = Number.parseInt(value, 10);
            return Number.isFinite(parsed) ? parsed : value;
        }
        if (valueType === 'number') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : value;
        }
        return value;
    }
    
    function inferAiValueType(element) {
        if (!element) return 'string';
        if (element.type === 'date') return 'date';
        // <input type="number"> ללא step שלם נחשב עשרוני; step="1" מעיד על מספר שלם.
        if (element.type === 'number') {
            const step = String(element.step || '').trim();
            return step === '1' ? 'integer' : 'number';
        }
        return 'string';
    }
    
    function makeAiScalarEntry(path, page, descriptor, currentValue) {
        const element = document.getElementById(descriptor.id);
        const valueType = descriptor.valueType || inferAiValueType(element);
        return {
            path,
            kind: 'scalar',
            page,
            page_label: AI_VIEW_LABELS[page] || page,
            label: descriptor.label,
            value_type: valueType,
            // ערכי ה-options נשלחים כפי שהם ב-DOM: אלה בדיוק המחרוזות שיוכתבו
            // ל-el.value בהמשך. המרת טיפוס כאן שברה את ההשוואה בשרת.
            allowed_values: descriptor.allowedValues || getAiAllowedValues(element),
            current_value: normalizeAiValueForType(currentValue, valueType),
            instructions: 'Return only an explicit value supported by the source. Never clear the field.'
        };
    }
    
    function getAiScopeData(sectionId, scope) {
        const model = getSectionModel(sectionId);
        ensureModelTreatmentLength(model);
        if (scope === 'shared') return deepClone(model.sharedData || {});
        const index = Math.max(0, Number(scope.replace('treatment_', '')) - 1);
        return deepClone(model.byTreatment?.[index] || {});
    }
    
    function getAiCollectionValue(sectionId, data, key) {
        if (sectionId === 'plantProtection') return deepClone(data?.plantProtectionData?.[key] || []);
        if (sectionId === 'yield') return deepClone(data?.yieldData?.[key] || []);
        return deepClone(data?.[key] || []);
    }
    
    function buildAiExperimentContext({ allowOverwriteExisting = false } = {}) {
        persistCurrentSectionDataToState();
        const catalog = [];
    
        Object.entries(AI_BASIC_FIELDS).forEach(([key, descriptor]) => {
            catalog.push(makeAiScalarEntry(`basic.${key}`, 'basic', descriptor, getAiDomValue(descriptor.id)));
        });
    
        Object.entries(AI_COLLECTIONS).forEach(([path, descriptor]) => {
            catalog.push({
                path,
                kind: 'collection',
                page: descriptor.page,
                page_label: AI_VIEW_LABELS[descriptor.page],
                label: descriptor.label,
                row_schema: descriptor.rowSchema,
                current_value: descriptor.current(),
                merge_policy: allowOverwriteExisting ? 'replace_or_append' : 'append_only'
            });
        });
    
        const treatmentsCount = getCurrentTreatmentsCount();
        SHARED_SECTION_IDS.forEach((sectionId) => {
            const model = getSectionModel(sectionId);
            ensureModelTreatmentLength(model, treatmentsCount);
            const scopes = model.shared
                ? ['shared']
                : Array.from({ length: treatmentsCount }, (_, index) => `treatment_${index + 1}`);
            const page = AI_SECTION_TO_VIEW[sectionId];
    
            scopes.forEach((scope) => {
                const data = getAiScopeData(sectionId, scope);
                Object.entries(AI_SECTION_FIELDS[sectionId] || {}).forEach(([key, descriptor]) => {
                    catalog.push(makeAiScalarEntry(`section.${sectionId}.${scope}.${key}`, page, descriptor, data?.[key] ?? ''));
                });
                Object.entries(AI_SECTION_COLLECTIONS[sectionId] || {}).forEach(([key, descriptor]) => {
                    catalog.push({
                        path: `section.${sectionId}.${scope}.${key}`,
                        kind: 'collection',
                        page,
                        page_label: AI_VIEW_LABELS[page],
                        label: descriptor.label,
                        row_schema: descriptor.rowSchema,
                        current_value: getAiCollectionValue(sectionId, data, key),
                        merge_policy: allowOverwriteExisting ? 'replace_or_append' : 'append_only'
                    });
                });
            });
        });
    
        return {
            experiment: {
                id: state.currentExperimentId,
                name: document.getElementById('experiment-name')?.value || '',
                study_type: getCurrentStudyType(),
                treatments_count: treatmentsCount,
                current_treatment: state.currentTreatmentIndex + 1,
                current_page: state.currentView
            },
            policy: {
                allow_overwrite_existing: Boolean(allowOverwriteExisting),
                draft_only: true,
                forbidden_categories: ['permissions', 'privacy', 'partners', 'ownerUid', 'creatorName', 'file URLs', 'system metadata']
            },
            catalog
        };
    }
    
    function hasAiMeaningfulValue(value) {
        if (value === null || value === undefined || value === '') return false;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.keys(value).length > 0;
        return true;
    }
    
    /**
     * חתימה יציבה להשוואת פריטי אוסף. JSON.stringify גולמי תלוי בסדר המפתחות
     * וברווחים, ולכן שורה זהה שהגיעה מה-AI נספרה כחדשה ושוכפלה בטבלה.
     */
    function aiItemSignature(item) {
        if (item === null || item === undefined) return '';
        if (typeof item !== 'object') return String(item).trim().toLowerCase();
        if (Array.isArray(item)) return `[${item.map(aiItemSignature).join('|')}]`;
        return Object.keys(item)
            .filter(key => hasAiMeaningfulValue(item[key]))
            .sort()
            .map(key => `${key}=${aiItemSignature(item[key])}`)
            .join('&');
    }
    
    function mergeAiArrays(existing, incoming, allowOverwrite, operation) {
        const safeIncoming = Array.isArray(incoming) ? incoming.filter(hasAiMeaningfulValue) : [];
        if (allowOverwrite && operation === 'set') return deepClone(safeIncoming);
        const merged = [...(Array.isArray(existing) ? existing : [])];
        const seen = new Set(merged.map(aiItemSignature));
        safeIncoming.forEach(item => {
            const signature = aiItemSignature(item);
            if (!seen.has(signature)) {
                merged.push(deepClone(item));
                seen.add(signature);
            }
        });
        return merged;
    }
    
    function markAiElement(id, update) {
        const element = document.getElementById(id);
        if (!element) return;
        element.classList.add('ai-proposed-field');
        const confidence = Number(update?.confidence || 0);
        const evidence = String(update?.evidence || '').trim();
        element.dataset.aiConfidence = confidence.toFixed(2);
        element.title = `הצעת AI (${Math.round(confidence * 100)}%)${evidence ? `: ${evidence}` : ''}`;
    }
    
    /**
     * כתיבה מאומתת של ערך AI לשדה קלט.
     * שונה מ-setFieldValue בכך שהיא מדווחת על כישלון: ב-<select> שאין בו option
     * מתאים ההשמה נבלעת בשקט, וללא הבדיקה הזו השדה היה מסומן "מולא על ידי AI"
     * בלי שהערך באמת נכתב.
     * @returns {boolean} האם הערך אכן נמצא בשדה לאחר הכתיבה.
     */
    function setAiFieldValueChecked(id, value, { dispatch = true } = {}) {
        const element = document.getElementById(id);
        if (!element || value === undefined || value === null) return false;
        const nextValue = String(value);
    
        if (element.tagName === 'SELECT' && !Array.from(element.options).some(option => option.value === nextValue)) {
            return false;
        }
    
        element.value = nextValue;
        if (String(element.value) !== nextValue) return false;
    
        // מדמים עריכה ידנית כדי שלוגיקה תלוית-שדה תתעורר. רק 'change' —
        // 'input' היה מסמן את ה-badge כ"אומת" מיד (ראה AIFieldMark.mark).
        if (dispatch) element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    
    function setAiBasicValue(key, value, update, allowOverwrite) {
        const descriptor = AI_BASIC_FIELDS[key];
        if (!descriptor) return { applied: false, reason: 'שדה בסיסי לא מוכר' };
        const current = getAiDomValue(descriptor.id);
        if (!allowOverwrite && hasAiMeaningfulValue(current)) {
            return { applied: false, skipped: true, reason: `לשדה כבר יש ערך ("${current}") ודריסה לא סומנה` };
        }
    
        if (key === 'studyType') {
            if (!STUDY_TYPES.includes(String(value))) {
                return { applied: false, reason: 'סוג המחקר אינו אחד מהערכים המותרים' };
            }
            setStudyTypeValue(String(value));
        } else if (key === 'experimentSiteSelection') {
            if (!setAiFieldValueChecked(descriptor.id, value, { dispatch: false })) {
                return { applied: false, reason: 'הערך לא נתמך ברשימת האפשרויות' };
            }
            updateExperimentSiteOtherVisibility();
        } else if (key === 'treatmentsCount') {
            const count = Math.max(1, Number.parseInt(value, 10) || 1);
            setFieldValue(descriptor.id, count);
            generateTreatmentInputs(count, collectTreatmentInputsFromDOM(), getCurrentRepetitionsCount());
            syncAllSectionTreatmentCounts();
            generateTreatmentTabs();
        } else if (key === 'repetitionsCount') {
            const count = Math.max(1, Number.parseInt(value, 10) || 1);
            setFieldValue(descriptor.id, count);
            generateTreatmentInputs(getCurrentTreatmentsCount(), collectTreatmentInputsFromDOM(), count);
        } else {
            // אין dispatch ל-treatments/repetitions: המטפלים שלהם משכפלים עבודה
            // שכבר נעשתה כאן (generateTreatmentInputs / generateTreatmentTabs).
            if (!setAiFieldValueChecked(descriptor.id, value)) {
                return { applied: false, reason: 'הערך לא נתמך ברשימת האפשרויות' };
            }
        }
    
        updateConditionalFieldVisibility();
        markAiElement(descriptor.id, update);
        aiDirtyViews.add('basic');
        return { applied: true, marked: true };
    }
    
    function setAiSectionValue(sectionId, scope, key, value, update, allowOverwrite) {
        const descriptor = AI_SECTION_FIELDS[sectionId]?.[key];
        if (!descriptor) return { applied: false, reason: 'שדה מקטע לא מוכר' };
        const model = getSectionModel(sectionId);
        ensureModelTreatmentLength(model);
        const isSharedScope = scope === 'shared';
        if (isSharedScope !== Boolean(model.shared)) return { applied: false, reason: 'היקף השדה אינו תואם להגדרת משותף/לפי טיפול' };
        let index = -1;
        if (!isSharedScope) {
            index = Number(scope.replace('treatment_', '')) - 1;
            // ללא חסם עליון, treatment_9 בניסוי עם 3 טיפולים היה נכתב לאינדקס
            // שמחוץ למערך ונעלם בלי דיווח.
            if (!Number.isInteger(index) || index < 0 || index >= model.byTreatment.length) {
                return { applied: false, reason: `מספר הטיפול ${scope} אינו קיים בניסוי` };
            }
        }
        const target = isSharedScope ? deepClone(model.sharedData || {}) : deepClone(model.byTreatment[index] || {});
        if (!allowOverwrite && hasAiMeaningfulValue(target[key])) {
            return { applied: false, skipped: true, reason: `לשדה כבר יש ערך ("${target[key]}") ודריסה לא סומנה` };
        }
        target[key] = value;
        if (isSharedScope) model.sharedData = target;
        else model.byTreatment[index] = target;
    
        const isOnScreen = isSharedScope || index === state.currentTreatmentIndex;
        if (isOnScreen) markAiElement(descriptor.id, update);
        aiDirtyViews.add(AI_SECTION_TO_VIEW[sectionId]);
        return { applied: true, marked: isOnScreen };
    }
    
    function normalizeAiStringCollection(value) {
        return (Array.isArray(value) ? value : []).map(item => {
            if (typeof item === 'string') return item.trim();
            return String(item?.value || item?.name || item?.time || '').trim();
        }).filter(Boolean);
    }
    
    function applyAiRootCollection(path, value, operation, allowOverwrite) {
        if (path === 'collection.basic.treatments') {
            const incoming = (Array.isArray(value) ? value : []).map((item, index) => ({
                name: String(item?.name || '').trim() || `טיפול ${index + 1}`,
                repeatLabels: Array.isArray(item?.repeatLabels) ? item.repeatLabels.map(label => String(label).trim()).filter(Boolean) : []
            }));
            const existingTreatments = collectTreatmentInputsFromDOM();
            const merged = mergeAiArrays(existingTreatments, incoming, allowOverwrite, operation);
            if (!merged.length) return { applied: false, reason: 'לא נותרה אף שורת טיפול לאחר המיזוג' };
            const repetitions = Math.max(getCurrentRepetitionsCount(), ...merged.map(item => item.repeatLabels?.length || 1));
            setFieldValue('treatments-count', merged.length);
            setFieldValue('repetitions-count', repetitions);
            generateTreatmentInputs(merged.length, merged, repetitions);
            syncAllSectionTreatmentCounts();
            generateTreatmentTabs();
            aiDirtyViews.add('basic');
            return { applied: true, marked: false };
        }
    
        if (path === 'collection.basic.independentVariables' || path === 'collection.basic.dependentVariables') {
            const type = path.includes('independent') ? 'independent' : 'dependent';
            const container = document.getElementById(type === 'independent' ? 'independent-vars-container' : 'dependent-vars-container');
            const current = Array.from(container?.querySelectorAll(`.${type}-var-input`) || []).map(el => el.value.trim()).filter(Boolean);
            const merged = mergeAiArrays(current, normalizeAiStringCollection(value), allowOverwrite, operation);
            if (!merged.length) return { applied: false, reason: 'לא נותר אף משתנה לאחר המיזוג' };
            if (allowOverwrite && operation === 'set' && container) container.innerHTML = '';
            const existing = new Set(Array.from(container?.querySelectorAll(`.${type}-var-input`) || []).map(el => el.value.trim().toLowerCase()));
            let addedCount = 0;
            merged.forEach(item => {
                const normalized = String(item).trim();
                if (normalized && !existing.has(normalized.toLowerCase())) {
                    addVariableRow(type, normalized);
                    existing.add(normalized.toLowerCase());
                    addedCount += 1;
                }
            });
            if (!addedCount) return { applied: false, skipped: true, reason: 'כל המשתנים שהוצעו כבר קיימים' };
            aiDirtyViews.add('basic');
            return { applied: true, marked: false };
        }
    
        if (path === 'collection.basic.keywords') {
            const incoming = normalizeAiStringCollection(value);
            if (!incoming.length) return { applied: false, reason: 'לא זוהתה אף מילת מפתח' };
            if (allowOverwrite && operation === 'set') document.getElementById('keywords-list')?.replaceChildren();
            const before = document.querySelectorAll('#keywords-list .keyword-tag').length;
            incoming.forEach(addKeywordTag);
            const after = document.querySelectorAll('#keywords-list .keyword-tag').length;
            if (after === before && !(allowOverwrite && operation === 'set')) {
                return { applied: false, skipped: true, reason: 'כל מילות המפתח שהוצעו כבר קיימות' };
            }
            aiDirtyViews.add('basic');
            return { applied: true, marked: false };
        }
    
        if (path === 'collection.events') {
            const before = Array.isArray(state.eventsData) ? state.eventsData.length : 0;
            const merged = mergeAiArrays(state.eventsData, value, allowOverwrite, operation)
                .map(item => ({ ...item, date: item.date || '', description: item.description || '' }));
            const replaced = allowOverwrite && operation === 'set';
            if (!replaced && merged.length === before) {
                return { applied: false, skipped: true, reason: 'כל האירועים שהוצעו כבר קיימים ביומן' };
            }
            state.eventsData = merged;
            renderEventsTable();
            aiDirtyViews.add('events');
            return { applied: true, marked: false };
        }
    
        if (path === 'collection.financial') {
            const before = Array.isArray(state.financialData) ? state.financialData.length : 0;
            const merged = mergeAiArrays(state.financialData, value, allowOverwrite, operation)
                .map(item => ({ ...item, date: item.date || '', description: item.description || '' }));
            const replaced = allowOverwrite && operation === 'set';
            if (!replaced && merged.length === before) {
                return { applied: false, skipped: true, reason: 'כל השורות הפיננסיות שהוצעו כבר קיימות' };
            }
            state.financialData = merged;
            renderFinancialTable();
            aiDirtyViews.add('financial-analysis');
            return { applied: true, marked: false };
        }
    
        return { applied: false, reason: 'אוסף לא מוכר' };
    }
    
    function applyAiSectionCollection(sectionId, scope, key, value, operation, allowOverwrite) {
        if (!AI_SECTION_COLLECTIONS[sectionId]?.[key]) return { applied: false, reason: 'טבלה לא מוכרת במקטע זה' };
        const model = getSectionModel(sectionId);
        ensureModelTreatmentLength(model);
        const isSharedScope = scope === 'shared';
        if (isSharedScope !== Boolean(model.shared)) return { applied: false, reason: 'היקף הטבלה אינו תואם להגדרת משותף/לפי טיפול' };
        let index = -1;
        if (!isSharedScope) {
            index = Number(scope.replace('treatment_', '')) - 1;
            if (!Number.isInteger(index) || index < 0 || index >= model.byTreatment.length) {
                return { applied: false, reason: `מספר הטיפול ${scope} אינו קיים בניסוי` };
            }
        }
        const target = isSharedScope ? deepClone(model.sharedData || {}) : deepClone(model.byTreatment[index] || {});
        const replaced = allowOverwrite && operation === 'set';
        let before = 0;
        let after = 0;
    
        if (sectionId === 'plantProtection') {
            target.plantProtectionData = target.plantProtectionData || { pests: [], diseases: [], sprays: [], drenches: [] };
            before = (target.plantProtectionData[key] || []).length;
            target.plantProtectionData[key] = mergeAiArrays(target.plantProtectionData[key], value, allowOverwrite, operation);
            after = target.plantProtectionData[key].length;
        } else if (sectionId === 'yield') {
            target.yieldData = target.yieldData || { measures: [], damages: [] };
            before = (target.yieldData[key] || []).length;
            target.yieldData[key] = mergeAiArrays(target.yieldData[key], value, allowOverwrite, operation);
            after = target.yieldData[key].length;
        } else if (sectionId === 'crop' && key === 'varieties') {
            before = (target.varieties || []).length;
            target.varieties = mergeAiArrays(target.varieties || [], normalizeAiStringCollection(value), allowOverwrite, operation);
            after = target.varieties.length;
            target.variety = target.varieties[0] || target.variety || '';
        } else if (sectionId === 'drip' && key === 'irrigationTimes') {
            before = (target.irrigationTimes || []).length;
            target.irrigationTimes = mergeAiArrays(
                target.irrigationTimes || [],
                normalizeAiStringCollection(value).map(item => item.replace(/^.*?(\d{1,2}:\d{2}).*$/, '$1')),
                allowOverwrite,
                operation
            );
            after = target.irrigationTimes.length;
        } else {
            before = (target[key] || []).length;
            target[key] = mergeAiArrays(target[key], value, allowOverwrite, operation);
            after = target[key].length;
        }
    
        if (!replaced && after === before) {
            return { applied: false, skipped: true, reason: 'כל השורות שהוצעו כבר קיימות בטבלה' };
        }
    
        if (isSharedScope) model.sharedData = target;
        else model.byTreatment[index] = target;
        aiDirtyViews.add(AI_SECTION_TO_VIEW[sectionId]);
        return { applied: true, marked: false };
    }
    
    async function applyAiExtraction(payload, { allowOverwriteExisting = false } = {}) {
        enterAiReviewMode();
        // מיישרים את ה-state לפי מה שמוצג כרגע, כדי ששער הדריסה של שדות המקטע
        // (שבודק את ה-state) ושל שדות basic (שבודק את ה-DOM) יבדקו אותה אמת.
        persistCurrentSectionDataToState();
        const updates = Array.isArray(payload?.updates) ? [...payload.updates] : [];
        updates.sort((a, b) => {
            const priority = path => path === 'basic.treatmentsCount' ? 0 : path === 'basic.repetitionsCount' ? 1 : path === 'collection.basic.treatments' ? 2 : 3;
            return priority(a.path) - priority(b.path);
        });
    
        let appliedCount = 0;
        let skippedCount = 0;
        const rejected = [];
        const appliedPaths = [];
    
        for (const update of updates) {
            let value;
            try {
                value = JSON.parse(update.value_json);
            } catch {
                rejected.push(`${update.path}: ערך JSON לא תקין`);
                continue;
            }
            if (!hasAiMeaningfulValue(value)) {
                rejected.push(`${update.path}: ערך ריק`);
                continue;
            }
    
            let outcome = { applied: false };
            if (update.path.startsWith('basic.')) {
                outcome = setAiBasicValue(update.path.slice('basic.'.length), value, update, allowOverwriteExisting);
            } else if (update.path.startsWith('collection.')) {
                outcome = applyAiRootCollection(update.path, value, update.operation, allowOverwriteExisting);
            } else {
                const match = update.path.match(/^section\.([^.]+)\.(shared|treatment_\d+)\.([^.]+)$/);
                if (match) {
                    const [, sectionId, scope, key] = match;
                    if (Array.isArray(value)) {
                        outcome = applyAiSectionCollection(sectionId, scope, key, value, update.operation, allowOverwriteExisting);
                    } else {
                        outcome = setAiSectionValue(sectionId, scope, key, value, update, allowOverwriteExisting);
                    }
                }
            }
    
            if (outcome.applied) {
                appliedCount += 1;
                appliedPaths.push(update.path);
            } else if (outcome.skipped) {
                skippedCount += 1;
                rejected.push(`דולג: ${update.path}: ${outcome.reason || 'ערך קיים'}`);
            } else {
                rejected.push(`${update.path}: ${outcome.reason || 'הנתיב לא נתמך'}`);
            }
        }
    
        syncAllSectionTreatmentCounts();
        loadCurrentSectionDataFromState();
        updateConditionalFieldVisibility();
        generateTreatmentTabs();
        aiAppliedCount += appliedCount;
        state.hasUserEditedSinceSave = aiDirtyViews.size > 0;
        document.getElementById('ai-review-bar')?.classList.toggle('hidden', aiDirtyViews.size === 0);
        updateAiReviewUI();
        return { appliedCount, skippedCount, rejected, dirtyViews: [...aiDirtyViews], appliedPaths };
    }
    
    function updateAiReviewUI() {
        const summary = document.getElementById('ai-review-summary');
        if (summary) {
            const labels = [...aiDirtyViews].map(view => AI_VIEW_LABELS[view] || view);
            summary.textContent = labels.length
                ? `${aiAppliedCount} הצעות הוזנו; טרם נשמרו: ${labels.join(', ')}.`
                : 'כל עמודי טיוטת ה-AI נשמרו.';
        }
        aiController?.updateReviewSummary?.();
    }
    
    function clearAiHighlights(viewName = '') {
        const root = viewName ? document.getElementById(`view-${viewName}`) : document;
        root?.querySelectorAll?.('.ai-proposed-field').forEach(element => {
            element.classList.remove('ai-proposed-field');
            delete element.dataset.aiConfidence;
            element.removeAttribute('title');
        });
        // גם ה-badge "מולא על ידי AI" ועטיפתו שייכים לעמוד שנשמר — בלעדי זה
        // נשארו badges מיותמים על שדות שכבר נשמרו.
        if (root) AIFieldMark.clearWithin(root === document ? document.body : root);
        if (viewName) AIFieldMark.report?.clearView?.(viewName);
    }
    
    function buildAiPageSavePayload(formData, viewName) {
        const payload = { updatedAt: serverTimestamp() };
        if (viewName === 'basic') {
            const keys = [
                'experimentName', 'leadResearchers', 'externalLeadResearchers', 'experimentYear', 'experimentMonth', 'researchPeriod', 'studyType',
                'workPackage', 'experimentSite', 'experimentSiteSelection', 'experimentSiteOther', 'siteCoordinates',
                'labCellNumber', 'experimentGoal', 'experimentSummary', 'treatmentsCount', 'repetitionsCount', 'treatments',
                'independentVariables', 'levelsCount', 'levelValue', 'dependentVariables', 'keywords'
            ];
            keys.forEach(key => { payload[key] = formData[key]; });
            return payload;
        }
    
        const sectionId = getSectionIdByView(viewName);
        if (sectionId) payload[`sectionSharedState.${sectionId}`] = formData.sectionSharedState?.[sectionId] || {};
        const viewKeys = {
            crop: ['cropDetails'], structure: ['structureDetails'], soil: ['soilDetails'], drip: ['dripDetails'],
            irrigation: ['irrigationData', 'fertilizationData'], growth: ['growthData'], climate: ['climateData'],
            agrotechnics: ['agrotechnicsData', 'pollinationData'], 'plant-protection': ['plantProtectionData'], yield: ['yieldData'],
            events: ['events'], 'financial-analysis': ['financialData']
        };
        (viewKeys[viewName] || []).forEach(key => { payload[key] = formData[key]; });
        return payload;
    }
    
    function buildAiProjectedExperimentData(formData, viewName) {
        const projectedData = { ...(state.experimentData || {}) };
        const payload = buildAiPageSavePayload(formData, viewName);
    
        Object.entries(payload).forEach(([key, value]) => {
            if (key === 'updatedAt') return;
            if (key.startsWith('sectionSharedState.')) {
                const sectionId = key.split('.')[1];
                projectedData.sectionSharedState = {
                    ...(projectedData.sectionSharedState || {}),
                    [sectionId]: deepClone(value)
                };
            } else {
                projectedData[key] = deepClone(value);
            }
        });
    
        return projectedData;
    }
    
    function mergeAiPageIntoExperimentData(formData, viewName) {
        state.experimentData = buildAiProjectedExperimentData(formData, viewName);
        return state.experimentData;
    }
    
    async function saveAiCurrentPage() {
        if (!aiModeActive || !state.permissionsState?.canEdit) return false;
        persistCurrentSectionDataToState();
        const formData = collectFormData();
        const payload = buildAiPageSavePayload(formData, state.currentView);
        const previousRealtimeSignature = state.lastRealtimeDataSignature;
        const projectedExperimentData = buildAiProjectedExperimentData(formData, state.currentView);
        const expectedRealtimeSignature = getRealtimeDataSignature(projectedExperimentData);
    
        // Mark this exact server result as our own write before awaiting Firestore,
        // so onSnapshot will not rebuild the form and erase other unsaved AI pages.
        state.lastRealtimeDataSignature = expectedRealtimeSignature;
    
        try {
            const experimentRef = doc(db, 'users', state.experimentOwnerUid, 'experiments', state.currentExperimentId);
            await updateDoc(experimentRef, payload);
            state.experimentData = projectedExperimentData;
            state.lastRealtimeDataSignature = getRealtimeDataSignature(state.experimentData);
            if (state.currentView === 'basic') {
                await persistDynamicFieldOptions(formData);
                await persistGlobalKeywordOptions(formData.keywords);
                await syncSharedExperiments(getPermissionShareEntries(state.experimentData, state.experimentData.permissions), state.experimentData);
                updateExperimentDisplayName();
            }
            aiDirtyViews.delete(state.currentView);
            clearAiHighlights(state.currentView);
            state.hasUserEditedSinceSave = aiDirtyViews.size > 0;
            updateAiReviewUI();
            showToast(`${AI_VIEW_LABELS[state.currentView] || 'העמוד'} נשמר`, 'success');
            if (!aiDirtyViews.size) finishAiReview();
            return true;
        } catch (error) {
            if (state.lastRealtimeDataSignature === expectedRealtimeSignature) {
                state.lastRealtimeDataSignature = previousRealtimeSignature;
            }
            console.error('AI page save failed', error);
            showToast(`שגיאה בשמירת העמוד: ${error.message}`, 'error');
            return false;
        }
    }
    
    async function saveAiAll() {
        if (!aiModeActive) return false;
        persistCurrentSectionDataToState();
        const saved = await saveExperiment();
        if (!saved) return false;
        aiDirtyViews.clear();
        clearAiHighlights();
        finishAiReview();
        return true;
    }
    
    function finishAiReview() {
        aiDirtyViews.clear();
        state.hasUserEditedSinceSave = false;
        aiAppliedCount = 0;
        if (aiController) aiController.hasAppliedDraft = false;
        setLastSavedFormSignatureFromCurrent();
        exitAiReviewMode(true);
    }
    
    async function cancelAiDraft() {
        const confirmed = await showConfirmModal({
            title: 'ביטול טיוטת AI',
            message: 'שינויים שלא נשמרו יימחקו. עמודים שכבר נשמרו יישארו בניסוי.',
            confirmText: 'בטל שינויים שלא נשמרו',
            cancelText: 'המשך בסקירה',
            tone: 'warning'
        });
        if (!confirmed) return;
        state.hasUserEditedSinceSave = false;
        aiDirtyViews.clear();
        window.location.reload();
    }

    function markViewDirty(viewName) {
        if (!aiModeActive) return;
        aiDirtyViews.add(viewName);
        updateAiReviewUI();
    }

    function discardForRealtimeUpdate() {
        if (!aiModeActive) return;
        aiDirtyViews.clear();
        aiAppliedCount = 0;
        if (aiController) aiController.hasAppliedDraft = false;
        clearAiHighlights();
        exitAiReviewMode(true);
    }

    function refreshView(viewName) {
        AIFieldMark.report?.refreshView?.(viewName);
    }

    return {
        init,
        isActive: () => aiModeActive,
        markViewDirty,
        discardForRealtimeUpdate,
        refreshView,
        refreshReview: updateAiReviewUI,
        saveCurrentPage: saveAiCurrentPage
    };
}
