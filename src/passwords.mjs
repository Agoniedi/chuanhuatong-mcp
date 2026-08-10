import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 32;

export async function createPasswordDigest(password) {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return { salt, hash: Buffer.from(derived).toString('base64url') };
}

export async function verifyPasswordDigest(password, salt, expectedHash) {
  const expected = Buffer.from(expectedHash, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = Buffer.from(await scrypt(password, salt, KEY_LENGTH));
  return timingSafeEqual(actual, expected);
}
