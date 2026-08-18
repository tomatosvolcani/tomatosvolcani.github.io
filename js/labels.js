// js/labels.js
// Central display labels for stored experiment codes.

export const SITE_LABELS = {
    'volcani-bet-dagan': 'מכון וולקני - בית דגן',
    'mop-darom': 'מו"פ דרום',
    'gilat': 'גילת',
    'other': 'אחר',
};

export const WORK_PACKAGE_LABELS = {
    wp1: 'חבילת עבודה 1 – אגרוטכניקה',
    wp2: 'חבילת עבודה 2 – הגנה"צ',
    wp3: 'חבילת עבודה 3 – קרקע ומים (הדשייה)',
    wp4: 'חבילת עבודה 4 – חקלאות מקיימת',
    wp5: 'חבילת עבודה 5 – היבטים כלכליים לשיפור הרווחיות',
    wp6: 'חבילת עבודה 6 – צמצום השימוש בידיים עובדות',
    wp7: 'חבילת עבודה 7 - פיילוט זנים מסיימים',
    'not-related': 'לא שייך למיזם ח"ץ',
};

function mappedLabel(labels, value) {
    const trimmed = value === null || value === undefined ? '' : String(value).trim();
    if (!trimmed) return null;
    return labels[trimmed] || trimmed;
}

export function siteLabel(value) {
    return mappedLabel(SITE_LABELS, value);
}

export function packageLabel(value) {
    return mappedLabel(WORK_PACKAGE_LABELS, value);
}