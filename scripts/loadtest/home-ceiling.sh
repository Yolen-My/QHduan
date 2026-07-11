#!/bin/bash
# 家庭带宽 WS 并发上限自测(断开 VPN 后运行)
# 逐档加压,看哪一档 ws101 成功率跌破 99% 或 ws_connecting p95 超过 ~3s
set -e
IP=111.229.215.123
HOST=qhduan.superzou.vip
DIR="$(cd "$(dirname "$0")" && pwd)"
STEPS=(${STEPS:-100 200 400 600 800 1000})

echo "目标: wss://$HOST/ws  (pinned -> $IP)"
echo "请确认已断开 VPN/代理。开始逐档探测..."
echo

for v in "${STEPS[@]}"; do
  echo "================ 并发 WS = $v ================"
  docker run --rm -i --add-host "$HOST:$IP" -v "$DIR:/scripts" grafana/k6 run \
    -e WS="wss://$HOST/ws" -e VUS="$v" /scripts/ceiling.js 2>&1 \
    | grep -E "checks_succeeded|ws101|收到快照|ws_connecting|dropped"
  echo
done
echo "完成。判读: 最后一个 ws101=100% 且 ws_connecting p95 < ~2s 的档位, 就是你家庭出口的干净上限。"
