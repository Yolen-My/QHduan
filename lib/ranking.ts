import type { OfficeAverageItem, OfficeTop3Group, Player, RankingItem } from "@/types";

function comparePlayers(left: Player, right: Player): number {
  if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore;
  // 空值安全:导入/历史数据可能缺 finalCompletedAt/updated/created 任一字段,
  // 兜底为空串,避免 undefined.localeCompare 崩溃。
  const leftDone = left.finalCompletedAt || left.updated || left.created || "";
  const rightDone = right.finalCompletedAt || right.updated || right.created || "";
  if (leftDone !== rightDone) return leftDone.localeCompare(rightDone);
  return (left.created || "").localeCompare(right.created || "");
}

export function buildRanking(players: Player[]): RankingItem[] {
  return [...players].sort(comparePlayers).map((player, index) => ({
    rank: index + 1,
    playerId: player.id,
    name: player.name,
    office: player.office,
    team: player.team,
    totalScore: player.totalScore,
    completedAt: player.finalCompletedAt
  }));
}

export function getTop10Ranking(players: Player[]): RankingItem[] {
  return buildRanking(players).slice(0, 10);
}

export function getPlayerRank(players: Player[], playerId: string): number {
  return buildRanking(players).find((item) => item.playerId === playerId)?.rank || 0;
}

export function getOfficeAverageRanking(players: Player[]): OfficeAverageItem[] {
  const groups = new Map<string, Player[]>();
  players.forEach((player) => {
    groups.set(player.office, [...(groups.get(player.office) || []), player]);
  });
  return [...groups.entries()]
    .map(([office, officePlayers]) => ({
      rank: 0,
      office,
      playerCount: officePlayers.length,
      averageScore: Math.round(officePlayers.reduce((sum, player) => sum + player.totalScore, 0) / officePlayers.length)
    }))
    .sort((left, right) => right.averageScore - left.averageScore)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function getOfficeTop3(players: Player[]): OfficeTop3Group[] {
  const groups = new Map<string, Player[]>();
  players.forEach((player) => {
    groups.set(player.office, [...(groups.get(player.office) || []), player]);
  });
  return [...groups.entries()].map(([office, officePlayers]) => ({
    office,
    players: buildRanking(officePlayers).slice(0, 3)
  }));
}

export function getPlayerRankingContext(players: Player[], playerId: string) {
  const ranking = buildRanking(players);
  const playerIndex = ranking.findIndex((item) => item.playerId === playerId);
  const player = ranking[playerIndex] || null;
  const top10 = ranking.slice(0, 10);
  const top10Last = top10[9] || null;
  const previousPlayer = playerIndex > 0 ? ranking[playerIndex - 1] : null;

  return {
    player,
    rank: player?.rank || 0,
    top10,
    distanceToTop10: player && top10Last && player.rank > 10 ? Math.max(0, top10Last.totalScore - player.totalScore + 1) : null,
    previousPlayer,
    distanceToPrevious: player && previousPlayer ? Math.max(0, previousPlayer.totalScore - player.totalScore + 1) : null
  };
}
