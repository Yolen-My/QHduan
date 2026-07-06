import { ClientResponseError } from "pocketbase";

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { retries?: number; baseDelayMs?: number }
): Promise<T> {
  const retries = options?.retries ?? 2;
  const baseDelayMs = options?.baseDelayMs ?? 250;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === retries) throw error;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ClientResponseError) {
    // 0=网络/超时/被取消，408/429=限流，5xx=服务端瞬时故障——值得重试。
    // 4xx 里的其它状态码（比如唯一索引冲突的400）是业务错误，不重试。
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return false;
}
