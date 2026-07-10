"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "@/components/RealtimeProvider";
import type { AppState, Game, GameKey, GameResult, Player, Question, QuizProgress } from "@/types";
import {
  getCurrentPlayerId,
  registerPlayer,
  submitGameResult,
  toggleGameOpen,
  triggerBingoScore,
  closeBingoGame,
  advanceQuizGroup,
  openQuizGroup,
  closeQuizGroup
} from "@/lib/storage";
import { getStoredLocale } from "@/lib/i18n";

const PERSONAL_FALLBACK_MS = 30000; // 个人数据兜底刷新(事件驱动为主)
const EVENT_JITTER_MS = 3000;       // 收到事件后错峰拉取,削平判分尖峰

type LobbyData = {
  player: Player | null;
  rank: number;
  results: GameResult[];
  quizProgress: QuizProgress | null;
  games: Game[];
};

async function fetchLobby(playerId: string): Promise<LobbyData | null> {
  try {
    const res = await fetch(`/api/lobby/${playerId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 个人数据共享缓存:同页多个 hook 复用一次请求
let lobbyCache: { playerId: string; at: number; data: LobbyData | null; inflight: Promise<LobbyData | null> | null } =
  { playerId: "", at: 0, data: null, inflight: null };

async function getLobbyShared(playerId: string, maxAgeMs: number): Promise<LobbyData | null> {
  const now = Date.now();
  if (lobbyCache.playerId === playerId && now - lobbyCache.at < maxAgeMs && lobbyCache.data) return lobbyCache.data;
  if (lobbyCache.playerId === playerId && lobbyCache.inflight) return lobbyCache.inflight;
  const inflight = fetchLobby(playerId).then((data) => {
    lobbyCache = { playerId, at: Date.now(), data, inflight: null };
    return data;
  });
  lobbyCache = { ...lobbyCache, playerId, inflight };
  return inflight;
}

function usePersonalData(playerId: string | null | undefined) {
  const { subscribePersonal, connected } = useRealtime();
  const [data, setData] = useState<LobbyData | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (maxAgeMs = 0) => {
    if (!playerId) {
      setData(null);
      setLoading(false);
      return;
    }
    const d = await getLobbyShared(playerId, maxAgeMs);
    // 控制器决定 1:请求瞬断(/api/lobby 会把 PB 瞬时故障回 404)时保留旧数据,
    // 仅在拿到有效数据、或首次/playerId 变化时才允许写入(含 null)。
    if (d !== null) {
      setData(d);
    } else {
      setData((prev) => (prev === null ? null : prev));
    }
    setLoading(false);
  }, [playerId]);

  useEffect(() => {
    // playerId 变化(或首次加载):允许清空,先 setData(null) 再拉取。
    setData(null);
    setLoading(true);
    refresh(1000);
    // 个人事件 → 错峰刷新;maxAge=2000 使 jitter 窗口内多个 hook 实例命中
    // getLobbyShared 的共享缓存/inflight,判分风暴下去重为每客户端 1 次请求
    const unsub = subscribePersonal(() => {
      window.setTimeout(() => refresh(2000), Math.random() * EVENT_JITTER_MS);
    });
    // 低频兜底(断线/漏事件保护)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refresh(5000);
    }, PERSONAL_FALLBACK_MS);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, [refresh, subscribePersonal, connected]);

  return { data, refresh, loading };
}

export function useCurrentPlayer() {
  const [playerId, setPlayerId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    getCurrentPlayerId().then(setPlayerId);
  }, []);
  const { data, refresh, loading } = usePersonalData(playerId);
  return { player: data?.player ?? null, playerId, refresh, loading: playerId === undefined || loading };
}

export function useLobbySnapshot(playerId: string | null | undefined) {
  const { data, refresh, loading } = usePersonalData(playerId);
  const snapshot = useMemo(() => (data ? {
    player: data.player,
    rank: data.rank,
    results: data.results,
    quizProgress: data.quizProgress,
    games: data.games,
    state: { players: data.player ? [data.player] : [], gameResults: data.results, games: data.games, questions: [] as Question[] }
  } : null), [data]);
  return { snapshot, refresh, loading };
}

export function useAppState() {
  const { games } = useRealtime();
  const [playerId, setPlayerId] = useState<string | null>(null);
  useEffect(() => {
    getCurrentPlayerId().then((id) => setPlayerId(id));
  }, []);
  const { data, refresh, loading } = usePersonalData(playerId);
  const state: AppState = useMemo(() => ({
    games: games ?? data?.games ?? [],
    players: data?.player ? [data.player] : [],
    gameResults: data?.results ?? [],
    questions: []
  }), [games, data]);
  return { state, refresh: () => refresh(0), loading: loading && !games };
}

export function useGameStatus(gameKey: GameKey) {
  const { games } = useRealtime();
  if (!games) return null;
  return Boolean(games.find((game) => game.key === gameKey)?.isOpen);
}

export function useExistingResult(playerId: string | null | undefined, gameKey: GameKey) {
  const { data } = usePersonalData(playerId);
  return Boolean(data?.results.some((r) => r.gameKey === gameKey && !r.pendingBingoScore));
}

export type QuestionsState = Question[] & {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

async function fetchQuestions(gameKey: string): Promise<Question[]> {
  const lang = getStoredLocale();
  const res = await fetch(`/api/questions/${gameKey}?lang=${lang}`);
  if (!res.ok) throw new Error(`题库加载失败(${res.status})`);
  const data = await res.json();
  return data.questions || [];
}

export function useQuestions(gameKey: GameKey): QuestionsState {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef(0);
  // 控制器决定 2:退避重试定时器存句柄,卸载时清理防泄漏。
  const retryTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const q = await fetchQuestions(gameKey);
      if (q.length === 0) throw new Error(`${gameKey} 题库为空`);
      if (disposedRef.current) return;
      setQuestions(q);
      setError(null);
      attemptRef.current = 0;
    } catch (err) {
      if (disposedRef.current) return;
      setQuestions([]);
      setError(err instanceof Error ? err.message : "题库加载失败");
      // 指数退避重试:1.2s, 2.4s, 4.8s ... 封顶 30s
      const delay = Math.min(30000, 1200 * 2 ** attemptRef.current);
      attemptRef.current += 1;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => refresh(), delay);
    } finally {
      if (!disposedRef.current) setLoading(false);
    }
  }, [gameKey]);

  useEffect(() => {
    disposedRef.current = false;
    refresh();
    return () => {
      disposedRef.current = true;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [refresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("annual-game-locale-change", refresh);
    return () => window.removeEventListener("annual-game-locale-change", refresh);
  }, [refresh]);

  return Object.assign([...questions], { loading, error, refresh });
}

export function useAllQuestions() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetchQuestions("all")
      .then(setQuestions)
      .catch(() => setQuestions([]))
      .finally(() => setLoading(false));
  }, []);
  return { questions, loading };
}

export function useRanking(playerId?: string | null) {
  const { ranking, games } = useRealtime();
  const [context, setContext] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const cachedAtRef = useRef(0);

  // 排行快照更新 → 错峰刷新个人 context(仅传了 playerId 的页面)
  useEffect(() => {
    if (!ranking) return;
    setLoading(false);
    if (!playerId) return;
    if (ranking.cachedAt === cachedAtRef.current) return;
    cachedAtRef.current = ranking.cachedAt;
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/state?playerId=${playerId}`);
        const data = await res.json();
        setContext(data.context);
      } catch {}
    }, Math.random() * 2000);
    return () => window.clearTimeout(timer);
  }, [ranking, playerId]);

  const value = useMemo(() => ({
    players: [] as Player[],
    games: games ?? [],
    results: [] as GameResult[],
    top10: ranking?.top10 ?? [],
    officeAverage: ranking?.officeAverage ?? [],
    officeTop3: ranking?.officeTop3 ?? [],
    participantCount: ranking?.participantCount ?? 0,
    context
  }), [ranking, games, context]);

  return { ranking: value, refresh: async () => {}, loading };
}

export type AdminStats = {
  resultCounts: Record<string, number>;
  quizSectorCounts: number[];
  pendingBingo: number;
  participantCount: number;
  cachedAt: number;
};

export function useAdminStats() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/admin/stats");
        if (res.ok && !disposed) setStats(await res.json());
      } catch {} finally {
        if (!disposed) setLoading(false);
      }
    };
    poll();
    const timer = window.setInterval(poll, 2000); // 后台单客户端,轮询成本可忽略
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
  return { stats, loading };
}

export function useRegisterPlayer() {
  return registerPlayer;
}

export function useSubmitGameResult() {
  return submitGameResult;
}

export function useAdminActions() {
  return { toggleGameOpen, triggerBingoScore, closeBingoGame, advanceQuizGroup, openQuizGroup, closeQuizGroup };
}
