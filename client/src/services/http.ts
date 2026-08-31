import { clearCurrentUser } from '../composables/auth';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;

  constructor(message: string, options: {
    status: number;
    code?: string;
    retryAfterSeconds?: number | null;
  }) {
    super(message);
    this.name = 'HttpError';
    this.status = options.status;
    this.code = options.code || 'REQUEST_FAILED';
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.retryable = options.status === 503;
  }
}

let unauthorizedHandler: (() => void | Promise<void>) | null = null;
let redirectingToLogin = false;

export function setUnauthorizedHandler(handler: (() => void | Promise<void>) | null) {
  unauthorizedHandler = handler;
}

export async function handleUnauthorized() {
  clearCurrentUser();
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  try {
    await unauthorizedHandler?.();
  } finally {
    redirectingToLogin = false;
  }
}

export async function readErrorMessage(response: Response) {
  const text = await response.text().catch(() => '');
  if (!text) return '请求失败';
  try {
    const body = JSON.parse(text) as { message?: string };
    return body.message || text;
  } catch {
    return text;
  }
}

export function isQueryUnavailable(error: unknown) {
  return error instanceof HttpError && error.status === 503 &&
    ['QUERY_OVERLOADED', 'QUERY_TIMEOUT', 'QUERY_QUEUE_TIMEOUT'].includes(error.code);
}

export async function requestResponse(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    if (response.status === 401) {
      await handleUnauthorized();
    }
    const text = await response.text().catch(() => '');
    let body: { message?: string; code?: string } = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    throw new HttpError(body.message || text || '请求失败', {
      status: response.status,
      code: body.code,
      retryAfterSeconds: Number(response.headers.get('retry-after')) || null,
    });
  }
  return response;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await requestResponse(url, init);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function requestJsonWithRetry<T>(url: string, init?: RequestInit): Promise<T> {
  const method = String(init?.method || 'GET').toUpperCase();
  const canRetry = method === 'GET';
  try {
    return await requestJson<T>(url, init);
  } catch (error) {
    if (!canRetry || !isQueryUnavailable(error)) throw error;
    const retryAfter = error instanceof HttpError ? error.retryAfterSeconds : null;
    const delay = Math.max(300, Math.min((retryAfter || 0) * 1000, 800)) + Math.round(Math.random() * 200);
    await new Promise(resolve => window.setTimeout(resolve, delay));
    return requestJson<T>(url, init);
  }
}

export async function requestEmpty(url: string, init?: RequestInit): Promise<void> {
  await requestResponse(url, init);
}
