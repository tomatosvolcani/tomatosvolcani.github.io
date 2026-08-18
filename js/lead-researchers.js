export const MAX_LEAD_RESEARCHERS = 20;

function clean(value) {
    return String(value || '').trim();
}

function normalizedNameKey(value) {
    return clean(value)
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase('he');
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

export function normalizeExternalLeadResearchers(value) {
    const source = Array.isArray(value)
        ? value
        : (typeof value === 'string'
            ? [value]
            : (Array.isArray(value?.externalLeadResearchers) ? value.externalLeadResearchers : []));
    const byName = new Map();

    source.forEach((item) => {
        if (typeof item !== 'string') return;
        item.split(/[,\n]+/).forEach((part) => {
            const name = clean(part).replace(/\s+/g, ' ');
            const key = normalizedNameKey(name);
            if (!key || byName.has(key)) return;
            byName.set(key, name);
        });
    });

    return Array.from(byName.values()).slice(0, MAX_LEAD_RESEARCHERS);
}

export function getLeadResearchersText(value, options = {}) {
    const {
        includeEmail = false,
        separator = ', ',
        fallback = '',
        markExternal = true
    } = options;
    const labels = normalizeLeadResearchers(value).map((researcher) => {
        const name = researcher.name || researcher.email || researcher.uid;
        if (!includeEmail || !researcher.email || researcher.email === name) return name;
        return `${name} (${researcher.email})`;
    });
    normalizeExternalLeadResearchers(value).forEach((name) => {
        labels.push(markExternal ? `${name} (משתמש לא רשום במערכת)` : name);
    });
    return labels.length ? labels.join(separator) : fallback;
}

export function getLeadResearchersSearchText(value) {
    const registeredText = normalizeLeadResearchers(value)
        .flatMap((researcher) => [researcher.name, researcher.email, researcher.uid])
        .filter(Boolean)
        .join(' ');
    return [registeredText, ...normalizeExternalLeadResearchers(value)]
        .filter(Boolean)
        .join(' ');
}

export function getLegacyLeadResearcherText(value) {
    return clean(value?.leadResearcher);
}

export function needsLeadResearcherMigration(value) {
    return Boolean(getLegacyLeadResearcherText(value));
}
