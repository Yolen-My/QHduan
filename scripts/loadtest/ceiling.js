import ws from "k6/ws";
import { check } from "k6";
const WS_URL = __ENV.WS || "wss://qhduan.superzou.vip/ws";
const VUS = Number(__ENV.VUS || 100);
export const options = {
  scenarios: {
    ws: { executor: "constant-vus", exec: "hold", vus: VUS, duration: "55s" }
  }
};
export function hold() {
  let got = false;
  const res = ws.connect(WS_URL, {}, (socket) => {
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", playerId: null })));
    socket.on("message", (m) => { if (m.indexOf("snapshot") >= 0) got = true; });
    socket.setTimeout(() => { check(got, { "收到快照": (v) => v }); socket.close(); }, 45000);
  });
  check(res, { "ws101": (r) => r && r.status === 101 });
}
