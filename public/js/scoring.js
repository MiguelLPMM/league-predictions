// Scoring, per league season: off = predicted_rank - actual_rank for every
// team that has an actual rank (positive = rated worse than reality /
// "underrated", negative = "overrated"). total = sum of |off| (lower is
// better); bangOn = number of teams with off = 0 (tie-break: more wins).
//   predictedRankByTeamId: Map(team_id -> rank)
//   actualStandings: [{ team_id, position }]
export function computeOffsets(predictedRankByTeamId, actualStandings) {
    const offsetByTeamId = new Map();
    let total = 0;
    let bangOn = 0;

    actualStandings.forEach((row) => {
        const predicted = predictedRankByTeamId.get(row.team_id);
        if (predicted == null) return;
        const off = predicted - row.position;
        offsetByTeamId.set(row.team_id, off);
        total += Math.abs(off);
        if (off === 0) bangOn++;
    });

    return { offsetByTeamId, total, bangOn };
}

export const formatOff = (off) => (off > 0 ? `+${off}` : String(off));
