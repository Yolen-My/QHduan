import { buildRanking, getOfficeAverageRanking, getOfficeTop3, getTop10Ranking } from "../lib/ranking.ts";
import type { Game, OfficeAverageItem, OfficeTop3Group, Player, RankingItem } from "../types/index.ts";

export type RankingSnapshot = {
  top10: RankingItem[];
  officeAverage: OfficeAverageItem[];
  officeTop3: OfficeTop3Group[];
  participantCount: number;
  cachedAt: number;
};

export type GamesSnapshot = { games: Game[]; cachedAt: number };

export type ResultLite = {
  player: string;
  gameKey: string;
  pendingBingoScore: boolean;
  quizSessionIndex?: number;
};

export type AdminSnapshot = {
  resultCounts: Record<string, number>;
  quizSectorCounts: number[];
  pendingBingo: number;
  participantCount: number;
  cachedAt: number;
};

export function buildRankingSnapshot(players: Player[], now: number): RankingSnapshot {
  return {
    top10: getTop10Ranking(players),
    officeAverage: getOfficeAverageRanking(players),
    officeTop3: getOfficeTop3(players),
    participantCount: players.length,
    cachedAt: now
  };
}

export function buildFullRanking(players: Player[]): RankingItem[] {
  return buildRanking(players);
}

export function buildGamesSnapshot(games: Game[], now: number): GamesSnapshot {
  return { games: [...games].sort((a, b) => a.order - b.order), cachedAt: now };
}

export function buildAdminSnapshot(players: Player[], results: ResultLite[], now: number): AdminSnapshot {
  const resultCounts: Record<string, number> = { bingo: 0, quiz: 0, story: 0, elimination: 0 };
  const quizSectorPlayers: Array<Set<string>> = [new Set(), new Set(), new Set(), new Set(), new Set()];
  let pendingBingo = 0;
  for (const r of results) {
    if (resultCounts[r.gameKey] !== undefined) resultCounts[r.gameKey] += 1;
    if (r.gameKey === "bingo" && r.pendingBingoScore) pendingBingo += 1;
    if (r.gameKey === "quiz") {
      const idx = Number.isInteger(r.quizSessionIndex) ? (r.quizSessionIndex as number) : 0;
      if (idx >= 0 && idx <= 4) quizSectorPlayers[idx].add(r.player);
    }
  }
  return {
    resultCounts,
    quizSectorCounts: quizSectorPlayers.map((s) => s.size),
    pendingBingo,
    participantCount: players.length,
    cachedAt: now
  };
}

export function comparablePayload(snap: object): string {
  const { cachedAt: _cachedAt, ...rest } = snap as { cachedAt?: number };
  return JSON.stringify(rest);
}
