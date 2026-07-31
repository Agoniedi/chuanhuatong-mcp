import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  connectAdminStore,
  runAdminCredentials,
} from '../scripts/admin_credentials.mjs';

function outputCapture() {
  let value = '';
  return {
    stream: { write(chunk) { value += chunk; } },
    value: () => value,
  };
}

function fakeStore({ session, query } = {}) {
  let closed = false;
  const calls = [];
  return {
    calls,
    store: {
      async createGuestSession() {
        return session;
      },
      pool: {
        async query(sql, parameters) {
          calls.push({ sql, parameters });
          return query(sql, parameters);
        },
      },
      async close() {
        closed = true;
      },
    },
    closed: () => closed,
  };
}

describe('credential administration CLI', () => {
  it('writes a created credential only to a restricted output file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chuanhuatong-admin-'));
    const outputPath = join(directory, 'tester.json');
    const token = 'test-credential-secret';
    const database = fakeStore({
      session: {
        accessToken: token,
        tokenType: 'Bearer',
        user: { userId: 'user-1', displayName: 'Tester One' },
      },
      query: async () => ({ rowCount: 0, rows: [] }),
    });
    const output = outputCapture();
    try {
      await runAdminCredentials({
        argv: [
          'create',
          '--display-name', 'Tester One',
          '--label', 'first-tester',
          '--output', outputPath,
        ],
        connect: async () => database.store,
        stdout: output.stream,
      });

      assert.doesNotMatch(output.value(), /test-credential-secret/);
      const document = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(document.credential.authorizationHeader, `Bearer ${token}`);
      assert.equal(document.credential.label, 'first-tester');
      assert.match(document.credential.deviceId, /^mcp-beta-/);
      if (process.platform !== 'win32') {
        assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
      }
      assert.equal(database.closed(), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing output before creating a session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chuanhuatong-admin-'));
    const outputPath = join(directory, 'existing.json');
    await writeFile(outputPath, 'existing', 'utf8');
    let connected = false;
    try {
      await assert.rejects(
        runAdminCredentials({
          argv: ['create', '--display-name', 'Tester', '--output', outputPath],
          connect: async () => {
            connected = true;
            throw new Error('must not connect');
          },
        }),
        (error) => error.code === 'EEXIST',
      );
      assert.equal(connected, false);
      assert.equal(await readFile(outputPath, 'utf8'), 'existing');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a committed credential valid when summary output fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chuanhuatong-admin-'));
    const outputPath = join(directory, 'tester.json');
    const token = 'test-committed-token';
    const database = fakeStore({
      session: {
        accessToken: token,
        tokenType: 'Bearer',
        user: { userId: 'user-1', displayName: 'Tester' },
      },
      query: async () => ({ rowCount: 0, rows: [] }),
    });
    try {
      await assert.rejects(
        runAdminCredentials({
          argv: ['create', '--display-name', 'Tester', '--output', outputPath],
          connect: async () => database.store,
          stdout: { write() { throw new Error('stdout unavailable'); } },
        }),
        /stdout unavailable/,
      );
      const document = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(document.credential.authorizationHeader, `Bearer ${token}`);
      assert.equal(database.calls.length, 0);
      assert.equal(database.closed(), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lists session metadata without returning token hashes', async () => {
    const database = fakeStore({
      query: async () => ({
        rowCount: 1,
        rows: [{
          user_id: 'user-1',
          device_id: 'device-1',
          display_name: 'Tester',
          first_created_at: '2026-07-31T00:00:00.000Z',
          latest_created_at: '2026-07-31T01:00:00.000Z',
          session_count: 2,
          token_hash: 'must-not-leak',
        }],
      }),
    });
    const output = outputCapture();

    await runAdminCredentials({
      argv: ['list'],
      connect: async () => database.store,
      stdout: output.stream,
    });

    const result = JSON.parse(output.value());
    assert.deepEqual(result.credentials, [{
      userId: 'user-1',
      deviceId: 'device-1',
      displayName: 'Tester',
      firstCreatedAt: '2026-07-31T00:00:00.000Z',
      latestCreatedAt: '2026-07-31T01:00:00.000Z',
      sessionCount: 2,
    }]);
    assert.doesNotMatch(output.value(), /must-not-leak|token_hash/);
    assert.equal(database.closed(), true);
  });

  it('revokes unique device IDs only after explicit confirmation', async () => {
    const database = fakeStore({
      query: async (_sql, parameters) => ({
        rowCount: 2,
        rows: parameters[0].map((deviceId) => ({ user_id: `user-${deviceId}`, device_id: deviceId })),
      }),
    });
    const output = outputCapture();

    await assert.rejects(
      runAdminCredentials({
        argv: ['revoke', '--device-id', 'device-1'],
        connect: async () => database.store,
      }),
      /requires --yes/,
    );
    assert.equal(database.calls.length, 0);

    await runAdminCredentials({
      argv: [
        'revoke', '--device-id', 'device-1', '--device-id', 'device-2',
        '--device-id', 'device-1', '--yes',
      ],
      connect: async () => database.store,
      stdout: output.stream,
    });
    assert.deepEqual(database.calls[0].parameters, [['device-1', 'device-2']]);
    assert.equal(JSON.parse(output.value()).revokedSessions, 2);
  });

  it('loads and deduplicates device IDs for batch revocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chuanhuatong-admin-'));
    const inputPath = join(directory, 'credentials.json');
    await writeFile(inputPath, JSON.stringify({
      credentials: [
        { deviceId: 'device-1', authorizationHeader: 'Bearer secret-1' },
        { deviceId: 'device-2', authorizationHeader: 'Bearer secret-2' },
        { deviceId: 'device-1', authorizationHeader: 'Bearer secret-1' },
      ],
    }), 'utf8');
    const database = fakeStore({
      query: async () => ({ rowCount: 0, rows: [] }),
    });
    const output = outputCapture();
    try {
      await runAdminCredentials({
        argv: ['revoke-file', '--input', inputPath, '--yes'],
        connect: async () => database.store,
        stdout: output.stream,
      });
      assert.deepEqual(database.calls[0].parameters, [['device-1', 'device-2']]);
      assert.doesNotMatch(output.value(), /secret-1|secret-2/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when the database URL is missing', async () => {
    await assert.rejects(
      connectAdminStore({ DATABASE_URL: '' }),
      /DATABASE_URL is required/,
    );
  });
});
