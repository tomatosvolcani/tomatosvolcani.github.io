// js/tutorials.js — מרכז הדרכה ולמידה (עמוד ציבורי, ללא צורך בהתחברות)

// =========================================
// רשימת סרטוני ההדרכה
// להוספת סרטון חדש: הוסיפו אובייקט נוסף למערך (id = מזהה הסרטון ב-YouTube)
// =========================================
const VIDEOS = [
    {
        id: 'vUrNmmyDYUo',
        num: '01',
        title: 'הקמת ניסוי + תוכנית ניסוי'
    },
    {
        id: 'AzX2yNuZ5Qw',
        num: '02',
        title: 'הכנות לניסוי'
    },
    {
        id: 'HyzCFhUV34M',
        num: '03',
        title: 'מהלך הניסוי'
    },
    {
        id: 'xJh0ti5OFj8',
        num: '04',
        title: 'תוצאות'
    }
];

document.addEventListener('DOMContentLoaded', () => {
    renderVideos();
    initAccordions();
    initReveal();
    initAuthAwareCta();
});

// =========================================
// בניית כרטיסי הווידאו (טעינה עצלה — ה-iframe נטען רק בלחיצה)
// =========================================
function renderVideos() {
    const grid = document.getElementById('video-grid');
    if (!grid) return;

    VIDEOS.forEach(video => {
        const card = document.createElement('article');
        card.className = 'video-card reveal';

        const facade = document.createElement('button');
        facade.className = 'video-facade';
        facade.type = 'button';
        facade.setAttribute('aria-label', `הפעלת סרטון: ${video.title}`);

        const thumb = document.createElement('img');
        thumb.src = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
        thumb.alt = '';
        thumb.loading = 'lazy';

        const play = document.createElement('span');
        play.className = 'vf-play';
        play.setAttribute('aria-hidden', 'true');
        play.innerHTML = '<i class="fa-solid fa-play"></i>';

        facade.append(thumb, play);
        facade.addEventListener('click', () => loadVideo(facade, video), { once: true });

        const body = document.createElement('div');
        body.className = 'video-card-body';
        body.innerHTML = `
            <h3><span class="video-number">${video.num}</span> ${video.title}</h3>
            <div class="video-card-actions">
                <a href="https://youtu.be/${video.id}" target="_blank" rel="noopener" class="btn-video-link">
                    <i class="fab fa-youtube" aria-hidden="true"></i> צפייה ישירה ב-YouTube
                </a>
            </div>
        `;

        card.append(facade, body);
        grid.appendChild(card);
    });
}

function loadVideo(facade, video) {
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${video.id}?autoplay=1&rel=0`;
    iframe.title = `מדריך מערכת ח"ץ — ${video.title}`;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    facade.replaceChildren(iframe);
}

// =========================================
// אקורדיון המדריכים הכתובים
// =========================================
function initAccordions() {
    const headers = document.querySelectorAll('.accordion-header');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const item = header.parentElement;
            const content = item.querySelector('.accordion-content');
            const isActive = item.classList.contains('active');

            document.querySelectorAll('.accordion-item').forEach(otherItem => {
                if (otherItem !== item && otherItem.classList.contains('active')) {
                    otherItem.classList.remove('active');
                    otherItem.querySelector('.accordion-content').style.maxHeight = null;
                    otherItem.querySelector('.accordion-header')?.setAttribute('aria-expanded', 'false');
                }
            });

            if (isActive) {
                item.classList.remove('active');
                content.style.maxHeight = null;
                header.setAttribute('aria-expanded', 'false');
            } else {
                item.classList.add('active');
                // חישוב מדויק של ה-scrollHeight האמיתי של הקונטיינר הפנימי ללא עיוותים
                content.style.maxHeight = content.scrollHeight + 'px';
                header.setAttribute('aria-expanded', 'true');
            }
        });
    });

    // מאזין לשינוי גודל מסך על מנת לחשב מחדש את הגובה ולמנוע חיתוך רספונסיבי
    window.addEventListener('resize', () => {
        const activeContent = document.querySelector('.accordion-item.active .accordion-content');
        if (activeContent) {
            activeContent.style.maxHeight = activeContent.scrollHeight + 'px';
        }
    });
}

// =========================================
// אנימציית חשיפה בגלילה
// =========================================
function initReveal() {
    const items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
        items.forEach(el => el.classList.add('revealed'));
        return;
    }
    const obs = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.transitionDelay = `${(entry.target.dataset.idx || 0) * 100}ms`;
                entry.target.classList.add('revealed');
                obs.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12 });
    items.forEach((el, i) => { el.dataset.idx = i % 4; obs.observe(el); });
}

// =========================================
// זיהוי משתמש מחובר (אופציונלי) — העמוד נשאר ציבורי גם ללא התחברות.
// אם המשתמש מחובר, כפתורי הכניסה הופכים ל"מעבר למערכת".
// =========================================
async function initAuthAwareCta() {
    try {
        const { auth } = await import('./firebase-config.js');
        const { onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');

        onAuthStateChanged(auth, (user) => {
            if (!user) return;
            document.body.classList.add('is-authed');

            const headerCta = document.getElementById('auth-cta');
            if (headerCta) {
                headerCta.href = 'dashboard.html';
                headerCta.innerHTML = '<i class="fa-solid fa-gauge-high" aria-hidden="true"></i> מעבר למערכת';
            }

            const bottomCta = document.getElementById('cta-login');
            if (bottomCta) {
                bottomCta.href = 'dashboard.html';
                bottomCta.innerHTML = '<span>מעבר למערכת</span> <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>';
            }
        });
    } catch (e) {
        // העמוד ציבורי — גם אם Firebase לא נטען, הכל ממשיך לעבוד כרגיל
        console.warn('בדיקת התחברות דולגה:', e);
    }
}