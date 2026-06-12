// js/tutorials.js
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initAccordions();
    initMobileSidebar();
});

onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "login.html"; return; }
    try {
        const docSnap = await getDoc(doc(db, "users", user.uid));
        if (docSnap.exists()) {
            const userData = docSnap.data();
            const fullName = `${userData.firstName || ''} ${userData.lastName || ''}`.trim();
            const userDisplayName = document.getElementById('user-display-name');
            if (userDisplayName) userDisplayName.textContent = fullName || user.email;
        }
    } catch (e) { console.error(e); }
});

function initTabs() {
    const tabButtons = document.querySelectorAll('.tutorial-tab-btn');
    const sections = document.querySelectorAll('.tutorial-section');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            sections.forEach(sec => sec.classList.toggle('active', sec.id === targetId));
        });
    });
}

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
                }
            });

            if (isActive) {
                item.classList.remove('active');
                content.style.maxHeight = null;
            } else {
                item.classList.add('active');
                // חישוב מדויק של ה-scrollHeight האמיתי של הקונטיינר הפנימי ללא עיוותים
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
    });

    // מאזין לשינוי גודל מסך על מנת לחשב מחדש את הגובה ולמנוע חיתוך רספונסיבי
    window.addEventListener('resize', () => {
        const activeContent = document.querySelector('.accordion-item.active .accordion-content');
        if (activeContent) {
            activeContent.style.maxHeight = activeContent.scrollHeight + "px";
        }
    });
}

function initMobileSidebar() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (hamburgerBtn && sidebar) {
        hamburgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay?.classList.toggle('active');
        });
    }
    overlay?.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    });
}