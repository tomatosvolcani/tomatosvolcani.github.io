/**
 * AI / LLM FUTURE-LAUNCH GATE
 *
 * The AI feature is implemented but INTENTIONALLY HIDDEN from users until its
 * future launch. To expose it again, change only the following value to `true`.
 * Keep the implementation in the repository; do not delete the AI modules.
 */
window.EXPERIMENT_AI_ENABLED = false;

document.querySelectorAll('[data-ai-feature-entry]').forEach((element) => {
    element.hidden = !window.EXPERIMENT_AI_ENABLED;
    element.setAttribute('aria-hidden', String(!window.EXPERIMENT_AI_ENABLED));
});

// Local Flask backend. Because Flask serves the whole project, a relative URL works end-to-end.
// Later, replace this with the deployed Firebase Cloud Function URL or a Hosting rewrite.
window.EXPERIMENT_AI_API_URL = '/api/ai/parse-experiment';
