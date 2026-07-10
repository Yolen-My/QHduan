# 年会小游戏性能优化设计(500~1000 并发)

- 日期:2026-07-10
- 状态:已经用户评审认可(方案 A + 3 处修正)
- 目标并发:500~1000 名手机端玩家同时在线
- 部署约束:单台腾讯云 ECS(Nginx + PM2 + PocketBase 同机)

## 1. 背景与现状诊断

当前架构:浏览器直连 PocketBase(:8090,SQLite 单进程),Next.js 只负责出页面,中间没有服务端数据层。

几百人并发即卡死的根因是请求量 O(N²) 放大,而非单点慢查询:

1. **全量拉库**:`lib/pb-storage.ts` 的 `loadState()` 一次并发拉取 players、game_results、games、questions 四张全表。`isGameOpen`(只需 1 个布尔值)、`getGameResult`(只需 1 条记录)、`submitGameResult`(仅写前校验)全部调用它。
2. **轮询叠加**:每个页面 2~3 路独立轮询(1.5s~4s);Bingo 等待判分页每 1 秒调用一次 `getGameResult` → 全量拉库。
3. **订阅惊群**:每个 hook 实例都通配符订阅 players / game_results / games 三张表(`pb-storage.ts` `subscribeToState`),回调即再次全量拉库。1 人提交 → 2 个事件 × N 客户端 × 3~5 个回调,300 人时单次提交最多引发 3000 次全表读。
4. **Bingo 判分风暴**:`triggerBingoScore` 在浏览器端串行逐条 update(约 600 次写),每次写触发全员广播重拉,同时全场玩家 1 秒轮询等结果。
5. **带宽账**:轮询模式下 500 人 × 约 200KB 全表响应 / 2s ≈ 等效 400Mbps 下行需求,远超单机 ECS 公网带宽。
6. 已有优化只接入一半:`/api/ranking-data`(pb_hooks 内存缓存 TTL 2s)与大厅精确查询已上线;`use-game-data.optimized.ts`、`next.config.optimized.js` 未被任何页面引用。

## 2. 总体架构(方案 A:实时网关为数据主干)

```
                        ┌──────────────────────── 单台 ECS ────────────────────────┐
手机端/大屏  ──HTTPS──▶  Nginx :443
                          ├── /            ──▶ Next.js :3000 (PM2)   页面 + 个人读 API
                          ├── /ws          ──▶ realtime-gateway :8100 (PM2, 新增)
                          └── /pb/*        ──▶ PocketBase :8090      写操作(提交/注册)
                                                    ▲
                          Redis :6379 ◀── 快照缓存/pub-sub ──┐
                                                    │        │
                          realtime-gateway ── 全场唯一 realtime 订阅 ──┘
```

数据流向原则:

- **公共数据(排行榜、游戏开关状态)**:PocketBase 变化 → 网关重算快照 → 写 Redis → WS 推送全场。客户端零轮询、零 PocketBase 订阅。公共数据读放大系数 = 0(O(1))。
- **个人数据(我的成绩、大厅快照)**:走 Next.js API,服务端查 PB(索引精确查询)+ Redis 缓存。
- **写操作(注册、提交答案)**:保持直连 PocketBase(经 Nginx `/pb/` 代理),现有校验逻辑保留,仅做精确化改造。
- **PocketBase 是唯一数据源**;Redis 只存可重算的派生数据,Redis 宕机不丢数据。
- 客户端不再跨端口直连 `:8090`,统一经 Nginx 443 代理,消除 HTTPS 混合内容风险。

## 3. realtime-gateway(新增 Node 进程)

新目录 `gateway/`,Node + `ws` + `ioredis` + PocketBase JS SDK,约 300~400 行。

- **上游**:启动时全量拉一次三张表建立内存态;之后作为全场唯一订阅者订阅 PB realtime(players / game_results / games)。事件回调 300ms 防抖合并后增量更新内存态并重算快照。
- **快照**(复用 `lib/ranking.ts` 纯函数):
  - `snapshot:ranking`:top10、office 平均分、office Top3、参与人数(约 2~3KB)。**不含全量玩家列表**——现有 `/api/ranking-data` 返回全部玩家(1000 人约 200KB)是主要带宽来源,大屏的参与人数改用 count 字段,本人排名上下文改由 `/api/lobby` 基于 Redis 快照计算,广播体积与人数解耦。
  - `snapshot:games`:4 行游戏状态(isOpen / bingoPhase / quizOpenGroups / quizCurrentGroup)。
- **推送策略(修正 ①)**:
  - 节流:同一快照最快 1~2 秒推一次;
  - 内容哈希去重:快照序列化后哈希未变则不推;
  - 开启 `permessage-deflate`(约 3KB → 1KB);
  - 峰值下行 ≈ 1 次/秒 × 1000 连接 × 1KB ≈ 8Mbps,在 ECS 带宽预算内。
- **个人事件通道**:客户端连接后发送 `{type:"hello", playerId}`。属于该玩家的 game_results 变更(判分完成、成绩确认)定向推送,替代 Bingo 等待页的 1 秒轮询。
- **判分完成广播(修正 ②)**:Bingo 批量判分完成后只广播一条轻量 `bingo_scored` 事件(几十字节),客户端随机延迟 0~3 秒后拉取 `/api/lobby` 个人数据,把 1000 次精确查询摊平到 3 秒窗口。
- 心跳 ping/pong,30 秒无响应断开;连接数 1000 对单 Node 进程无压力。
- Redis 职责(修正 ③):快照缓存(网关重启秒级恢复)、网关 → Next 多 worker 的快照共享通道、题库缓存。任何路径不依赖 Redis 存活。

## 4. Next.js API 层 + Redis

新增 Route Handlers(服务端执行,浏览器不再直接读 PB):

| 接口 | 数据 | Redis 策略 |
|---|---|---|
| `GET /api/ranking` | 排行榜快照 | 直接读网关写入的 `snapshot:ranking`,不触库 |
| `GET /api/lobby/[playerId]` | 本人 + 本人成绩 + 名次 | 本人数据实时查 PB(索引精确查询);名次由 Redis 排行快照计算 |
| `GET /api/questions/[gameKey]` | 题库(按语言) | Redis TTL 60s;后台改题后手动失效或等待过期 |
| `POST /api/admin/bingo-score` 等 | 管理动作 | 校验管理 token 后转发到 pb_hooks 批量接口 |

这些接口同时是 WS 断线降级时的轮询目标(10 秒/次,命中 Redis,成本近零)。

## 5. 客户端改造(hooks 层重写)

- 新建 `RealtimeProvider`(React Context):每个页面全局仅 1 条 WS 连接,持有 ranking / games 快照与个人事件;断线指数退避重连,断线期间自动切 10 秒轮询 Next API。
- `useRanking` / `useGameStatus` / `useAppState`(公共部分):改为从 Context 读推送数据;删除全部 `setInterval` 轮询与 `subscribeToState` 通配订阅。
- `useCurrentPlayer` / `useLobbySnapshot`:事件驱动刷新(收到本人相关推送才拉 `/api/lobby`)+ 30 秒低频兜底。
- `useQuestions`:改走 `/api/questions`;失败重试由 600ms×3 连发改为指数退避。
- `visibilitychange` 页面隐藏时暂停一切兜底轮询。
- 删除 `use-game-data.optimized.ts` 与 `next.config.optimized.js` 双轨文件,避免与本方案并存。

## 6. 数据库 / PocketBase 查询优化

- **消灭 `loadState()` 全量拉库**:
  - `submitGameResult`:写前校验改为 2 个精确查询(按 key 查 games 单行;按 player+gameKey 复合索引查重),quiz 按 (player, gameKey, quizSessionIndex) 查重;
  - `getGameResult` / `isGameOpen` / `getQuizSessionSnapshot`:改精确查询;
  - `toggleGameOpen` / `openQuizGroup` / `closeQuizGroup` 等管理操作:直接 update 目标行,去掉前置 `loadState()`。
- **Bingo 判分服务端化**:pb_hooks 新增 `POST /api/bingo-score`(管理 token 校验),单事务批量完成:pending 判分 + 未提交玩家补空记录 + 全员 totalScore / completedGames / finalSubmitted 重算。浏览器端 `triggerBingoScore` 改为调用该接口。
- **索引**:保留现有 5 个索引;新增 `game_results(player, gameKey, quizSessionIndex)` 服务 quiz 分组查重。
- `checkPocketBase` 健康检查:由"每函数入口 + 5s 缓存"改为全局单例 30 秒。
- `resetDemoData` 的逐条删除循环迁移到服务端管理接口。

## 7. 降级与错误处理

| 故障 | 行为 |
|---|---|
| Redis 宕机 | 网关内存继续计算并推送;Next API 直查 PB。功能无损 |
| 网关宕机 | 客户端 WS 断连,自动切 10 秒轮询 Next API;PM2 自动拉起 |
| 单客户端 WS 断连 | 该客户端独立降级轮询,不影响他人 |
| PocketBase 宕机 | 写操作报错提示重试;读展示最后一份快照(优于现状白屏) |

## 8. 测试与验收

- 现有 `npm test`(scoring / business / integration)全部保持通过。
- 快照计算纯函数补充单元测试。
- 网关集成测试:模拟 PB 事件流,断言防抖合并、哈希去重、推送内容。
- 活动前 k6 压测:1000 WS 连接 + 每秒 50 次提交混合场景。
- **验收标准**:提交 P95 < 1s;排行榜推送延迟 < 2s;PocketBase CPU < 50%;公网下行 < 15Mbps。

## 9. 实施顺序

1. **阶段一(纯止血,不依赖新进程)**:第 6 节精确查询改造 + Bingo 服务端判分。即使后续阶段延期,单独上线也能支撑 500 人。
2. **阶段二**:安装 Redis(仅监听 127.0.0.1)、实现 gateway、Next API 层、Nginx 增加 `/ws` upgrade 与 `/pb/` 代理。
3. **阶段三**:客户端 hooks 切换到 RealtimeProvider,删除轮询/通配订阅,k6 压测验收。

环境变量新增:`REDIS_URL`、`NEXT_PUBLIC_WS_URL`、`ADMIN_API_TOKEN`。PM2 新增 `realtime-gateway` 应用。

## 10. 容量核算(1000 人在线)

| 资源 | 预估 | 上限参考 | 余量 |
|---|---|---|---|
| PocketBase 读 | < 20 QPS(个人精确查询) | SQLite 读数千 QPS | >100× |
| PocketBase 写 | 峰值 ~100 QPS(集中提交) | WAL 模式数千 TPS | >10× |
| WS 下行带宽 | 峰值 ~8Mbps(节流+压缩后) | ECS 带宽套餐 | 视套餐,建议 ≥20Mbps |
| 网关 CPU | 单核 ~10%(排序 O(N log N),N=1000) | 单核 | ~10× |
| WS 并发连接 | 1000 | 单 Node 进程数万 | >10× |

剩余瓶颈上限在 SQLite 写吞吐,距触及尚有 10 倍以上余量。
