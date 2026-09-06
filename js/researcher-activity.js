import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    collectionGroup,
    doc,
    getDoc,
    getDocsFromServer,
    query
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from "./toast.js";
import { isRetryableFirestoreError } from "./firestore-errors.js";
import { checkAdminAccess, showAdminStatusBadge } from "./admin-status.js?v=20260826-2";
import {
    normalizeExternalLeadResearchers,
    normalizeLeadResearchers
} from "./lead-researchers.js?v=20260818-1";

let activityRows = [];

document.addEventListener("DOMContentLoaded", () => {
    initSidebar();
    document.getElementById("btn-logout")?.addEventListener("click", handleLogout);
    document.getElementById("btn-print")?.addEventListener("click", () => window.print());
    document.getElementById("btn-retry-report")?.addEventListener("click", retryActivityReport);
    document.getElementById("researcher-search")?.addEventListener("input", (event) => {
        renderRows(filterRows(event.target.value));
    });
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }

    await loadUserName(user);

    if (!(await checkAdminAccess(user))) {
        showToast("אין לך הרשאת מנהל לצפייה בדוח זה", "error");
        setTimeout(() => { window.location.href = "dashboard.html"; }, 1500);
        return;
    }

    showAdminStatusBadge();
    await loadActivityReport();
});

function initSidebar() {
    const button = document.getElementById("hamburger-btn");
    const sidebar = document.querySelector(".sidebar");
    const overlay = document.getElementById("sidebar-overlay");

    const closeSidebar = () => {
        sidebar?.classList.remove("open");
        overlay?.classList.remove("active");
        const icon = button?.querySelector("i");
        icon?.classList.add("fa-bars");
        icon?.classList.remove("fa-times");
    };

    button?.addEventListener("click", () => {
        sidebar?.classList.toggle("open");
        overlay?.classList.toggle("active");
        const icon = button.querySelector("i");
        icon?.classList.toggle("fa-bars");
        icon?.classList.toggle("fa-times");
    });
    overlay?.addEventListener("click", closeSidebar);
}

async function loadUserName(user) {
    const nameElement = document.getElementById("user-display-name");
    if (!nameElement) return;

    nameElement.textContent = user.email || "מנהל/ת";
    try {
        const snapshot = await getDoc(doc(db, "users", user.uid));
        if (!snapshot.exists()) return;
        const data = snapshot.data();
        const fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim();
        nameElement.textContent = fullName || user.email || "מנהל/ת";
    } catch (error) {
        console.error("Failed to load administrator name:", error);
    }
}

async function loadActivityReport() {
    try {
        const [experimentsSnapshot, usersSnapshot] = await Promise.all([
            getDocsFromServer(query(collectionGroup(db, "experiments"))),
            getDocsFromServer(collection(db, "users"))
        ]);

        const directory = buildResearcherDirectory(usersSnapshot);
        activityRows = calculateActivity(experimentsSnapshot, directory);

        setText("total-experiments", experimentsSnapshot.size);
        setText("active-researchers", usersSnapshot.size);
        setText("generated-at", `הדוח הופק: ${new Intl.DateTimeFormat("he-IL", {
            dateStyle: "short",
            timeStyle: "short"
        }).format(new Date())}`);

        renderRows(activityRows);
        document.getElementById("loading-state")?.setAttribute("hidden", "");
        document.getElementById("report-content")?.removeAttribute("hidden");
    } catch (error) {
        console.error("Failed to load researcher activity report:", error);
        document.getElementById("loading-state")?.setAttribute("hidden", "");
        document.getElementById("error-state")?.removeAttribute("hidden");

        const canRetry = isRetryableFirestoreError(error);
        setText(
            "error-message",
            error?.code === "permission-denied"
                ? "אין הרשאה לקריאת נתוני המערכת. יש לפתוח את הדוח מחשבון מנהל מאושר."
                : canRetry
                    ? "החיבור לשרת נכשל ולכן הדוח לא נטען. אפשר לנסות שוב."
                    : "אירעה שגיאה בטעינת הדוח. כדאי לרענן את העמוד ולנסות שוב."
        );
        // Only offer the button when a retry can actually help - a permission or
        // index error would just fail again with the same message.
        toggleRetryButton(canRetry);
        showToast("לא ניתן לטעון את דוח פעילות החוקרים", "error");
    }
}

/** מציג או מסתיר את כפתור "נסה שוב" שבמסך השגיאה. */
function toggleRetryButton(visible) {
    const button = document.getElementById("btn-retry-report");
    if (!button) return;

    if (visible) {
        button.disabled = false;
        button.removeAttribute("hidden");
    } else {
        button.setAttribute("hidden", "");
    }
}

/** טעינה חוזרת של הדוח אחרי כשל רשת, בלי לרענן את כל העמוד. */
async function retryActivityReport() {
    const button = document.getElementById("btn-retry-report");
    if (button) button.disabled = true;

    document.getElementById("error-state")?.setAttribute("hidden", "");
    toggleRetryButton(false);
    document.getElementById("loading-state")?.removeAttribute("hidden");

    // loadActivityReport מטפל בעצמו בשגיאה ומחזיר את מסך השגיאה במידת הצורך.
    await loadActivityReport();
}

function buildResearcherDirectory(snapshot) {
    const byUid = new Map();
    const byEmail = new Map();
    const byName = new Map();

    snapshot.forEach((userDoc) => {
        const data = userDoc.data();
        const name = `${data.firstName || ""} ${data.lastName || ""}`.trim();
        const email = String(data.email || "").trim();
        const identity = {
            key: `uid:${userDoc.id}`,
            uid: userDoc.id,
            name: name || email || "משתמש/ת ללא שם",
            email,
            isExternal: false
        };

        byUid.set(userDoc.id, identity);
        addDirectoryCandidate(byEmail, normalize(email), identity);
        addDirectoryCandidate(byName, normalize(name), identity);
    });

    return { byUid, byEmail, byName };
}

function addDirectoryCandidate(index, normalizedValue, identity) {
    if (!normalizedValue) return;
    if (!index.has(normalizedValue)) index.set(normalizedValue, []);
    index.get(normalizedValue).push(identity);
}

function calculateActivity(experimentsSnapshot, directory) {
    const activityByResearcher = new Map();

    // Start with the complete user directory so users without any
    // experiment activity are still included with zero values.
    directory.byUid.forEach((identity) => {
        ensureActivity(activityByResearcher, identity);
    });

    experimentsSnapshot.forEach((experimentDoc) => {
        const data = experimentDoc.data();
        const pathOwnerUid = experimentDoc.ref.parent.parent?.id || "";
        const ownerUid = String(pathOwnerUid || data.ownerUid || "").trim();
        const experimentKey = `${pathOwnerUid}:${experimentDoc.id}`;

        const owner = resolveIdentity({
            uid: ownerUid,
            name: data.creatorName || ""
        }, directory);
        if (owner) addRole(activityByResearcher, owner, "created", experimentKey);

        const partners = new Map();
        const addPartner = (value) => {
            const identity = resolveIdentity(value, directory);
            if (identity) partners.set(identity.key, identity);
        };

        if (data.permissions && typeof data.permissions === "object" && !Array.isArray(data.permissions)) {
            Object.keys(data.permissions).forEach((uid) => addPartner({ uid }));
        }
        if (Array.isArray(data.experimentPartners)) data.experimentPartners.forEach(addPartner);
        if (Array.isArray(data.partners)) data.partners.forEach(addPartner);

        partners.forEach((identity) => {
            addRole(activityByResearcher, identity, "partner", experimentKey);
        });

        normalizeLeadResearchers(data).forEach((leadResearcher) => {
            const lead = resolveIdentity(leadResearcher, directory);
            if (lead) addRole(activityByResearcher, lead, "lead", experimentKey);
        });
        normalizeExternalLeadResearchers(data).forEach((name) => {
            addRole(activityByResearcher, {
                key: `external:${normalize(name)}`,
                uid: "",
                name,
                email: "",
                isExternal: true
            }, "lead", experimentKey);
        });
    });

    return Array.from(activityByResearcher.values())
        .map((row) => ({
            ...row,
            experimentCount: row.experiments.size
        }))
        .sort((a, b) => (
            Number(a.isExternal) - Number(b.isExternal)
            || b.experimentCount - a.experimentCount
            || b.created - a.created
            || b.partner - a.partner
            || b.lead - a.lead
            || a.name.localeCompare(b.name, "he")
        ));
}

function resolveIdentity(value, directory) {
    if (!value) return null;

    const candidate = typeof value === "string"
        ? { name: value }
        : {
            uid: String(value.uid || "").trim(),
            name: String(value.name || value.fullName || "").trim(),
            email: String(value.email || "").trim()
        };

    if (candidate.uid && directory.byUid.has(candidate.uid)) {
        return directory.byUid.get(candidate.uid);
    }

    const normalizedEmail = normalize(candidate.email);
    const emailMatches = normalizedEmail ? directory.byEmail.get(normalizedEmail) : null;
    if (emailMatches?.length === 1) return emailMatches[0];

    const rawName = String(candidate.name || "").trim();
    const normalizedName = normalize(rawName);
    const nameMatches = normalizedName ? directory.byName.get(normalizedName) : null;
    if (nameMatches?.length === 1) return nameMatches[0];

    const looksLikeEmail = rawName.includes("@");
    if (looksLikeEmail) {
        const rawEmailMatches = directory.byEmail.get(normalizedName);
        if (rawEmailMatches?.length === 1) return rawEmailMatches[0];
    }

    if (!candidate.uid && !rawName && !candidate.email) return null;

    const fallbackName = rawName || candidate.email || (candidate.uid ? `משתמש/ת ${candidate.uid.slice(0, 8)}` : "משתמש/ת לא מזוהה");
    const fallbackEmail = candidate.email || (looksLikeEmail ? rawName : "");
    const fallbackKey = candidate.uid
        ? `uid:${candidate.uid}`
        : fallbackEmail
            ? `email:${normalize(fallbackEmail)}`
            : `name:${normalizedName}`;

    return {
        key: fallbackKey,
        uid: candidate.uid || "",
        name: fallbackName,
        email: fallbackEmail,
        isExternal: false
    };
}

function addRole(activityMap, identity, role, experimentKey) {
    const activity = ensureActivity(activityMap, identity);
    activity[role] += 1;
    activity.experiments.add(experimentKey);
}

function ensureActivity(activityMap, identity) {
    if (!activityMap.has(identity.key)) {
        activityMap.set(identity.key, {
            key: identity.key,
            name: identity.name,
            email: identity.email,
            isExternal: Boolean(identity.isExternal),
            created: 0,
            partner: 0,
            lead: 0,
            experiments: new Set()
        });
    }

    return activityMap.get(identity.key);
}

function filterRows(searchTerm) {
    const term = normalize(searchTerm);
    if (!term) return activityRows;
    return activityRows.filter((row) => (
        normalize(row.name).includes(term)
        || normalize(row.email).includes(term)
        || (row.isExternal && normalize("משתמש לא רשום במערכת").includes(term))
    ));
}

function renderRows(rows) {
    const tableBody = document.getElementById("activity-table-body");
    const emptyState = document.getElementById("empty-state");
    if (!tableBody || !emptyState) return;

    tableBody.replaceChildren();
    emptyState.toggleAttribute("hidden", rows.length > 0);

    let registeredRank = 0;
    let externalSectionRendered = false;
    const externalCount = rows.filter((row) => row.isExternal).length;

    rows.forEach((row) => {
        if (row.isExternal && !externalSectionRendered) {
            tableBody.appendChild(createExternalSectionRow(externalCount));
            externalSectionRendered = true;
        }

        const tableRow = document.createElement("tr");
        if (row.isExternal) tableRow.classList.add("external-researcher-row");
        tableRow.appendChild(createCell(row.isExternal ? "—" : ++registeredRank, "numeric rank-cell"));

        const identityCell = document.createElement("td");
        const name = document.createElement("div");
        name.className = "researcher-name";
        name.textContent = row.name;
        identityCell.appendChild(name);
        if (row.isExternal) {
            const badge = document.createElement("span");
            badge.className = "external-researcher-badge";
            badge.textContent = "(משתמש לא רשום במערכת)";
            identityCell.appendChild(badge);
        }
        if (row.email && normalize(row.email) !== normalize(row.name)) {
            const email = document.createElement("div");
            email.className = "researcher-email";
            email.textContent = row.email;
            identityCell.appendChild(email);
        }
        tableRow.appendChild(identityCell);

        tableRow.appendChild(createCell(row.created, "numeric"));
        tableRow.appendChild(createCell(row.partner, "numeric"));
        tableRow.appendChild(createCell(row.lead, "numeric"));

        tableBody.appendChild(tableRow);
    });
}

function createExternalSectionRow(externalCount) {
    const row = document.createElement("tr");
    row.className = "external-section-row";
    const cell = document.createElement("td");
    cell.colSpan = 5;

    const content = document.createElement("div");
    content.className = "external-section-content";
    const icon = document.createElement("i");
    icon.className = "fas fa-user-slash";
    icon.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong");
    title.textContent = "חוקרים מובילים שאינם רשומים במערכת";
    const count = document.createElement("span");
    count.textContent = externalCount === 1
        ? "חוקר חיצוני אחד"
        : `${externalCount} חוקרים חיצוניים`;
    content.append(icon, title, count);
    cell.appendChild(content);
    row.appendChild(cell);
    return row;
}

function createCell(value, className = "") {
    const cell = document.createElement("td");
    cell.className = className;
    cell.textContent = String(value);
    return cell;
}

function normalize(value) {
    return String(value || "")
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("he");
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
}

async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Failed to sign out:", error);
        showToast("לא ניתן להתנתק כרגע", "error");
    }
}
