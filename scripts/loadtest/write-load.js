import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";

const PB = __ENV.PB || "http://127.0.0.1:8091";
const N = Number(__ENV.N || 1000);   // 造多少玩家
const VUS = Number(__ENV.VUS || 50); // 并发写连接

export const options = {
  scenarios: {
    seed: {
      executor: "shared-iterations",
      exec: "seedOne",
      vus: VUS,
      iterations: N,
      maxDuration: "5m"
    }
  },
  thresholds: {
    http_req_duration: ["p(95)<1000"],
    checks: ["rate>0.99"]
  }
};

const OFFICES = ["北京", "上海", "深圳", "香港"];

export function seedOne() {
  const i = exec.scenario.iterationInTest;      // 全局唯一序号
  const phone = "199" + String(10000000 + i);   // 唯一手机号
  // 1) 注册玩家(写 players)
  const pRes = http.post(`${PB}/api/collections/players/records`, JSON.stringify({
    name: "LT" + i, phone, office: OFFICES[i % 4], team: "Alpha",
    totalScore: 0, completedGames: [], finalSubmitted: false
  }), { headers: { "Content-Type": "application/json" }, tags: { op: "register" } });
  const ok1 = check(pRes, { "register 200": (r) => r.status === 200 });
  if (!ok1) return;
  const playerId = pRes.json("id");
  // 2) 提交 pending bingo(写 game_results)
  const gRes = http.post(`${PB}/api/collections/game_results/records`, JSON.stringify({
    player: playerId, gameKey: "bingo",
    answers: JSON.stringify({ selectedWords: ["a", "b", "c"] }),
    score: 0, maxScore: 100, completedAt: new Date().toISOString(), pendingBingoScore: true
  }), { headers: { "Content-Type": "application/json" }, tags: { op: "submit" } });
  check(gRes, { "submit 200": (r) => r.status === 200 });
}
