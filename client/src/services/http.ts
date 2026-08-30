import { clearCurrentUser } from '../composables/auth';

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

export async function requestResponse(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    if (response.status === 401) {
      await handleUnauthorized();
    }
    throw new Error(await readErrorMessage(response));
  }
  return response;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await requestResponse(url, init);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function requestEmpty(url: string, init?: RequestInit): Promise<void> {
  await requestResponse(url, init);
}
