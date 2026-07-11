/// <reference path="../pb_data/types.d.ts" />

// 【已禁用】/api/ranking-data 是 perfect-version 旧架构的遗留聚合接口。
// 现架构下排行榜完全走 realtime-gateway + Redis 快照,前端与网关均不调用此端点
// (代码库 grep 零引用)。旧实现每 2s 对全体玩家做一次全表扫描+序列化,
// 在被直接高并发打时会成为无谓瓶颈,且对外多暴露一个可被打的读接口。
// 因此改为直接返回 410 Gone,消除全表扫描与暴露面。若将来需要应急数据源,
// 请走 GET /api/state(Next.js API,读 Redis 快照)。
routerAdd("GET", "/api/ranking-data", (e) => {
  return e.json(410, { error: "gone", message: "已废弃,请使用 /api/state(Redis 快照)" });
});
