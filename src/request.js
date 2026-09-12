import { AppError } from './errors.js';
import { parseRetryAfter, sleep } from './util.js';

export async function fetchWithRetry(url, options = {}, policy = {}) {
  const fetchImpl = policy.fetchImpl ?? fetch;
  const sleepImpl = policy.sleepImpl ?? sleep;
  const attempts = policy.attempts ?? 3;
  const timeoutMs = policy.timeoutMs ?? 15_000;
  const maxRetryDelayMs = policy.maxRetryDelayMs ?? 10_000;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await policy.beforeAttempt?.(attempt);
    try {
      const execute = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(url, { ...options, signal: controller.signal });
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          const retryable = [429, 500, 502, 503, 504].includes(response.status);
          const final = !retryable || attempt === attempts - 1 || (retryAfter !== null && retryAfter > maxRetryDelayMs);
          await policy.afterAttempt?.(response, { attempt, final });
          return response;
        } finally {
          clearTimeout(timer);
        }
      };
      const response = policy.attempt ? await policy.attempt(execute, attempt) : await execute();
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) return response;
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      if (retryAfter !== null && retryAfter > maxRetryDelayMs) return response;
      await sleepImpl(retryAfter ?? Math.min(500 * 2 ** attempt + Math.random() * 250, maxRetryDelayMs));
    } catch (error) {
      if (error instanceof AppError) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
      await sleepImpl(Math.min(500 * 2 ** attempt + Math.random() * 250, 4_000));
    }
  }

  throw new AppError('NETWORK_ERROR', lastError?.name === 'AbortError' ? 'The external request timed out.' : 'The external request failed.', {
    cause: lastError,
    retryable: true,
    service: policy.service,
  });
}

export async function responseJson(response, service) {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    throw new AppError(`${service}_INVALID_RESPONSE`, `${service} returned invalid JSON.`, {
      cause: error,
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      service: service.toLowerCase(),
    });
  }
}
