import { WebSocketServer, WebSocket } from "ws";
import { GatewayCore } from "./core.ts";

const PORT = Number(process.env.GATEWAY_PORT || 8100);
const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const HEARTBEAT_MS = 30000;

type ClientMeta = { playerId: string | null; alive: boolean };
const clients = new Map<WebSocket, ClientMeta>();

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

const core = new GatewayCore({
  pbUrl: PB_URL,
  redisUrl: REDIS_URL,
  events: {
    onSnapshot: (key, data) => broadcast({ type: "snapshot", key, data }),
    onPersonalResult: (playerId, gameKey) => {
      for (const [ws, meta] of clients) {
        if (meta.playerId === playerId) send(ws, { type: "event", name: "result_update", gameKey });
      }
    },
    onBingoScored: () => broadcast({ type: "event", name: "bingo_scored" })
  }
});

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: true });

wss.on("connection", (ws) => {
  clients.set(ws, { playerId: null, alive: true });

  const ranking = core.getSnapshot("ranking");
  const games = core.getSnapshot("games");
  if (ranking) send(ws, { type: "snapshot", key: "ranking", data: ranking });
  if (games) send(ws, { type: "snapshot", key: "games", data: games });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.type === "hello") {
        const meta = clients.get(ws);
        if (meta) meta.playerId = typeof msg.playerId === "string" ? msg.playerId : null;
      }
    } catch {}
  });

  ws.on("pong", () => {
    const meta = clients.get(ws);
    if (meta) meta.alive = true;
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

setInterval(() => {
  for (const [ws, meta] of clients) {
    if (!meta.alive) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    meta.alive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

core.start()
  .then(() => console.log(`[gateway] listening ws://0.0.0.0:${PORT}, pb=${PB_URL}`))
  .catch((err) => {
    console.error("[gateway] start failed:", err);
    process.exit(1);
  });
