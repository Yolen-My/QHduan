// Node.js lacks a native EventSource; PocketBase realtime uses it for SSE.
// Polyfill must be set before importing pocketbase.
import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

import PocketBase from "pocketbase";
import Redis from "ioredis";
import {
  buildAdminSnapshot,
  buildFullRanking,
  buildGamesSnapshot,
  buildRankingSnapshot,
  comparablePayload,
  type GamesSnapshot,
  type RankingSnapshot,
  type ResultLite
} from "./snapshot.ts";
import type { Game, Player } from "../types/index.ts";

const DEBOUNCE_MS = 300;         // 事件合并窗口
const MIN_PUSH_INTERVAL_MS = 1500; // 快照最小推送间隔(带宽预算的核心闸门)
const FALLBACK_POLL_MS = 2000;   // realtime 订阅失败时网关自身的兜底轮询(全场仍只有这一处轮询)

type GatewayEvents = {
  onSnapshot: (key: "ranking" | "games", data: RankingSnapshot | GamesSnapshot) => void;
  onPersonalResult: (playerId: string, gameKey: string) => void;
  onBingoScored: () => void;
};

function mapPlayer(r: any): Player {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone || "",
    office: r.office,
    team: r.team,
    totalScore: r.totalScore || 0,
    completedGames: r.completedGames || [],
    finalSubmitted: Boolean(r.finalSubmitted),
    created: r.created,
    updated: r.updated || r.created,
    finalCompletedAt: r.finalCompletedAt || undefined
  };
}

function mapGame(r: any): Game {
  let bingoPhase = r.bingoPhase;
  if (r.key === "bingo" && !bingoPhase) bingoPhase = r.bingoScored ? "auto_score" : "open";
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    maxScore: r.key === "elimination" ? 200 : r.maxScore,
    isOpen: Boolean(r.isOpen),
    order: r.order,
    bingoScored: Boolean(r.bingoScored),
    bingoPhase,
    quizCurrentGroup: r.quizCurrentGroup || 0,
    quizOpenGroups: Array.isArray(r.quizOpenGroups) ? r.quizOpenGroups : [],
    created: r.created,
    updated: r.updated
  };
}

function mapResult(r: any): ResultLite & { id: string } {
  return {
    id: r.id,
    player: r.player,
    gameKey: r.gameKey,
    pendingBingoScore: typeof r.pendingBingoScore === "boolean"
      ? r.pendingBingoScore
      : Boolean(r.answers?.pendingBingoScore),
    quizSessionIndex: r.quizSessionIndex
  };
}

export class GatewayCore {
  private pb: PocketBase;
  private redis: Redis;
  private events: GatewayEvents;
  private players = new Map<string, Player>();
  private games = new Map<string, Game>();
  private results = new Map<string, ResultLite & { id: string }>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastPushAt = 0;
  private pendingRecompute = false;
  private lastPayload: Record<string, string> = {};
  private snapshots: { ranking: RankingSnapshot | null; games: GamesSnapshot | null } = { ranking: null, games: null };
  private lastBingoScored = false;

  constructor(opts: { pbUrl: string; redisUrl: string; events: GatewayEvents }) {
    this.pb = new PocketBase(opts.pbUrl);
    this.pb.autoCancellation(false);
    this.redis = new Redis(opts.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.events = opts.events;
  }

  getSnapshot(key: "ranking" | "games") {
    return this.snapshots[key];
  }

  async start(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (err) {
      console.warn("[gateway] Redis 不可用,以内存模式继续:", (err as Error).message);
    }
    await this.loadAll();
    this.recompute(true);
    const subscribed = await this.subscribe();
    if (!subscribed) {
      console.warn("[gateway] realtime 订阅失败,降级为网关内部轮询", FALLBACK_POLL_MS, "ms");
      setInterval(() => {
        this.loadAll().then(() => this.scheduleRecompute()).catch((e) => console.error("[gateway] poll fail", e));
      }, FALLBACK_POLL_MS);
    }
  }

  private async loadAll(): Promise<void> {
    const [players, games, results] = await Promise.all([
      this.pb.collection("players").getFullList(),
      this.pb.collection("games").getFullList({ sort: "order" }),
      this.pb.collection("game_results").getFullList({ fields: "id,player,gameKey,pendingBingoScore,quizSessionIndex" })
    ]);
    this.players = new Map(players.map((r) => [r.id, mapPlayer(r)]));
    this.games = new Map(games.map((r) => [r.id, mapGame(r)]));
    this.results = new Map(results.map((r) => [r.id, mapResult(r)]));
    this.lastBingoScored = [...this.games.values()].some((g) => g.key === "bingo" && Boolean(g.bingoScored));
  }

  private async subscribe(): Promise<boolean> {
    try {
      await this.pb.collection("players").subscribe("*", (e) => {
        if (e.action === "delete") this.players.delete(e.record.id);
        else this.players.set(e.record.id, mapPlayer(e.record));
        this.scheduleRecompute();
      });
      await this.pb.collection("games").subscribe("*", (e) => {
        if (e.action === "delete") this.games.delete(e.record.id);
        else this.games.set(e.record.id, mapGame(e.record));
        const bingo = [...this.games.values()].find((g) => g.key === "bingo");
        const scoredNow = Boolean(bingo?.bingoScored);
        if (scoredNow && !this.lastBingoScored) this.events.onBingoScored();
        this.lastBingoScored = scoredNow;
        this.scheduleRecompute();
      });
      await this.pb.collection("game_results").subscribe("*", (e) => {
        if (e.action === "delete") {
          this.results.delete(e.record.id);
        } else {
          const mapped = mapResult(e.record);
          this.results.set(e.record.id, mapped);
          this.events.onPersonalResult(mapped.player, mapped.gameKey);
        }
        this.scheduleRecompute();
      });
      return true;
    } catch (err) {
      console.error("[gateway] subscribe error:", err);
      return false;
    }
  }

  private scheduleRecompute(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const now = Date.now();
      const wait = this.lastPushAt + MIN_PUSH_INTERVAL_MS - now;
      if (wait > 0) {
        if (!this.pendingRecompute) {
          this.pendingRecompute = true;
          setTimeout(() => {
            this.pendingRecompute = false;
            this.recompute(false);
          }, wait);
        }
        return;
      }
      this.recompute(false);
    }, DEBOUNCE_MS);
  }

  private recompute(force: boolean): void {
    const now = Date.now();
    const players = [...this.players.values()];
    const games = [...this.games.values()];
    const results = [...this.results.values()];

    const ranking = buildRankingSnapshot(players, now);
    const gamesSnap = buildGamesSnapshot(games, now);
    const admin = buildAdminSnapshot(players, results, now);
    const full = buildFullRanking(players);

    this.persist("snap:admin", JSON.stringify(admin));
    this.persist("snap:fullranking", JSON.stringify({ items: full, cachedAt: now }));

    for (const [key, snap] of [["ranking", ranking], ["games", gamesSnap]] as const) {
      const payload = comparablePayload(snap);
      if (!force && this.lastPayload[key] === payload) continue; // 内容未变不推送
      this.lastPayload[key] = payload;
      this.snapshots[key] = snap as any;
      this.persist(`snap:${key}`, JSON.stringify(snap));
      this.events.onSnapshot(key, snap);
      this.lastPushAt = now;
    }
  }

  private persist(key: string, value: string): void {
    if (this.redis.status !== "ready") return;
    this.redis.set(key, value).catch((e) => console.warn("[gateway] redis set fail", key, e.message));
  }
}
