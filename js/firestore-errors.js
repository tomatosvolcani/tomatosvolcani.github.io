// js/firestore-errors.js
// Shared classification of Firestore errors.
//
// Since the move to getDocsFromServer / getDocFromServer, a blocked or flaky
// transport surfaces as a thrown error instead of a silently empty snapshot.
// Pages need to tell apart "the network failed, offering a retry makes sense"
// from "the rules said no / the index is missing", where retrying changes nothing.

/** Firestore error codes that a plain retry can plausibly resolve. */
const RETRYABLE_CODES = new Set([
    "unavailable",        // transport blocked or offline - the WebChannel/long-polling case
    "deadline-exceeded",  // request timed out on a slow network
    "internal",
    "resource-exhausted",
    "aborted",
    "cancelled",
    "unknown"
]);

/**
 * Is this error worth offering a "try again" button for?
 *
 * Deliberately conservative: anything without a recognised transient code is
 * treated as permanent, so the UI never promises a retry that cannot help.
 * Note that "failed-precondition" (usually a missing composite index) and
 * "permission-denied" are intentionally NOT retryable.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableFirestoreError(error) {
    return RETRYABLE_CODES.has(error?.code);
}
