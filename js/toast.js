// js/toast.js
// Toast Notification System

// Ensure toast container exists
function ensureToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    return container;
}

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - 'success' | 'error' | 'warning' | 'info'
 * @param {number} duration - Duration in milliseconds (default: 3000)
 */
export function showToast(message, type = 'info', duration = 3000) {
    const container = ensureToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    // Icon based on type
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-times-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };

    toast.innerHTML = `
        <i class="fas ${icons[type] || icons.info}"></i>
        <span>${message}</span>
    `;

    container.appendChild(toast);

    // Auto remove after duration
    setTimeout(() => {
        toast.classList.add('toast-hide');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, duration);

    return toast;
}

/**
 * Start a countdown on a button with localStorage persistence
 * @param {HTMLButtonElement} button - The button element
 * @param {number} seconds - Countdown duration in seconds
 * @param {string} originalText - The original button text
 * @param {string} storageKey - Key for localStorage (default: 'countdownEndTime')
 */
export function startButtonCountdown(button, seconds, originalText, storageKey = 'countdownEndTime') {
    // Calculate end time and save to localStorage
    const endTime = Date.now() + (seconds * 1000);
    localStorage.setItem(storageKey, endTime.toString());

    runCountdown(button, endTime, originalText, storageKey);
}

/**
 * Resume countdown from localStorage if exists
 * @param {HTMLButtonElement} button - The button element
 * @param {string} originalText - The original button text
 * @param {string} storageKey - Key for localStorage (default: 'countdownEndTime')
 */
export function resumeCountdownIfNeeded(button, originalText, storageKey = 'countdownEndTime') {
    const savedEndTime = localStorage.getItem(storageKey);
    if (savedEndTime) {
        const endTime = parseInt(savedEndTime);
        const remaining = Math.ceil((endTime - Date.now()) / 1000);

        if (remaining > 0) {
            runCountdown(button, endTime, originalText, storageKey);
            return true;
        } else {
            // Countdown finished while away, clear storage
            localStorage.removeItem(storageKey);
        }
    }
    return false;
}

/**
 * Internal function to run the countdown
 */
function runCountdown(button, endTime, originalText, storageKey) {
    button.disabled = true;
    button.classList.add('btn-countdown');

    const updateText = () => {
        const remaining = Math.ceil((endTime - Date.now()) / 1000);
        if (remaining <= 0) return false;

        const minutes = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const timeStr = minutes > 0
            ? `${minutes}:${secs.toString().padStart(2, '0')}`
            : `${secs}`;
        button.innerHTML = `<span class="countdown-text">יש להמתין עד לניסיון הבא ${timeStr}</span>`;
        return true;
    };

    updateText();

    const interval = setInterval(() => {
        if (!updateText()) {
            clearInterval(interval);
            localStorage.removeItem(storageKey);
            button.disabled = false;
            button.classList.remove('btn-countdown');
            button.textContent = originalText;
        }
    }, 1000);

    return interval;
}

