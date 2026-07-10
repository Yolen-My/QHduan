import crypto from "crypto";

// 无状态管理员会话：cookie 值由 ADMIN_PASSWORD + ADMIN_API_TOKEN 派生的 sha256。
// 这样任意 PM2 worker 都能独立校验，无需共享 session store。

const ADMIN_COOKIE_NAME = "admin_session";

/**
 * 计算当前管理员会话 cookie 应有的值。
 * 依赖 ADMIN_PASSWORD 与 ADMIN_API_TOKEN 两个服务端密钥。
 */
export function getAdminSessionValue(): string {
  return crypto
    .createHash("sha256")
    .update(`${process.env.ADMIN_PASSWORD}:${process.env.ADMIN_API_TOKEN}`)
    .digest("hex");
}

/**
 * 校验请求携带的 admin_session cookie 是否有效。
 * 使用 timingSafeEqual 做恒定时间比较，避免旁路攻击。
 */
export function verifyAdminCookie(request: Request): boolean {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return false;

  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE_NAME}=`));
  if (!match) return false;

  const provided = match.slice(`${ADMIN_COOKIE_NAME}=`.length);
  const expected = getAdminSessionValue();

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // 长度不等时 timingSafeEqual 会抛错，先挡掉（本身也代表不匹配）。
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export { ADMIN_COOKIE_NAME };
