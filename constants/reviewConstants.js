const RATING_CONFIG = {
    5: { label: 'Masterpiece', color: '#a855f7', value: 5 },
    4: { label: 'Banger', color: '#10b981', value: 4 },
    3: { label: 'Decent', color: '#3b82f6', value: 3 },
    2: { label: 'Mid', color: '#eab308', value: 2 },
    1: { label: 'Skip', color: '#ef4444', value: 1 },
};

const RATING_OPTIONS = [
    RATING_CONFIG[1],
    RATING_CONFIG[2],
    RATING_CONFIG[3],
    RATING_CONFIG[4],
    RATING_CONFIG[5],
];

module.exports = { RATING_CONFIG, RATING_OPTIONS };
