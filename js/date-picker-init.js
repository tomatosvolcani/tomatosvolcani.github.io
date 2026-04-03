// js/date-picker-init.js
// אתחול flatpickr לכל שדות התאריך — פורמט ישראלי dd/mm/yyyy
// הקובץ נטען כ-global script (לא module) כדי לתפוס גם אלמנטים דינמיים

(function () {
    'use strict';

    const FLATPICKR_CONFIG = {
        dateFormat: 'Y-m-d',      // הערך שנשמר (ISO — תואם ל-DB)
        altInput: true,            // שדה תצוגה נפרד
        altFormat: 'd/m/Y',       // הפורמט שהמשתמש רואה
        locale: 'he',
        allowInput: true,
        disableMobile: true        // תמיד להשתמש ב-flatpickr גם במובייל
    };

    // שמור reference ל-setter המקורי של input.value
    const nativeValueDescriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value'
    );

    /**
     * הפעלת flatpickr על אלמנט date שלא אותחל עדיין
     */
    function initDateInput(input) {
        // אם כבר אותחל — דלג
        if (input._flatpickr || input.dataset.fpInited) return;
        input.dataset.fpInited = 'true';

        // שמור ערך קיים ו-class מקורי
        const existingValue = input.value;
        const originalClass = input.className;

        // שנה ל-text כדי ש-flatpickr יעבוד על השדה
        input.type = 'text';

        const fp = flatpickr(input, {
            ...FLATPICKR_CONFIG,
            altInputClass: originalClass + ' flatpickr-alt-input',
            defaultDate: existingValue || null
        });

        // Monkey-patch .value setter כדי ש-input.value = '2026-04-03'
        // גם יעדכן את התצוגה של flatpickr
        Object.defineProperty(input, 'value', {
            get: function () {
                return nativeValueDescriptor.get.call(this);
            },
            set: function (val) {
                nativeValueDescriptor.set.call(this, val);
                // guard נגד אינסוף רקורסיה — flatpickr.setDate קורא ל-value= פנימית
                if (!this._fpSetting && this._flatpickr) {
                    this._fpSetting = true;
                    try {
                        this._flatpickr.setDate(val, false);
                    } finally {
                        this._fpSetting = false;
                    }
                }
            },
            configurable: true
        });

        return fp;
    }

    /**
     * סריקה ואתחול כל שדות ה-date שלא אותחלו
     */
    function initAllDateInputs() {
        document.querySelectorAll('input[type="date"]:not([data-fp-inited])').forEach(initDateInput);
    }

    // אתחול ראשוני ברגע ש-DOM מוכן
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAllDateInputs);
    } else {
        initAllDateInputs();
    }

    // MutationObserver — מאזין לאלמנטים דינמיים שנוספים ל-DOM
    const observer = new MutationObserver(function (mutations) {
        let hasNewNodes = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                hasNewNodes = true;
                break;
            }
        }
        if (hasNewNodes) {
            // קצת debounce כדי לא לקרוא יותר מדי
            clearTimeout(observer._timer);
            observer._timer = setTimeout(initAllDateInputs, 50);
        }
    });

    // צפייה בכל ה-DOM
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    // חשוף פונקציה גלובלית למקרה שצריך אתחול ידני
    window.initDateInputs = initAllDateInputs;
    window.initSingleDateInput = initDateInput;
})();
