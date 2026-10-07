// Read-only persistence check for the isolated local development database.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.argv[2];
if (!['baseline', 'compare'].includes(mode)) throw new Error('Use baseline or compare');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.pathname !== '/yotick')
  throw new Error('This check only accepts the isolated local YoTick database');
const baselinePath = join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer', 'persistence-check.json');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = await pool.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = {};
  for (const name of ['projects', 'study_sessions', 'pauses', 'account_preferences', 'sync_operations', 'sync_changes']) {
    const rows = (await db.query(`SELECT row_to_json(t)::text AS row FROM ${name} t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows;
    tables[name] = {
      count: rows.length,
      hash: createHash('sha256').update(JSON.stringify(rows.map(r => r.row))).digest('hex'),
    };
  }
  const latest = (await db.query(
    "SELECT p.name = $1 AS test_project, s.data->>'status' AS status, s.data->>'durationSeconds' AS duration_seconds, s.received_at FROM study_sessions s JOIN projects p ON p.space_id=s.space_id AND p.id=s.project_id WHERE s.deleted_at IS NULL ORDER BY s.received_at DESC LIMIT 1",
    ['同步测试'],
  )).rows[0] || null;
  await db.query('COMMIT');
  if (mode === 'baseline') {
    await writeFile(baselinePath, JSON.stringify({ capturedAt: new Date().toISOString(), tables }), 'utf8');
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    if (JSON.stringify(baseline.tables) !== JSON.stringify(tables))
      throw new Error('Facts or synchronization receipts changed since baseline; compare before declaring preservation');
  }
  console.log(JSON.stringify({ mode, result: 'ok', counts: Object.fromEntries(Object.entries(tables).map(([k,v]) => [k,v.count])), latest }));
} finally {
  db.release();
  await pool.end();
}
