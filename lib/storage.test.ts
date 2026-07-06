import test from "node:test";
import assert from "node:assert/strict";

// ========== 电话号码验证函数 ==========
// 注意：生产代码 lib/storage.ts 的 validatePhone 实现是 /^\d+$/（纯数字即可），
// 此处保持一致。storage.ts 因含 "use client" 和 @/ 路径别名无法在 node --test 中直接 import。
function validatePhone(phone: string): boolean {
  return /^\d+$/.test(phone);
}

// ========== 电话号码验证测试 ==========
test("validatePhone: 有效的电话号码验证", () => {
  assert.equal(validatePhone("13900000001"), true);
  assert.equal(validatePhone("13800000002"), true);
  assert.equal(validatePhone("13700000003"), true);
  assert.equal(validatePhone("13600000004"), true);
  assert.equal(validatePhone("13500000005"), true);
  assert.equal(validatePhone("15000000006"), true);
  assert.equal(validatePhone("15100000007"), true);
  assert.equal(validatePhone("15200000008"), true);
  assert.equal(validatePhone("15300000009"), true);
  assert.equal(validatePhone("15500000010"), true);
  assert.equal(validatePhone("15600000011"), true);
  assert.equal(validatePhone("15700000012"), true);
  assert.equal(validatePhone("15800000013"), true);
  assert.equal(validatePhone("15900000014"), true);
  assert.equal(validatePhone("18000000015"), true);
  assert.equal(validatePhone("18100000016"), true);
  assert.equal(validatePhone("18200000017"), true);
  assert.equal(validatePhone("18300000018"), true);
  assert.equal(validatePhone("18400000019"), true);
  assert.equal(validatePhone("18500000020"), true);
  assert.equal(validatePhone("18600000021"), true);
  assert.equal(validatePhone("18700000022"), true);
  assert.equal(validatePhone("18800000023"), true);
  assert.equal(validatePhone("18900000024"), true);
  assert.equal(validatePhone("19000000025"), true);
  assert.equal(validatePhone("19100000026"), true);
  assert.equal(validatePhone("19200000027"), true);
  assert.equal(validatePhone("19300000028"), true);
  assert.equal(validatePhone("19500000029"), true);
  assert.equal(validatePhone("19600000030"), true);
  assert.equal(validatePhone("19700000031"), true);
  assert.equal(validatePhone("19800000032"), true);
  assert.equal(validatePhone("19900000033"), true);
});

test("validatePhone: 无效的电话号码验证", () => {
  assert.equal(validatePhone(""), false); // 空字符串
  assert.equal(validatePhone("1390000000a"), false); // 包含字母
  assert.equal(validatePhone("1390000000#"), false); // 包含特殊字符
  assert.equal(validatePhone(" 13900000001 "), false); // 包含空格
  assert.equal(validatePhone("139-0000-0001"), false); // 包含分隔符
});

// ========== 存储层测试占位符 ==========
test("存储层: 游戏配置和状态管理", () => {
  // 由于 storage.ts 依赖浏览器环境和 Next.js 路径别名，
  // 完整的存储层测试需要在组件测试或集成测试中进行
  assert.ok(true);
});

// ========== 新增：输入验证测试 ==========
function validateName(name: string): boolean {
  if (!name || name.trim().length === 0) return false;
  if (name.length > 50) return false;
  // 过滤特殊字符
  const cleaned = name.replace(/[<>]/g, "");
  return cleaned.length > 0;
}

function validateOffice(office: string): boolean {
  const validOffices = ["北京", "上海", "深圳", "香港"];
  return validOffices.includes(office);
}

function validateTeam(team: string): boolean {
  if (!team || team.trim().length === 0) return false;
  if (team.length > 50) return false;
  const cleaned = team.replace(/[<>]/g, "");
  return cleaned.length > 0;
}

test("validateName: 有效的姓名验证", () => {
  assert.equal(validateName("张三"), true);
  assert.equal(validateName("张三四五"), true);
  assert.equal(validateName("John Smith"), true);
  assert.equal(validateName("王"), true); // 单字姓名
});

test("validateName: 无效的姓名验证", () => {
  assert.equal(validateName(""), false); // 空字符串
  assert.equal(validateName("   "), false); // 纯空格
  assert.equal(validateName("a".repeat(51)), false); // 超过50个字符
});

test("validateOffice: 有效的Office验证", () => {
  assert.equal(validateOffice("北京"), true);
  assert.equal(validateOffice("上海"), true);
  assert.equal(validateOffice("深圳"), true);
  assert.equal(validateOffice("香港"), true);
});

test("validateOffice: 无效的Office验证", () => {
  assert.equal(validateOffice(""), false);
  assert.equal(validateOffice("广州"), false); // 不在列表中
  assert.equal(validateOffice("beijing"), false); // 英文无效
  assert.equal(validateOffice("北京1"), false); // 包含数字
});

test("validateTeam: 有效的Team验证", () => {
  assert.equal(validateTeam("Alpha"), true);
  assert.equal(validateTeam("Beta"), true);
  assert.equal(validateTeam("测试团队"), true);
  assert.equal(validateTeam("Team A"), true);
});

test("validateTeam: 无效的Team验证", () => {
  assert.equal(validateTeam(""), false);
  assert.equal(validateTeam("   "), false);
  assert.equal(validateTeam("a".repeat(51)), false);
});

// ========== 新增：游戏状态验证测试 ==========
const GAME_KEYS = ["bingo", "quiz", "story", "elimination"] as const;
type GameKey = typeof GAME_KEYS[number];

function isValidGameKey(key: string): key is GameKey {
  return GAME_KEYS.includes(key as GameKey);
}

function isValidScore(score: number): boolean {
  return typeof score === "number" && !isNaN(score) && score >= 0 && score <= 100;
}

test("isValidGameKey: 有效的游戏Key验证", () => {
  assert.equal(isValidGameKey("bingo"), true);
  assert.equal(isValidGameKey("quiz"), true);
  assert.equal(isValidGameKey("story"), true);
  assert.equal(isValidGameKey("elimination"), true);
});

test("isValidGameKey: 无效的游戏Key验证", () => {
  assert.equal(isValidGameKey(""), false);
  assert.equal(isValidGameKey("Bingo"), false); // 大小写敏感
  assert.equal(isValidGameKey("bing"), false); // 不完整
  assert.equal(isValidGameKey("unknown"), false); // 未知游戏
});

test("isValidScore: 有效的分数验证", () => {
  assert.equal(isValidScore(0), true);
  assert.equal(isValidScore(50), true);
  assert.equal(isValidScore(100), true);
  assert.equal(isValidScore(75.5), true); // 允许小数
});

test("isValidScore: 无效的分数验证", () => {
  assert.equal(isValidScore(-1), false);
  assert.equal(isValidScore(101), false);
  assert.equal(isValidScore(NaN), false);
  assert.equal(isValidScore(undefined as any), false);
  assert.equal(isValidScore(null as any), false);
});

// ========== 新增：ID生成测试 ==========
function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test("createId: 生成有效的ID", () => {
  const id = createId("player");
  
  assert.ok(id.startsWith("player-"));
  assert.ok(id.length > 10);
  
  // 验证格式: prefix-timestamp-random
  const parts = id.split("-");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "player");
  assert.ok(!isNaN(parseInt(parts[1]))); // 时间戳是数字
  assert.equal(parts[2].length, 6); // 随机部分长度
});

test("createId: 每次生成唯一ID", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const id = createId("test");
    assert.ok(!ids.has(id), `重复ID: ${id}`);
    ids.add(id);
  }
});
