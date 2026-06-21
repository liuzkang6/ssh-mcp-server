/**
 * API 客户端:自动带 Authorization header,401 自动跳登录。
 */

const TOKEN_KEY = "ssh-mcp-token";
const API_BASE_KEY = "ssh-mcp-api-base";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getApiBase(): string {
  return localStorage.getItem(API_BASE_KEY) || "";
}

export function setApiBase(base: string) {
  localStorage.setItem(API_BASE_KEY, base);
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const base = getApiBase();
  const url = `${base}${path}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    setToken(null);
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new ApiError("UNAUTHORIZED", "Not authenticated", 401);
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const errData = data as { code?: string; message?: string } | null;
    throw new ApiError(
      errData?.code || "ERROR",
      errData?.message || `HTTP ${res.status}`,
      res.status,
    );
  }
  return data as T;
}

export const api = {
  get: <T = unknown>(path: string) => apiRequest<T>("GET", path),
  post: <T = unknown>(path: string, body?: unknown) => apiRequest<T>("POST", path, body),
  put: <T = unknown>(path: string, body?: unknown) => apiRequest<T>("PUT", path, body),
  delete: <T = unknown>(path: string) => apiRequest<T>("DELETE", path),
};
