const TOKEN_KEY = 'chuanhuatong_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { token?: string; idempotencyKey?: string; operationId?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = options?.token ?? getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options?.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }
  if (options?.operationId) {
    headers['Operation-Id'] = options.operationId;
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      data?.error?.code ?? 'unknown',
      data?.error?.message ?? response.statusText,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
