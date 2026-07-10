import { NextRequest, NextResponse } from "next/server";
import { getRedis, redisGetJson } from "@/lib/server/redis";
import type { RankingItem } from "@/types";

export const dynamic = "force-dynamic";

type FullRanking = { items: RankingItem[]; cachedAt: number };

// 模块级缓存：存储原始字符串与已解析结果，避免同版本数据的重复 JSON.parse
// （redisGetJson 内部已 parse 一次；此处改为 get 原始字符串 + 模块级 {raw, parsed} 缓存）
let fullCache: { raw: string; parsed: FullRanking } | null = null;

function buildContext(items: RankingItem[], playerId: string) {
  const playerIndex = items.findIndex((item) => item.playerId === playerId);
  const player = items[playerIndex] || null;
  const top10 = items.slice(0, 10);
  const top10Last = top10[9] || null;
  const previousPlayer = playerIndex > 0 ? items[playerIndex - 1] : null;
  return {
    player,
    rank: player?.rank || 0,
    top10,
    distanceToTop10: player && top10Last && player.rank > 10 ? Math.max(0, top10Last.totalScore - player.totalScore + 1) : null,
    previousPlayer,
    distanceToPrevious: player && previousPlayer ? Math.max(0, previousPlayer.totalScore - player.totalScore + 1) : null
  };
}

export async function GET(request: NextRequest) {
  const playerId = request.nextUrl.searchParams.get("playerId");
  const [ranking, games] = await Promise.all([
    redisGetJson<object>("snap:ranking"),
    redisGetJson<object>("snap:games")
  ]);

  let context = null;
  if (playerId) {
    try {
      const raw = await getRedis().get("snap:fullranking");
      if (raw) {
        // 只在原始字符串变化时重新解析
        if (!fullCache || fullCache.raw !== raw) {
          fullCache = { raw, parsed: JSON.parse(raw) as FullRanking };
        }
        context = buildContext(fullCache.parsed.items, playerId);
      }
    } catch {
      // Redis 不可用，context 保持 null
    }
  }

  return NextResponse.json({ ranking, games, context });
}
