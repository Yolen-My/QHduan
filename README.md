# Annual Game App

年会互动游戏系统 DEMO，面向现场扫码参与、手机端答题、大屏排行和简易现场控制。

## 技术栈

- Next.js App Router
- React
- TypeScript
- Tailwind CSS 配置
- PocketBase SDK
- 本地 DEMO 数据层：`localStorage`

## 本地启动

```bash
npm install
npm run dev -- --hostname 127.0.0.1 --port 3000
```

访问：

- 手机端入口：`http://127.0.0.1:3000`
- 大厅：`/lobby`
- 大屏：`/screen`
- 简易后台：`/admin-control`

## 验证

```bash
npm test
npm run build
```

## PocketBase 启动

```bash
pocketbase serve --http=127.0.0.1:8090
```

环境变量：

```env
NEXT_PUBLIC_POCKETBASE_URL=http://localhost:8090
NEXT_PUBLIC_APP_NAME=Annual Game
```

当前 DEMO 默认使用 `localStorage` 保证无后端也能完整演示。接入 PocketBase 时，保留页面和评分逻辑，把 `lib/storage.ts` 中的数据读写替换为 PocketBase SDK 调用即可。

## PocketBase Collections

### players

- `name` text required
- `phone` text required unique
- `office` text required
- `team` text required
- `totalScore` number default 0
- `completedGames` json
- `finalSubmitted` bool default false
- indexes: `unique(phone)`, `index(office)`, `index(totalScore)`

### games

- `key` text required: `bingo | quiz | story | elimination`
- `name` text required
- `maxScore` number required
- `isOpen` bool required
- `order` number required

### questions

- `gameKey` text required
- `type` text required: `word | single | boolean | story`
- `title` text required
- `options` json
- `correctAnswer` json/text required
- `score` number required
- `order` number required
- `isActive` bool required

### game_results

- `player` relation(players) required
- `gameKey` text required
- `answers` json required
- `score` number required
- `maxScore` number required
- `completedAt` date required
- unique rule: one `player + gameKey` only once

### game_status

- `gameKey` text required
- `isOpen` bool required
- `message` text
- `updatedAt` date required

## 功能闭环

1. `/register` 校验姓名、手机号、Office、Team。
2. 手机号唯一，重复手机号直接加载已有用户。
3. `/lobby` 展示用户信息、累计积分、排名、四个游戏状态。
4. 四个游戏自动判分，单关满分 100（守卫者之夜满分 200），总分满分 500。
5. 每个游戏提交前检查是否已完成，禁止重复提交。
6. `/result` 展示总分、个人排名、TOP10、地区平均分、地区 TOP3。
7. `/screen` 每 3 秒刷新现场大屏排行。
8. `/admin-control` 支持查看参与人数、每关完成人数、游戏开关和导出 JSON。

## 活动前检查

- ECS、域名、HTTPS 可访问。
- PocketBase Admin 可登录，强密码已设置。
- 四个游戏题目已配置并抽样验证。
- 手机扫码能打开首页并完成注册。
- 大屏 `/screen` 可打开并自动刷新。
- 测试用户可完成完整流程。
- 数据导出可用。
- `pb_data` 已备份。
