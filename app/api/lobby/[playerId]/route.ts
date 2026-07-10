import { NextRequest, NextResponse } from "next/server";
import { redisGetJson } from "@/lib/server/redis";
import { getServerPB } from "@/lib/server/pb";
import type { GameResult, RankingItem } from "@/types";

export const dynamic = "force-dynamic";

function normalizeGroups(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 7))].sort((a, b) => a - b);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params;
  const pb = getServerPB();

  try {
    const [playerRecord, resultRecords, gamesSnap] = await Promise.all([
      pb.collection("players").getOne(playerId),
      pb.collection("game_results").getFullList({
        filter: pb.filter("player = {:playerId}", { playerId }),
        sort: "completedAt"
      }),
      redisGetJson<{ games: unknown[] }>("snap:games")
    ]);

    const games = gamesSnap?.games
      ?? await pb.collection("games").getFullList({ sort: "order" }); // Redis 回退

    const results: GameResult[] = resultRecords.map((r: any) => ({
      id: r.id,
      player: r.player,
      gameKey: r.gameKey,
      answers: r.answers,
      score: r.score,
      maxScore: r.maxScore,
      completedAt: r.completedAt,
      pendingBingoScore: typeof r.pendingBingoScore === "boolean" ? r.pendingBingoScore : Boolean(r.answers?.pendingBingoScore),
      quizSessionIndex: r.quizSessionIndex,
      sectorKey: r.sectorKey || undefined,
      sectorName: r.sectorName || undefined
    }));

    // 名次：优先 Redis 全量榜，回退 count 查询
    let rank = 0;
    const full = await redisGetJson<{ items: RankingItem[] }>("snap:fullranking");
    if (full) {
      rank = full.items.find((item) => item.playerId === playerId)?.rank || 0;
    } else {
      const ahead = await pb.collection("players").getList(1, 1, {
        filter: pb.filter("totalScore > {:score}", { score: playerRecord.totalScore || 0 }),
        fields: "id"
      });
      rank = ahead.totalItems + 1;
    }

    const quizGame: any = (games as any[]).find((g) => g.key === "quiz");
    const openGroups = normalizeGroups(quizGame?.quizOpenGroups);
    const settledQuiz = results.filter((r) => r.gameKey === "quiz" && !r.pendingBingoScore);
    const completedGroups = normalizeGroups(settledQuiz.map((r) => r.quizSessionIndex));
    const completedSet = new Set(completedGroups);

    return NextResponse.json({
      player: {
        id: playerRecord.id,
        name: playerRecord.name,
        phone: playerRecord.phone,
        office: playerRecord.office,
        team: playerRecord.team,
        totalScore: playerRecord.totalScore || 0,
        completedGames: playerRecord.completedGames || [],
        finalSubmitted: Boolean(playerRecord.finalSubmitted),
        created: playerRecord.created,
        updated: playerRecord.updated || playerRecord.created,
        finalCompletedAt: playerRecord.finalCompletedAt || undefined
      },
      rank,
      results,
      quizProgress: {
        completedCount: completedGroups.length,
        totalCount: 5,
        score: settledQuiz.reduce((sum, r) => sum + r.score, 0),
        maxScore: 100,
        openGroups,
        availableGroups: openGroups.filter((g) => !completedSet.has(g)),
        completedGroups
      },
      games
    });
  } catch {
    return NextResponse.json({ player: null, rank: 0, results: [], quizProgress: null, games: [] }, { status: 404 });
  }
}
