import { auth } from "./firebase-config.js";
import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { showToast, startButtonCountdown, resumeCountdownIfNeeded } from "./toast.js";

const COUNTDOWN_STORAGE_KEY = 'passwordResetCountdown';
const resetBtn = document.getElementById('btn-reset');
const originalBtnText = resetBtn.textContent;

// Resume countdown if page was refreshed during countdown
resumeCountdownIfNeeded(resetBtn, originalBtnText, COUNTDOWN_STORAGE_KEY);

function getHebrewErrorMessageFirebase(error) {
    if (!error || !error.code) return 'שגיאה בשליחת המייל. יש לנסות שוב.';
    const code = error.code;
    const map = {
        'auth/invalid-email': 'כתובת האימייל אינה תקינה. יש לבדוק ולנסות שוב.',
        'auth/user-not-found': 'לא נמצא משתמש עם כתובת אימייל זו. ודא/י שהאימייל רשום במערכת.',
        'auth/too-many-requests': 'יותר מדי בקשות לאיפוס סיסמה. יש להמתין רגע ולנסות שנית.',
        'auth/network-request-failed': 'שגיאת תקשורת. בדוק/י חיבור אינטרנט ונסה שוב.',
        'auth/missing-android-pkg-name': 'שגיאת קונפיגורציה של הפרויקט (מכשיר אנדרואיד).',
        'auth/invalid-action-code': 'קוד פעולה לא תקין.',
        'auth/invalid-message-payload': 'הודעת הדוא"ל לא פונטה כראוי (קונפיגורציה).'
    };
    return map[code] || (error.message ? error.message : 'שגיאה בשליחת המייל. יש לנסות שוב.');
}

resetBtn.addEventListener('click', async () => {
    const emailEl = document.getElementById('forgot-email');
    const email = emailEl?.value?.trim();

    if(!email) {
        showToast("נא להזין/י אימייל", "warning");
        return;
    }

    // basic email format quick check
    const simpleEmailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!simpleEmailRe.test(email)) {
        showToast('כתובת אימייל אינה תקינה. יש להכניס כתובת תקינה.', 'warning');
        return;
    }

    try {
        await sendPasswordResetEmail(auth, email);
        showToast("מייל נשלח לכתובת: " + email + '. בדוק/י תיבת דואר ספאם אם לא הגיע.', "success", 5000);

        // Start 3-minute (180 seconds) countdown and persist it
        startButtonCountdown(resetBtn, 180, originalBtnText, COUNTDOWN_STORAGE_KEY);

    } catch (error) {
        // Log the full error for debugging
        console.error('Password reset error:', error);
        const message = getHebrewErrorMessageFirebase(error);
        showToast('שגיאה: ' + message, 'error');
    }
});