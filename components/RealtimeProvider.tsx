"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { PLAYER_ID_KEY } from "@/lib/constants";
import type { Game, OfficeAverageItem, OfficeTop3Group, RankingItem } from "@/types";

export type RankingSnapshot = {
  top10: RankingItem[];
  officeAverage: OfficeAverageItem[];
  officeTop3: OfficeTop3Group[];
  participantCount: number;
  cachedAt: number;
};

type PersonalListener = (name: string, gameKey?: string) => void;

type RealtimeContextValue = {
  connected: boolean;
  ranking: RankingSnapshot | null;
  games: Game[] | null;
  lastPersonalEventAt: number;
  subscribePersonal: (cb: PersonalListener) => () => void;
};

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  ranking: null,
  games: null,
  lastPersonalEventAt: 0,
  subscribePersonal: () => () => {}
});

const FALLBACK_POLL_MS = 10000; // 仅断线时启用的兜底轮询
const MAX_BACKOFF_MS = 30000;

function getWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured && configured.startsWith("ws")) return configured;
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = configured || "/ws";
  // dev 环境网关在 8100 端口
  if (window.location.port === "3000") return `${proto}//${window.location.hostname}:8100`;
  return `${proto}//${window.location.host}${path}`;
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

export default function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [ranking, setRanking] = useState<RankingSnapshot | null>(null);
  const [games, setGames] = useState<Game[] | null>(null);
  const [lastPersonalEventAt, setLastPersonalEventAt] = useState(0);
  const listenersRef = useRef(new Set<PersonalListener>());
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const pollTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  const subscribePersonal = useCallback((cb: PersonalListener) => {
    listenersRef.current.add(cb);
    return () => listenersRef.current.delete(cb);
  }, []);

  const emitPersonal = useCallback((name: string, gameKey?: string) => {
    setLastPersonalEventAt(Date.now());
    listenersRef.current.forEach((cb) => cb(name, gameKey));
  }, []);

  const stopFallbackPoll = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startFallbackPoll = useCallback(() => {
    if (pollTimerRef.current !== null) return;
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/state");
        const data = await res.json();
        if (data.ranking) setRanking(data.ranking);
        if (data.games?.games) setGames(data.games.games);
      } catch {}
    };
    poll();
    pollTimerRef.current = window.setInterval(poll, FALLBACK_POLL_MS);
  }, []);

  useEffect(() => {
    disposedRef.current = false;

    const connect = () => {
      if (disposedRef.current) return;
      const url = getWsUrl();
      if (!url) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        stopFallbackPoll();
        backoffRef.current = 1000;
        const playerId = window.localStorage.getItem(PLAYER_ID_KEY);
        ws.send(JSON.stringify({ type: "hello", playerId }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "snapshot" && msg.key === "ranking") setRanking(msg.data);
          else if (msg.type === "snapshot" && msg.key === "games") setGames(msg.data.games);
          else if (msg.type === "event") emitPersonal(msg.name, msg.gameKey);
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (disposedRef.current) return;
        startFallbackPoll();
        const delay = backoffRef.current;
        backoffRef.current = Math.min(MAX_BACKOFF_MS, delay * 2);
        window.setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      disposedRef.current = true;
      stopFallbackPoll();
      wsRef.current?.close();
    };
  }, [emitPersonal, startFallbackPoll, stopFallbackPoll]);

  return (
    <RealtimeContext.Provider value={{ connected, ranking, games, lastPersonalEventAt, subscribePersonal }}>
      {children}
    </RealtimeContext.Provider>
  );
}
