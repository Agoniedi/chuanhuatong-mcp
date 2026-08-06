import { apiRequest, setToken } from './client';
import type { RegisterResponse, User } from '../types';

export async function register(
  displayName: string,
  idempotencyKey: string,
): Promise<RegisterResponse> {
  const result = await apiRequest<RegisterResponse>(
    'POST',
    '/v1/auth/register',
    { displayName },
    { token: '', idempotencyKey },
  );
  setToken(result.token);
  return result;
}

export async function getMe(): Promise<User> {
  return apiRequest<User>('GET', '/v1/me');
}
