/**
 * AI / LLM RELEASE CONFIG
 *
 * The AI assistant is LIVE. Two independent switches control it:
 *
 * 1. window.EXPERIMENT_AI_ENABLED (below) — system-wide kill switch. Set it to
 *    false to take the feature down for everyone with a hosting deploy only,
 *    no Cloud Function redeploy.
 * 2. users/{uid}.allowAI in Firestore — per-user switch. register.js creates
 *    every new user with allowAI: true. Set it to false in the Firebase Console
 *    to block a single user. Firestore rules make the field immutable for every
 *    client (admins included), so the Console / Admin SDK is the only way to
 *    change it. The Cloud Function re-checks it server-side, so what happens
 *    here is UI gating only — never the security boundary.
 */
window.EXPERIMENT_AI_ENABLED = true;

/**
 * Show or hide every AI entry point ([data-ai-feature-entry]).
 * experiment.js calls this once users/{uid} is loaded. The entries start hidden
 * so the button never flashes on for a user whose allowAI is false.
 */
window.setExperimentAiEntryVisible = function (visible) {
    const show = Boolean(visible) && window.EXPERIMENT_AI_ENABLED === true;
    document.querySelectorAll('[data-ai-feature-entry]').forEach((element) => {
        element.hidden = !show;
        element.setAttribute('aria-hidden', String(!show));
    });
};

window.setExperimentAiEntryVisible(false);

/**
 * Where the AI request goes.
 *
 * The live site is GitHub Pages (tomatosvolcani.github.io), which is a plain
 * static host with no rewrites — so every deployed origin calls the Cloud
 * Function URL directly, cross-origin. The allowed origins are the CORS list in
 * backend/main.py; tomatosvolcani.github.io must also stay in Firebase Auth →
 * Settings → Authorized domains.
 *
 * Only the local Flask dev server (backend/app.py) answers the relative path,
 * because it serves the site and the API from the same port.
 *
 * The endpoint is a Cloud Run service (`parse-experiment`, region me-west1),
 * not a Firebase-deployed Cloud Function — see the deploy notes in AGENTS.md
 * for why. It is the same container entrypoint a gen2 function would use, so
 * the request/response contract is identical.
 *
 * Cloud Run also serves this under the legacy URL
 * https://parse-experiment-r2xvevlp2a-zf.a.run.app — both work; the one below
 * is the deterministic <service>-<project-number>.<region>.run.app form.
 *
 * AFTER REDEPLOYING: confirm the URL with
 * `gcloud run services describe parse-experiment --region=me-west1`.
 * For a one-off test without editing this file, set
 * localStorage['experiment-ai-api-url'] in the browser console.
 */
const AI_FUNCTION_URL = 'https://parse-experiment-422701013051.me-west1.run.app';
const AI_LOCAL_PATH = '/api/ai/parse-experiment';
const AI_LOCAL_HOSTS = ['localhost', '127.0.0.1'];

window.EXPERIMENT_AI_API_URL = (() => {
    try {
        const override = localStorage.getItem('experiment-ai-api-url');
        if (override) return override;
    } catch (error) {
        // Private-mode / blocked storage — fall through to the default.
    }
    return AI_LOCAL_HOSTS.includes(window.location.hostname) ? AI_LOCAL_PATH : AI_FUNCTION_URL;
})();
