export const MAX_LEAD_RESEARCHERS = 20;

function clean(value) {
    return String(value || '').trim();
}

export function normalizeLeadResearchers(value) {
    const source = Array.isArray(value)
        ? value
        : (Array.isArray(value?.leadResearchers) ? value.leadResearchers : []);
    const byUid = new Map();

    source.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const uid = clean(item.uid);
        if (!uid || byUid.has(uid)) return;

        const name = clean(item.name || item.fullName);
        const email = clean(item.email);
        byUid.set(uid, { uid, name, email });
    });

    return Array.from(byUid.values()).slice(0, MAX_LEAD_RESEARCHERS);
}

export function getLeadResearcherUids(value) {
    return normalizeLeadResearchers(value).map((researcher) => researcher.uid);
}

export function getLeadResearchersText(value, options = {}) {
    const { includeEmail = false, separator = ', ', fallback = '' } = options;
    const labels = normalizeLeadResearchers(value).map((researcher) => {
        const name = researcher.name || researcher.email || researcher.uid;
        if (!includeEmail || !researcher.email || researcher.email === name) return name;
        return `${name} (${researcher.email})`;
    });
    return labels.length ? labels.join(separator) : fallback;
}

export function getLeadResearchersSearchText(value) {
    return normalizeLeadResearchers(value)
        .flatMap((researcher) => [researcher.name, researcher.email, researcher.uid])
        .filter(Boolean)
        .join(' ');
}

export function getLegacyLeadResearcherText(value) {
    return clean(value?.leadResearcher);
}

export function needsLeadResearcherMigration(value) {
    return Boolean(getLegacyLeadResearcherText(value));
}
