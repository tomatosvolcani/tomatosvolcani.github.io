// js/system-tour.js
// מודול מדריך למשתמש (System Tour) - מבוסס Driver.js
// ניתן לשנות ולהרחיב קובץ זה בלבד מבלי לגעת בקבצים אחרים

export function initSystemTour() {
    if (!window.driver || !window.driver.js) {
        console.warn('Driver.js is not loaded');
        return;
    }

    const driver = window.driver.js.driver;

    // ===== עיצוב מותאם לסיור =====
    if (!document.getElementById('tour-custom-style')) {
        const style = document.createElement('style');
        style.id = 'tour-custom-style';
        style.innerHTML = `
            /* ---- פופאובר כללי ---- */
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

            /* ---- כותרת הפופאובר ---- */
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

            /* ---- תוכן הפופאובר ---- */
            .driver-popover-description {
                padding: 16px 18px 6px !important;
                font-size: 0.9rem !important;
                color: #334155 !important;
                line-height: 1.75 !important;
                text-align: right !important;
                direction: rtl !important;
            }

            /* ---- כפתורי ניווט ---- */
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
            .driver-popover-done-btn:hover {
                background: #123f8f !important;
            }
            .driver-popover-prev-btn {
                background: #fff !important;
                color: #334155 !important;
                border-color: #d6deea !important;
            }
            .driver-popover-prev-btn:hover {
                background: #f1f5f9 !important;
            }

            /* ---- מונה שלבים ---- */
            .driver-popover-progress-text {
                font-size: 0.78rem !important;
                font-weight: 500 !important;
                color: #94a3b8 !important;
                margin-right: auto !important;
                align-self: center !important;
            }

            /* ---- כפתור סגירה ---- */
            .driver-popover-close-btn {
                color: rgba(255,255,255,0.75) !important;
                top: 9px !important;
                left: 12px !important;
                right: auto !important;
                font-size: 1.15rem !important;
                transition: color 0.18s ease !important;
            }
            .driver-popover-close-btn:hover {
                color: #fff !important;
            }

            /* ---- רשימת נקודות בתיאור ---- */
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

            /* ---- צבע הדגשה בטקסט ---- */
            .tour-accent {
                color: #1d4ed8;
                font-weight: 600;
            }

            /* ---- קו הפרדה קל ---- */
            .tour-divider {
                border: none;
                border-top: 1px solid #eef2f7;
                margin: 12px 0;
            }

            /* ---- הערה מודגשת בתוך התיאור ---- */
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

            /* ---- ציטוט של טקסט שמופיע במערכת ---- */
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

    // ===== שלבי הסיור =====
    const tourDriver = driver({
        showProgress: true,
        animate: true,
        allowClose: true,
        overlayColor: 'rgba(15, 35, 90, 0.65)',
        nextBtnText: 'הבא',
        prevBtnText: 'הקודם',
        doneBtnText: 'סיום',
        progressText: 'שלב {{current}} מתוך {{total}}',

        steps: [
            // ── שלב 1: ברכה ──
            {
                element: '.dashboard-main h1',
                popover: {
                    title: 'ברוכים הבאים למערכת איגום הנתונים של מיזם ח"ץ',
                    description: `
                        זהו <span class="tour-accent">מסך הבית</span> שלכם — כאן מוצגים כל הניסויים שלכם,
                        גם אלו שיצרתם וגם כאלו שחוקרים אחרים שיתפו איתכם.
                        <hr class="tour-divider">
                        הסיור הקצר הבא יעבור על כל חלקי המערכת.
                    `,
                    side: 'bottom',
                    align: 'start'
                }
            },

            // ── שלב 2: תפריט ניווט ──
            {
                element: '.sidebar-nav',
                popover: {
                    title: 'תפריט הניווט',
                    description: `
                        מהתפריט הצדדי תוכלו לגשת לכל חלקי המערכת:
                        <ul class="tour-list">
                            <li><span class="tour-accent">בית</span> — רשימת הניסויים שלכם</li>
                            <li><span class="tour-accent">שליפת ניסוי</span> — ייצוא נתונים לאקסל</li>
                            <li><span class="tour-accent">הסטטיסטיקה שלי</span> — גרפים וניתוחי BI אישיים</li>
                        </ul>
                    `,
                    side: 'left',
                    align: 'center'
                }
            },

            // ── שלב 3: מקרא ──
            {
                element: '.experiments-legend',
                popover: {
                    title: 'זיהוי סוג הניסוי',
                    description: `
                        כל ניסוי מסומן בצבע שונה כדי להבחין בקלות:
                        <ul class="tour-list">
                            <li>סמל <span class="tour-accent">ירוק</span> — ניסוי שאתם הקמתם</li>
                            <li>סמל <span class="tour-accent">כחול</span> — ניסוי שחוקר אחר שיתף אתכם בו</li>
                        </ul>
                        <hr class="tour-divider">
                        בניסויים משותפים תוכלו לראות וגם לערוך נתונים (בהתאם להרשאות).
                    `,
                    side: 'bottom',
                    align: 'center'
                }
            },

            // ── שלב 4: כפתור ניסוי חדש ──
            {
                element: '#add-experiment-btn',
                popover: {
                    title: 'יצירת ניסוי חדש',
                    description: `
                        <strong>לחצו על הריבוע הזה</strong> כדי להתחיל תיעוד ניסוי חדש.
                        <hr class="tour-divider">
                        תוכלו ליצור כמה ניסויים שתרצו — כל ניסוי מאוחסן בנפרד ואפשר לעבוד עליו מכל מקום.
                    `,
                    side: 'right',
                    align: 'center'
                },
                onNextClick: () => {
                    document.getElementById('add-experiment-btn').click();
                    setTimeout(() => tourDriver.moveNext(), 400);
                }
            },

            // ── שלב 5: מודאל יצירת ניסוי ──
            {
                element: '#new-experiment-modal .modal',
                popover: {
                    title: 'שם הניסוי',
                    description: `
                        הזינו <span class="tour-accent">שם תיאורי לניסוי</span> (למשל: "עגבניות חממה 2025")
                        ולחצו על <strong>"יצירת ניסוי"</strong>.
                        <hr class="tour-divider">
                        לאחר הלחיצה תועברו ישירות לדף הניסוי שבו תוכלו למלא את כל הפרטים.
                    `,
                    side: 'top',
                    align: 'center'
                },
                onDeselected: () => {
                    const modal = document.getElementById('new-experiment-modal');
                    if (modal && !modal.classList.contains('hidden')) {
                        modal.classList.add('hidden');
                    }
                },
                onNextClick: () => {
                    const modal = document.getElementById('new-experiment-modal');
                    if (modal && !modal.classList.contains('hidden')) {
                        modal.classList.add('hidden');
                    }
                    tourDriver.moveNext();
                }
            },

            // ── שלב 6: שליפה לאקסל ──
            {
                element: 'a[href="export.html"]',
                popover: {
                    title: 'שליפת נתונים לאקסל',
                    description: `
                        בסיום (או בכל שלב) תוכלו לייצא את נתוני הניסוי לאקסל דרך
                        <span class="tour-accent">שליפת ניסוי</span> בתפריט.
                        <hr class="tour-divider">
                        בחרו ניסוי, סמנו אילו נתונים לייצא — והקובץ יורד ישירות למחשב שלכם.
                    `,
                    side: 'left',
                    align: 'center'
                }
            },

            // ── שלב 7: סיום ──
            {
                element: '.sidebar-nav',
                popover: {
                    title: 'סיום הסיור',
                    description: `
                        אתם מוכנים לעבוד עם מערכת ח"ץ.
                        <hr class="tour-divider">
                        <ul class="tour-list">
                            <li>תקלה או הצעה לשיפור — <span class="tour-accent">תקלות והצעות</span> בתפריט</li>
                            <li>שאלות — הצ'אטבוט המובנה בפינה השמאלית</li>
                            <li>בתוך כל ניסוי — <span class="tour-accent">סיור בניסוי</span> להדרכה מפורטת</li>
                        </ul>
                    `,
                    side: 'left',
                    align: 'center'
                }
            }
        ]
    });

    // ── מאזין לכפתור סיור במערכת ──
    const tourBtn = document.getElementById('btn-start-tour');
    if (tourBtn) {
        tourBtn.addEventListener('click', (e) => {
            e.preventDefault();

            // סגירת המודאל אם פתוח
            const modal = document.getElementById('new-experiment-modal');
            if (modal && !modal.classList.contains('hidden')) {
                modal.classList.add('hidden');
            }

            // סגירת התפריט במובייל אם פתוח
            const sidebar = document.querySelector('.sidebar');
            if (sidebar && sidebar.classList.contains('open')) {
                const overlay = document.getElementById('sidebar-overlay');
                if (overlay) overlay.click();
            }

            tourDriver.drive();
        });
    }
}