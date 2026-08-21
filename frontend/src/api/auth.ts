import { apiRequest } from './client';
import type { User } from '../types';

export function login(username: string, password: string): Promise<User> {
  return apiRequest('POST', '/v1/auth/login', { username, password });
}

export function registerWebAccount(input: {
  username: string;
  displayName: string;
  password: string;
  passwordConfirmation: string;
  bindingCode: string;
}): Promise<User> {
  return apiRequest('POST', '/v1/auth/register', input);
}

export function resetPassword(input: {
  username: string;
  newPassword: string;
  passwordConfirmation: string;
  resetCode: string;
}): Promise<void> {
  return apiRequest('POST', '/v1/auth/reset-password', input);
}

export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  passwordConfirmation: string;
}): Promise<void> {
  return apiRequest('POST', '/v1/auth/change-password', input);
}

export function logout(): Promise<void> {
  return apiRequest('POST', '/v1/auth/logout');
}

export async function getMe(): Promise<User> {
  return apiRequest<User>('GET', '/v1/me');
}
