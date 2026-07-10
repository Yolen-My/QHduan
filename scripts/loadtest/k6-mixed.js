import ws from "k6/ws";
import http from "k6/http";
import { check, sleep } from "k6";

// 用法:
//   k6 run -e BASE=https://<域名> -e WS=wss://<域名>/ws -e VUS=1000 scripts/loadtest/k6-mixed.js
const BASE = __ENV.BASE || "http://127.0.0.1:3000";
const WS_URL = __ENV.WS || "ws://127.0.0.1:8100";
const VUS = Number(__ENV.VUS || 200);

export const options = {
  scenarios: {
    ws_audience: {
      executor: "constant-vus",
      exec: "wsAudience",
      vus: Math.floor(VUS * 0.8),   // 80% 观众:长连 WS + 偶发个人拉取
      duration: "3m"
    },
    submitters: {
      executor: "constant-arrival-rate",
      exec: "submitFlow",
      rate: 50,                      // 每秒 50 次提交式读写(验收指标上限)
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: Math.floor(VUS * 0.2)
    }
  },
  thresholds: {
    http_req_duration: ["p(95)<1000"],   // 提交/个人读 P95 < 1s
    checks: ["rate>0.99"]
  }
};

export function wsAudience() {
  const res = ws.connect(WS_URL, {}, (socket) => {
    let gotSnapshot = false;
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", playerId: null })));
    socket.on("message", (msg) => {
      if (msg.indexOf("snapshot") >= 0) gotSnapshot = true;
    });
    socket.setTimeout(() => {
      check(gotSnapshot, { "收到快照": (v) => v });
      socket.close();
    }, 60000);
  });
  check(res, { "ws 101": (r) => r && r.status === 101 });
  sleep(1);
}

export function submitFlow() {
  // 压测环境专用只读混合:state + lobby(写路径压测需在演练库造玩家,见压测文档)
  const state = http.get(`${BASE}/api/state`);
  check(state, { "state 200": (r) => r.status === 200 });
  const q = http.get(`${BASE}/api/questions/quiz?lang=zh`);
  check(q, { "questions 200": (r) => r.status === 200 });
  sleep(0.1);
}
