import { readFile } from 'node:fs/promises';

const migrations = [
  ['001_initial', new URL('../migrations/001_initial.sql', import.meta.url)],
  [
    '002_message_mentions_array',
    new URL('../migrations/002_message_mentions_array.sql', import.meta.url),
  ],
  [
    '003_agent_profiles_and_room_agent_bindings',
    new URL(
      '../migrations/003_agent_profiles_and_room_agent_bindings.sql',
      import.meta.url,
    ),
  ],
  [
    '004_agent_runtimes_and_generation_requests',
    new URL(
      '../migrations/004_agent_runtimes_and_generation_requests.sql',
      import.meta.url,
    ),
  ],
  [
    '005_user_devices_and_agent_runtime_leases',
    new URL(
      '../migrations/005_user_devices_and_agent_runtime_leases.sql',
      import.meta.url,
    ),
  ],
  [
    '006_room_share_history_on_join',
    new URL(
      '../migrations/006_room_share_history_on_join.sql',
      import.meta.url,
    ),
  ],
];

export async function runMigrations(pool, logger = console) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [742019487]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const [version, url] of migrations) {
      const applied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [version],
      );
      if (applied.rowCount > 0) continue;
      const sql = await readFile(url, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(version) VALUES ($1)',
          [version],
        );
        await client.query('COMMIT');
        logger.info(`[database] applied migration ${version}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [742019487]).catch(() => {});
    client.release();
  }
}
