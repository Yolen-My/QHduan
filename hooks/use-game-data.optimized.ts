"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import type { AppState, GameKey, Player, Question } from "@/types";
import {
  getCurrentPlayer,
  getCurrentPlayerId,
  getGameResult,
  getInitialState,
  getLobbySnapshot,
  getQuestions,
  getRankingSnapshot,
  isGameOpen,
  loadState,
  registerPlayer,
  submitGameResult,
  toggleGameOpen,
  triggerBingoScore,
  closeBingoGame,
  advanceQuizGroup,
  openQuizGroup,
  closeQuizGroup,
  subscribeToState
} from "@/lib/storage";

// 根据环境动态设置轮询间隔
const getPollingInterval = () => {
  if (typeof window !== 'undefined') {
    const envInterval = (window as Window & { __NEXT_PUBLIC_POLLING_INTERVAL__?: string }).__NEXT_PUBLIC_POLLING_INTERVAL__;
    if (envInterval) return parseInt(envInterval, 10);
  }
  return process.env.NEXT_PUBLIC_POLLING_INTERVAL 
    ? parseInt(process.env.NEXT_PUBLIC_POLLING_INTERVAL, 10) 
    : 2000; // 生产环境默认2秒
};

const STATE_REFRESH_INTERVAL_MS = getPollingInterval();

// 请求缓存管理
const requestCache = new Map<string, {
  data: any;
  timestamp: number;
}>();

const CACHE_DURATION = 1000; // 缓存1秒

function getCachedRequest<T>(key: string): T | null {
  const cached = requestCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data as T;
  }
  return null;
}

function setCachedRequest<T>(key: string, data: T): void {
  requestCache.set(key, {
    data,
    timestamp: Date.now(),
  });
}

// 全局状态管理，减少重复请求
let globalState: AppState | null = null;
let globalStateLoading = false;
let globalStateSubscribers = new Set<() => void>();

async function getGlobalState(): Promise<AppState> {
  if (globalState && !globalStateLoading) {
    return globalState;
  }
  
  if (globalStateLoading) {
    // 等待正在进行的请求
    await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (!globalStateLoading) {
          clearInterval(checkInterval);
          resolve(null);
        }
      }, 50);
    });
    return globalState!;
  }
  
  globalStateLoading = true;
  try {
    globalState = await loadState();
    return globalState;
  } finally {
    globalStateLoading = false;
  }
}

export function useAppState() {
  const [state, setState] = useState<AppState>(getInitialState());
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    
    const cacheKey = 'app-state';
    const cached = getCachedRequest<AppState>(cacheKey);
    if (cached) {
      setState(cached);
      setLoading(false);
      return;
    }

    const newState = await getGlobalState();
    if (mountedRef.current) {
      setState(newState);
      setCachedRequest(cacheKey, newState);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeToState(() => {
      // 订阅更新时清除缓存
      requestCache.clear();
      refresh();
    });

    const timer = window.setInterval(() => {
      requestCache.clear(); // 定期清除缓存
      refresh();
    }, STATE_REFRESH_INTERVAL_MS);
    
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { state, refresh, loading };
}

export function useCurrentPlayer() {
  const [player, setPlayer] = useState<Player | null>(null);
  const [playerId, setPlayerId] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    
    try {
      const id = await getCurrentPlayerId();
      setPlayerId(id);
      if (!id) {
        setPlayer(null);
        setLoading(false);
        return;
      }
      
      const cacheKey = `player-${id}`;
      const cached = getCachedRequest<Player>(cacheKey);
      if (cached) {
        setPlayer(cached);
        setLoading(false);
        return;
      }
      
      const p = await getCurrentPlayer();
      if (mountedRef.current) {
        setPlayer(p);
        setCachedRequest(cacheKey, p);
        setLoading(false);
      }
    } catch {
      if (mountedRef.current) {
        setPlayer(null);
        setPlayerId(null);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeToState(() => {
      requestCache.clear();
      refresh();
    });

    const timer = window.setInterval(refresh, STATE_REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { player, playerId, refresh, loading };
}

export function useRegisterPlayer() {
  return registerPlayer;
}

export function useQuestions(gameKey: GameKey) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    
    const cacheKey = `questions-${gameKey}`;
    const cached = getCachedRequest<Question[]>(cacheKey);
    if (cached) {
      setQuestions(cached);
      setLoading(false);
      return;
    }
    
    const q = await getQuestions(gameKey);
    if (mountedRef.current) {
      setQuestions(q);
      setCachedRequest(cacheKey, q);
      setLoading(false);
    }
  }, [gameKey]);

  useEffect(() => {
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return questions;
}

export function useGameStatus(gameKey: GameKey) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    
    const cacheKey = `game-status-${gameKey}`;
    const cached = getCachedRequest<boolean>(cacheKey);
    if (cached !== null) {
      setOpen(cached);
      setLoading(false);
      return;
    }
    
    const isOpenVal = await isGameOpen(gameKey);
    if (mountedRef.current) {
      setOpen(isOpenVal);
      setCachedRequest(cacheKey, isOpenVal);
      setLoading(false);
    }
  }, [gameKey]);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeToState(() => {
      requestCache.clear();
      refresh();
    });

    const timer = window.setInterval(refresh, STATE_REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh]);

  return open;
}

export function useSubmitGameResult() {
  return submitGameResult;
}

export function useExistingResult(playerId: string | null | undefined, gameKey: GameKey) {
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    
    if (!playerId) {
      setExists(false);
      setLoading(false);
      return;
    }
    
    const cacheKey = `result-${playerId}-${gameKey}`;
    const cached = getCachedRequest<boolean>(cacheKey);
    if (cached !== null) {
      setExists(cached);
      setLoading(false);
      return;
    }
    
    const result = await getGameResult(playerId, gameKey);
    if (mountedRef.current) {
      setExists(Boolean(result));
      setCachedRequest(cacheKey, Boolean(result));
      setLoading(false);
    }
  }, [playerId, gameKey]);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeToState(() => {
      requestCache.clear();
      refresh();
    });

    const timer = window.setInterval(refresh, STATE_REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh]);

  return exists;
}

export function useLobbySnapshot(playerId: string | null | undefined) {
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof getLobbySnapshot>> | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    
    try {
      if (playerId) {
        const cacheKey = `lobby-${playerId}`;
        const cached = getCachedRequest<Awaited<ReturnType<typeof getLobbySnapshot>>>(cacheKey);
        if (cached) {
          setSnapshot(cached);
          setLoading(false);
          return;
        }
        
        const s = await getLobbySnapshot(playerId);
        if (mountedRef.current) {
          setSnapshot(s);
          setCachedRequest(cacheKey, s);
          setLoading(false);
        }
      } else {
        setSnapshot(null);
        setLoading(false);
      }
    } catch {
      if (mountedRef.current) {
        setSnapshot(null);
        setLoading(false);
      }
    }
  }, [playerId]);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeToState(() => {
      requestCache.clear();
      refresh();
    });
    const timer = window.setInterval(refresh, STATE_REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { snapshot, refresh, loading };
}

function getEmptyRankingSnapshot(): Awaited<ReturnType<typeof getRankingSnapshot>> {
  return {
    players: [],
    games: [],
    results: [],
    top10: [],
    officeAverage: [],
    officeTop3: [],
    context: null
  };
}

export function useRanking(playerId?: string | null, intervalMs?: number) {
  const [ranking, setRanking] = useState<Awaited<ReturnType<typeof getRankingSnapshot>>>(() => getEmptyRankingSnapshot());
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    
    try {
      const cacheKey = `ranking-${playerId || 'all'}`;
      const cached = getCachedRequest<Awaited<ReturnType<typeof getRankingSnapshot>>>(cacheKey);
      if (cached) {
        setRanking(cached);
        setLoading(false);
        return;
      }
      
      const r = await getRankingSnapshot(playerId);
      if (mountedRef.current) {
        setRanking(r);
        setCachedRequest(cacheKey, r);
        setLoading(false);
      }
    } catch (error) {
      console.error("❌ useRanking 加载数据库排行榜失败:", error);
      if (mountedRef.current) {
        setRanking(getEmptyRankingSnapshot());
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [playerId]);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeToState(() => {
      requestCache.clear();
      refresh();
    });

    const timer = window.setInterval(refresh, intervalMs || STATE_REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { ranking, refresh, loading };
}

export function useAdminActions() {
  return { toggleGameOpen, triggerBingoScore, closeBingoGame, advanceQuizGroup, openQuizGroup, closeQuizGroup };
}

// 在客户端设置环境变量
if (typeof window !== 'undefined') {
  (window as Window & { __NEXT_PUBLIC_POLLING_INTERVAL__?: string }).__NEXT_PUBLIC_POLLING_INTERVAL__ = process.env.NEXT_PUBLIC_POLLING_INTERVAL || '2000';
}
