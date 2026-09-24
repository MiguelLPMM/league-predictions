// The six leagues, in display order: [slug, label].
export const LEAGUES = [
    ['premierleague', 'Premier League'],
    ['laliga', 'La Liga'],
    ['bundesliga', 'Bundesliga'],
    ['seriea', 'Serie A'],
    ['ligue1', 'Ligue 1'],
    ['ligaportugal', 'Liga Portugal'],
];

export const LEAGUE_SLUGS = LEAGUES.map(([slug]) => slug);
export const LEAGUE_LABELS = Object.fromEntries(LEAGUES);

// season_year 2025 -> "2025/26"
export const seasonLabel = (year) => `${year}/${String(year + 1).slice(-2)}`;
