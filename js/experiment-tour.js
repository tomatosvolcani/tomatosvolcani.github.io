// js/experiment-tour.js
// מדריך למשתמש בתוך עמוד הניסוי — מבוסס Driver.js
// ניתן לשנות ולהרחיב קובץ זה בלבד כדי לעדכן את הסיור בעמוד הניסוי
//
// הערה על כותרות השלבים: הן נשארות טקסט נקי (ללא HTML ואייקונים) — רק ה-description
// עובר כ-HTML. אייקונים/הדגשות נוספים ממוקמים בגוף התיאור.

export function initExperimentTour() {
    if (!window.driver || !window.driver.js) {
        console.warn('Driver.js is not loaded');
        return;
    }

    const driver = window.driver.js.driver;

    // ===== עיצוב מותאם (זהה ל-system-tour.js) =====
    if (!document.getElementById('tour-custom-style')) {
        const style = document.createElement('style');
        style.id = 'tour-custom-style';
        style.innerHTML = `
            .driver-popover {
                border-radius: 12px !important;
                box-shadow: 0 18px 44px rgba(10, 47, 114, 0.20), 0 2px 6px rgba(15, 23, 42, 0.08) !important;
                border: 1px solid #dbe3ef !important;
                padding: 0 !important;
                overflow: hidden !important;
                max-width: 400px !important;
                font-family: 'Heebo', sans-serif !important;
                direction: rtl !important;
            }
            .driver-popover-title {
                background: linear-gradient(135deg, #0a2f72 0%, #1e40af 100%) !important;
                color: #fff !important;
                /* padding שמאלי מוגדל — שם יושב כפתור הסגירה */
                padding: 13px 18px 13px 42px !important;
                font-size: 1rem !important;
                font-weight: 600 !important;
                letter-spacing: -0.01em !important;
                border-bottom: none !important;
                text-align: right !important;
            }
            .driver-popover-description {
                padding: 16px 18px 6px !important;
                font-size: 0.9rem !important;
                color: #334155 !important;
                line-height: 1.75 !important;
                text-align: right !important;
                direction: rtl !important;
            }
            .driver-popover-footer {
                padding: 12px 18px 14px !important;
                border-top: 1px solid #eef2f7 !important;
                background: #fbfcfe !important;
                display: flex !important;
                gap: 8px !important;
                justify-content: flex-start !important;
                direction: rtl !important;
            }
            .driver-popover-next-btn,
            .driver-popover-prev-btn,
            .driver-popover-done-btn {
                border-radius: 8px !important;
                font-family: 'Heebo', sans-serif !important;
                font-size: 0.86rem !important;
                font-weight: 600 !important;
                padding: 8px 18px !important;
                border: 1px solid transparent !important;
                cursor: pointer !important;
                text-shadow: none !important;
                transition: background 0.18s ease, border-color 0.18s ease !important;
            }
            .driver-popover-next-btn,
            .driver-popover-done-btn {
                background: #0a2f72 !important;
                color: #fff !important;
            }
            .driver-popover-next-btn:hover,
            .driver-popover-done-btn:hover { background: #123f8f !important; }
            .driver-popover-prev-btn {
                background: #fff !important;
                color: #334155 !important;
                border-color: #d6deea !important;
            }
            .driver-popover-prev-btn:hover { background: #f1f5f9 !important; }
            .driver-popover-progress-text {
                font-size: 0.78rem !important;
                font-weight: 500 !important;
                color: #94a3b8 !important;
                margin-right: auto !important;
                align-self: center !important;
            }
            .driver-popover-close-btn {
                color: rgba(255,255,255,0.75) !important;
                top: 9px !important;
                left: 12px !important;
                right: auto !important;
                font-size: 1.15rem !important;
                transition: color 0.18s ease !important;
            }
            .driver-popover-close-btn:hover { color: #fff !important; }
            .tour-list {
                margin: 8px 0 0 0;
                padding: 0;
                list-style: none;
            }
            .tour-list li {
                position: relative;
                margin-bottom: 6px;
                padding-right: 16px;
            }
            .tour-list li:last-child { margin-bottom: 0; }
            .tour-list li::before {
                content: "";
                position: absolute;
                right: 0;
                top: 0.62em;
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #2563eb;
            }
            .tour-accent { color: #1d4ed8; font-weight: 600; }
            .tour-divider {
                border: none;
                border-top: 1px solid #eef2f7;
                margin: 12px 0;
            }
            .tour-note {
                margin-top: 12px;
                padding: 10px 12px;
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-right: 3px solid #2563eb;
                border-radius: 8px;
                font-size: 0.86rem;
                line-height: 1.65;
                color: #334155;
            }
            .tour-note-title {
                display: block;
                margin-bottom: 2px;
                font-weight: 600;
                color: #0a2f72;
            }
            .tour-status {
                display: inline-block;
                padding: 1px 7px;
                border-radius: 5px;
                background: #eef2ff;
                color: #1e40af;
                font-size: 0.82rem;
                font-weight: 600;
                white-space: nowrap;
            }
        `;
        document.head.appendChild(style);
    }

    // ===== הגדרות הסיור =====
    const tourConfig = {
        showProgress: true,
        animate: true,
        allowClose: true,
        overlayColor: 'rgba(15, 35, 90, 0.65)',
        nextBtnText: 'הבא',
        prevBtnText: 'הקודם',
        doneBtnText: 'סיום',
        progressText: 'שלב {{current}} מתוך {{total}}'
    };

    // ===== שלבי הסיור בעמוד הניסוי =====
    const tourSteps = [

            // ── שלב 1: ברכה כללית ──
            {
                element: '.breadcrumb',
                popover: {
                    title: 'עמוד הניסוי — סקירה כללית',
                    description: `
                        בעמוד זה מתעדים ומנהלים את כל פרטי הניסוי.
                        <hr class="tour-divider">
                        הפס העליון מציין תמיד את המיקום הנוכחי בתוך הניסוי, ולצידו מוצג מחוון השמירה.
                        הסיור הקצר יעבור על כל חלקי העמוד.
                    `,
                    side: 'bottom',
                    align: 'start'
                }
            },

            // ── שלב 2: תפריט הניסוי בסיידבר ──
            {
                element: '.experiment-nav-item',
                popover: {
                    title: 'ניווט בין חלקי הניסוי',
                    description: `
                        התפריט הצדדי מחולק לשלושה אזורים עיקריים:
                        <ul class="tour-list">
                            <li><span class="tour-accent">תוכנית הניסוי</span> — מטרות, אתר וטיפולים</li>
                            <li><span class="tour-accent">הכנות לניסוי</span> — גידול, מבנה, קרקע, טפטוף</li>
                            <li><span class="tour-accent">מהלך הניסוי</span> — השקיה, צימוח, אקלים ועוד</li>
                        </ul>
                        לחיצה על כל סעיף פותחת אותו.
                    `,
                    side: 'left',
                    align: 'start'
                }
            },

            // ── שלב 3: תוכנית הניסוי ──
            // מסמנים את פריט התפריט ולא את #view-basic: הוא גבוה ממסך שלם,
            // וההדגשה שלו נראית כאילו לא סומן דבר.
            {
                element: 'a[data-view="basic"]',
                popover: {
                    title: 'תוכנית הניסוי',
                    description: `
                        זהו המסך הראשי, ובו הפרטים הבסיסיים של הניסוי:
                        <ul class="tour-list">
                            <li>חוקרים מובילים, שנה וחודש הניסוי</li>
                            <li>אתר הניסוי וקורדינטות (כולל בחירה מהמפה)</li>
                            <li>מטרת הניסוי ותקציר</li>
                            <li>מספר טיפולים, חזרות ומשתנים</li>
                            <li>חבילת עבודה במסגרת מיזם ח"ץ</li>
                        </ul>
                    `,
                    side: 'left',
                    align: 'start'
                }
            },

            // ── שלב 4: שותפים ──
            // שדה החיפוש הגלוי. אין להשתמש ב-#partner-search — זהו שדה legacy
            // שיושב בתוך div מוסתר (display:none) ונשמר לתאימות לאחור בלבד.
            {
                element: '#experiment-partner-search',
                popover: {
                    title: 'הוספת שותפים לניסוי',
                    description: `
                        הקלידו <span class="tour-accent">שם או כתובת אימייל</span> של חוקר רשום במערכת.
                        <hr class="tour-divider">
                        המערכת תציע רשימת חוקרים בזמן אמת. לאחר לחיצה על <strong>+</strong>:
                        <ul class="tour-list">
                            <li>הניסוי יופיע בדשבורד של השותף עם סמל כחול</li>
                            <li>השותף יוכל לצפות ולערוך את הנתונים</li>
                            <li>ניתן להסיר שותף בכל עת</li>
                        </ul>
                    `,
                    side: 'bottom',
                    align: 'start'
                }
            },

            // ── שלב 5: הכנות לניסוי ──
            {
                element: '#prep-toggle',
                popover: {
                    title: 'הכנות לניסוי',
                    description: `
                        לחיצה כאן פותחת את ארבעת הסעיפים:
                        <ul class="tour-list">
                            <li><span class="tour-accent">פרטי הגידול</span> — סוג, זן, מועד שתילה, עומד ושטח</li>
                            <li><span class="tour-accent">מבנה</span> — חממה, שדה, גג, כיוון</li>
                            <li><span class="tour-accent">טיפול בקרקע</span> — קומפוסט, חיטוי, מצע</li>
                            <li><span class="tour-accent">סוג ופריסת הטפטוף</span> — ספיקה, מרחקים, תזמון</li>
                        </ul>
                    `,
                    side: 'left',
                    align: 'start'
                }
            },

            // ── שלב 6: toggle שיתוף נתונים ──
            {
                element: '#shared-toggle-container',
                popover: {
                    title: 'נתונים משותפים לכל הטיפולים',
                    description: `
                        בחלקי ה"הכנות" יש מתג חשוב —
                        <span class="tour-accent">נתונים זהים לכלל הטיפולים</span>.
                        <hr class="tour-divider">
                        <ul class="tour-list">
                            <li><strong>פעיל (ברירת מחדל)</strong> — ממלאים פעם אחת לכל הטיפולים</li>
                            <li><strong>כבוי</strong> — כרטיסייה נפרדת לכל טיפול בנפרד</li>
                        </ul>
                        כיבוי המתג יוצר לשונית לכל טיפול בחלק העליון של המסך.
                    `,
                    side: 'bottom',
                    align: 'start'
                }
            },

            // ── שלב 7: מהלך הניסוי ──
            {
                element: '#progress-toggle',
                popover: {
                    title: 'מהלך הניסוי',
                    description: `
                        כאן מתועדים נתונים שנאספים <strong>לאורך</strong> הניסוי:
                        <ul class="tour-list">
                            <li><span class="tour-accent">השקיה ודשן</span> — העלאת קבצי נתונים עם תאריכים</li>
                            <li><span class="tour-accent">צימוח</span> — מדידות גדילה עם תאריך מדידה</li>
                            <li><span class="tour-accent">אקלים וסנסורים</span> — קובצי נתוני סנסורים</li>
                            <li><span class="tour-accent">אגרוטכניקה</span> — פעולות גידול מיוחדות</li>
                            <li><span class="tour-accent">הגנת הצומח</span> — מחלות, מזיקים וריסוסים</li>
                        </ul>
                    `,
                    side: 'left',
                    align: 'start'
                }
            },

            // ── שלב 8: נתוני יבול ──
            {
                element: 'a[data-view="yield"]',
                popover: {
                    title: 'נתוני יבול',
                    description: `
                        לאחר הקטיף מזינים כאן את <span class="tour-accent">נתוני היבול</span>:
                        <ul class="tour-list">
                            <li>מדידות — תאריך, חזרה, קומת פרי, כמות ואיכות</li>
                            <li>פגעים — תיעוד נזקים ביבול</li>
                        </ul>
                        ניתן להוסיף שורות מדידה כמה פעמים שנדרש לאורך הניסוי.
                    `,
                    side: 'left',
                    align: 'center'
                }
            },

            // ── שלב 9: יומן אירועים ──
            {
                element: 'a[data-view="events"]',
                popover: {
                    title: 'יומן אירועים',
                    description: `
                        כאן נרשמים <span class="tour-accent">אירועים חשובים</span> שאירעו במהלך הניסוי —
                        תקלות, תצפיות מיוחדות, שינויי תנאים וכל הערה שחשוב לתעד.
                        <hr class="tour-divider">
                        האירועים מסודרים לפי תאריך ומהווים יומן כרונולוגי של הניסוי.
                    `,
                    side: 'left',
                    align: 'center'
                }
            },

            // ── שלב 10: ניתוחים פיננסיים ──
            {
                element: 'a[data-view="financial-analysis"]',
                popover: {
                    title: 'ניתוחים פיננסיים',
                    description: `
                        בסעיף זה ניתן לצרף <span class="tour-accent">קבצי נתונים פיננסיים</span>
                        — עלויות, תשומות וניתוחי רווחיות הקשורים לניסוי.
                    `,
                    side: 'left',
                    align: 'center'
                }
            },

            // ── שלב 11: שמירה אוטומטית ──
            {
                element: '.btn-save',
                popover: {
                    title: 'שמירה אוטומטית',
                    description: `
                        הנתונים נשמרים <span class="tour-accent">אוטומטית</span> — כשלוש שניות לאחר שמפסיקים
                        להקליד, בלי צורך ללחוץ על שמירה.
                        <hr class="tour-divider">
                        מחוון השמירה שליד הפס העליון מציג את המצב:
                        <span class="tour-status">שומר...</span> ולאחריו
                        <span class="tour-status">נשמר בהצלחה</span>.
                        <ul class="tour-list">
                            <li>מעבר בין מסכים או יציאה מהעמוד שומרים את השינויים לפני המעבר</li>
                            <li>בבעיית רשת המחוון מתריע, והשמירה חוזרת אוטומטית כשהחיבור מתחדש</li>
                        </ul>
                        <div class="tour-note">
                            <span class="tour-note-title">הכפתור "שמירה עכשיו"</span>
                            מיועד לשמירה מיידית עם בדיקת תקינות מלאה של הטופס — הוא אינו נדרש
                            כדי שהנתונים יישמרו.
                        </div>
                    `,
                    side: 'top',
                    align: 'center'
                }
            },

            // ── שלב 12: סיום ──
            {
                element: '.sidebar-nav',
                popover: {
                    title: 'סיום הסיור',
                    description: `
                        אלה כל חלקי עמוד הניסוי. מהתפריט הצדדי אפשר להמשיך:
                        <ul class="tour-list">
                            <li>חזרה לרשימת הניסויים — <span class="tour-accent">בית</span></li>
                            <li>ייצוא נתונים לאקסל — <span class="tour-accent">שליפת ניסוי</span></li>
                            <li>תקלה או הצעה לשיפור — <span class="tour-accent">תקלות והצעות</span></li>
                        </ul>
                        <div class="tour-note">
                            ניתן להפעיל את הסיור מחדש בכל עת דרך
                            <span class="tour-accent">סיור בניסוי</span> בתפריט הצדדי.
                        </div>
                    `,
                    side: 'left',
                    align: 'center'
                }
            }
    ];

    /**
     * האם העוגן של השלב מוצג כרגע במסך.
     *
     * בעמוד הניסוי חלק מהעוגנים תלויי-מצב: כל מסך (view) מוצג בנפרד, ומתג
     * "נתונים זהים לכלל הטיפולים" מוצג רק במסכי ההכנות. Driver.js אינו בודק
     * זאת בעצמו, ולכן עוגן מוסתר מסתיים בהדגשה של מלבן במקום שרירותי בדף.
     */
    function isAnchorVisible(selector) {
        const element = document.querySelector(selector);
        if (!element || !element.getClientRects().length) return false;

        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    // שלב שהעוגן שלו אינו מוצג כרגע מוצג ללא הדגשה — Driver.js ממקם פופאובר
    // ללא element במרכז המסך, וכך התוכן נשמר בלי סימון שגוי.
    function resolveSteps() {
        return tourSteps.map((step) => {
            if (!step.element || isAnchorVisible(step.element)) return step;
            const { element, ...stepWithoutAnchor } = step;
            return stepWithoutAnchor;
        });
    }

    // ── מאזין לכפתור הסיור ──
    const tourBtn = document.getElementById('btn-start-experiment-tour');
    if (tourBtn) {
        tourBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const sidebar = document.querySelector('.sidebar');
            if (sidebar && sidebar.classList.contains('open')) {
                const overlay = document.getElementById('sidebar-overlay');
                if (overlay) overlay.click();
            }
            // הסיור נבנה מחדש בכל הפעלה — סט העוגנים הגלויים משתנה לפי המסך הפתוח.
            driver({ ...tourConfig, steps: resolveSteps() }).drive();
        });
    }
}
