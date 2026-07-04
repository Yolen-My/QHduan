/// <reference path="../pb_data/types.d.ts" />

// 排行榜聚合数据：服务端内存缓存（TTL=2s）。
// 关键点：
// 1) PocketBase JSVM 路由处理器无法访问文件级变量，状态放进 app.store()
//    （并发安全的进程内 KV，跨请求共享）。
// 2) 缓存「已序列化好的响应体字符串」+ 时间戳（两个原始值，跨 executor 稳定）。
//    命中时用 e.blob 直接回写字符串，完全跳过 JSON.parse / 再序列化——
//    否则每个请求都对 ~1500 名玩家做一次解析+序列化，500 并发下 goja CPU 会成为新瓶颈。
// 收益：高并发下同一时间窗内只触发 1 次全表读+1 次序列化，其余请求近乎零成本命中。
routerAdd("GET", "/api/ranking-data", (e) => {
  try {
    const TTL_MS = 2000;
    const store = e.app.store();
    const now = Date.now();

    const at = store.get("rankingDataAt");
    const body = store.get("rankingDataBody");
    if (at && body && now - at <= TTL_MS) {
      return e.blob(200, "application/json", body);
    }

    const players = e.app.findRecordsByFilter("players", "id != ''", "-totalScore", 100000, 0);
    const mapped = [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      // 仅输出排行榜计算/展示所需字段（comparePlayers 用 totalScore + 完成时间；分组用 office）。
      mapped.push({
        id: p.id,
        name: p.getString("name"),
        office: p.getString("office"),
        team: p.getString("team"),
        totalScore: p.getFloat("totalScore"),
        finalSubmitted: p.getBool("finalSubmitted"),
        finalCompletedAt: p.getString("finalCompletedAt"),
        created: p.getDateTime("created").string(),
        updated: p.getDateTime("updated").string()
      });
    }

    const newBody = JSON.stringify({ players: mapped, cachedAt: now });
    store.set("rankingDataAt", now);
    store.set("rankingDataBody", newBody);
    return e.blob(200, "application/json", newBody);
  } catch (err) {
    return e.json(500, { err: String(err && err.message ? err.message : err) });
  }
});
