import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const globalForRedis = globalThis as unknown as { __redis?: Redis };

export function getRedis(): Redis {
  if (!globalForRedis.__redis) {
    globalForRedis.__redis = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });
    globalForRedis.__redis.on("error", (e) => console.warn("[redis]", e.message));
  }
  return globalForRedis.__redis;
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // Redis 不可用时上层走 PB 回退
  }
}
