import { randomUUID } from 'node:crypto';
import { chmod, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PostgresGroupChatStore } from '../src/group_chat_store.mjs';

const DEFAULT_MCP_URL = 'https://mcp.lumenverba.cc/mcp';

function usageError(message) {
  return new Error(`${message}\nRun with --help to see available commands.`);
}

function usage() {
  return `Usage:
  node scripts/admin_credentials.mjs create --display-name NAME --output FILE [--label LABEL] [--mcp-url URL]
  node scripts/admin_credentials.mjs list
  node scripts/admin_credentials.mjs revoke --device-id ID [--device-id ID ...] --yes
  node scripts/admin_credentials.mjs revoke-file --input FILE --yes

Environment:
  DATABASE_URL       Required PostgreSQL connection URI
  DATABASE_SSL=1     Enable verified PostgreSQL TLS`;
}

function parseOptions(tokens) {
  const options = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw usageError(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === 'yes') {
      options.set(name, [true]);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw usageError(`Missing value for --${name}`);
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
    index += 1;
  }
  return options;
}

function assertAllowed(options, names) {
  for (const name of options.keys()) {
    if (!names.has(name)) throw usageError(`Unknown option: --${name}`);
  }
}

function single(options, name, { required = false } = {}) {
  const values = options.get(name) ?? [];
  if (values.length > 1) throw usageError(`--${name} may only be provided once`);
  if (required && values.length === 0) throw usageError(`Missing required --${name}`);
  return values[0];
}

function boundedText(value, name, maxLength) {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw usageError(`--${name} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function parseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw usageError('--mcp-url must use http or https');
  }
  return url.toString();
}

function requireConfirmation(options) {
  if (options.get('yes')?.[0] !== true) {
    throw usageError('Revocation requires --yes');
  }
}

function parseCommand(argv) {
  const [command, ...tokens] = argv;
  if (command === '--help' || command === 'help') return { command: 'help' };
  if (command === 'create') {
    const options = parseOptions(tokens);
    assertAllowed(options, new Set(['display-name', 'output', 'label', 'mcp-url']));
    const displayName = boundedText(
      single(options, 'display-name', { required: true }),
      'display-name',
      80,
    );
    const labelValue = single(options, 'label') ?? displayName;
    return {
      command,
      displayName,
      label: boundedText(labelValue, 'label', 80),
      outputPath: resolve(single(options, 'output', { required: true })),
      mcpUrl: parseUrl(single(options, 'mcp-url') ?? DEFAULT_MCP_URL),
    };
  }
  if (command === 'list') {
    const options = parseOptions(tokens);
    assertAllowed(options, new Set());
    return { command };
  }
  if (command === 'revoke') {
    const options = parseOptions(tokens);
    assertAllowed(options, new Set(['device-id', 'yes']));
    requireConfirmation(options);
    const deviceIds = [...new Set(options.get('device-id') ?? [])].map((value) =>
      boundedText(value, 'device-id', 128));
    if (deviceIds.length === 0) throw usageError('Missing required --device-id');
    return { command, deviceIds };
  }
  if (command === 'revoke-file') {
    const options = parseOptions(tokens);
    assertAllowed(options, new Set(['input', 'yes']));
    requireConfirmation(options);
    return {
      command,
      inputPath: resolve(single(options, 'input', { required: true })),
    };
  }
  throw usageError(command ? `Unknown command: ${command}` : 'Missing command');
}

export async function connectAdminStore(env = process.env) {
  return PostgresGroupChatStore.connect({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL === '1',
  });
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function createCredential({ command, connect, stdout }) {
  const deviceId = `mcp-beta-${randomUUID()}`;
  const output = await open(command.outputPath, 'wx', 0o600);
  let store;
  let session;
  let keepFile = false;
  let credentialCommitted = false;
  let outputClosed = false;
  try {
    store = await connect();
    session = await store.createGuestSession({ deviceId, displayName: command.displayName });
    const document = {
      mcpUrl: command.mcpUrl,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      credential: {
        label: command.label,
        displayName: session.user.displayName,
        userId: session.user.userId,
        deviceId,
        authorizationHeader: `${session.tokenType} ${session.accessToken}`,
      },
    };
    await output.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await output.sync();
    await output.close();
    outputClosed = true;
    await chmod(command.outputPath, 0o600);
    credentialCommitted = true;
    keepFile = true;
    writeJson(stdout, {
      created: true,
      label: command.label,
      displayName: session.user.displayName,
      userId: session.user.userId,
      deviceId,
      output: command.outputPath,
    });
  } catch (error) {
    if (session && store && !credentialCommitted) {
      try {
        await store.pool.query(
          'DELETE FROM sessions WHERE user_id = $1 AND device_id = $2',
          [session.user.userId, deviceId],
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Credential creation failed and the new session could not be revoked',
        );
      }
    }
    throw error;
  } finally {
    if (!outputClosed) await output.close();
    await store?.close();
    if (!keepFile) await unlink(command.outputPath);
  }
}

async function listCredentials({ connect, stdout }) {
  const store = await connect();
  try {
    const result = await store.pool.query(
      `SELECT s.user_id, s.device_id, u.display_name,
              min(s.created_at) AS first_created_at,
              max(s.created_at) AS latest_created_at,
              count(*)::integer AS session_count
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        GROUP BY s.user_id, s.device_id, u.display_name
        ORDER BY latest_created_at DESC, s.user_id, s.device_id`,
    );
    writeJson(stdout, {
      credentials: result.rows.map((row) => ({
        userId: row.user_id,
        deviceId: row.device_id,
        displayName: row.display_name,
        firstCreatedAt: row.first_created_at,
        latestCreatedAt: row.latest_created_at,
        sessionCount: Number(row.session_count),
      })),
    });
  } finally {
    await store.close();
  }
}

function deviceIdsFromDocument(document) {
  const credentials = Array.isArray(document.credentials)
    ? document.credentials
    : [document.credential];
  const deviceIds = credentials
    .map((credential) => credential?.deviceId)
    .filter((deviceId) => typeof deviceId === 'string')
    .map((deviceId) => boundedText(deviceId, 'device-id', 128));
  const unique = [...new Set(deviceIds)];
  if (unique.length === 0) throw new Error('Credential file contains no deviceId');
  return unique;
}

async function revokeCredentials({ deviceIds, connect, stdout }) {
  const store = await connect();
  try {
    const result = await store.pool.query(
      'DELETE FROM sessions WHERE device_id = ANY($1::text[]) RETURNING user_id, device_id',
      [deviceIds],
    );
    writeJson(stdout, {
      revokedSessions: result.rowCount,
      requestedDeviceIds: deviceIds,
      revokedDeviceIds: [...new Set(result.rows.map((row) => row.device_id))],
    });
  } finally {
    await store.close();
  }
}

export async function runAdminCredentials({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  connect = () => connectAdminStore(env),
} = {}) {
  const command = parseCommand(argv);
  if (command.command === 'help') {
    stdout.write(`${usage()}\n`);
    return;
  }
  if (command.command === 'create') {
    await createCredential({ command, connect, stdout });
    return;
  }
  if (command.command === 'list') {
    await listCredentials({ connect, stdout });
    return;
  }
  if (command.command === 'revoke-file') {
    const document = JSON.parse(await readFile(command.inputPath, 'utf8'));
    await revokeCredentials({
      deviceIds: deviceIdsFromDocument(document),
      connect,
      stdout,
    });
    return;
  }
  await revokeCredentials({ deviceIds: command.deviceIds, connect, stdout });
}

const isMain = process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runAdminCredentials().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
