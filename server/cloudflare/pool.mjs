import { Buffer } from 'node:buffer';

const jsonColumns = new Set(['data', 'result', 'mapping']);
const integerColumns = new Set(['generation', 'current_generation', 'change_seq', 'next_order', 'order_key', 'server_version', 'seq', 'upper_seq', 'count']);
const dateColumns = /^(?:access_expires_at|refresh_expires_at|revoked_at|rotated_at|replay_until|created_at|last_seen_at|received_at|deleted_at|expires_at|requested_at)$/;

/** Adapter for the finite SQL surface used by the existing sync and auth services.
 * The DO serializes requests; native storage transactions retain rollback semantics.
 * This is deliberately not a general PostgreSQL-to-SQLite compatibility layer.
 */
export class SqlitePool {
  constructor({exec, transaction}) { this.exec = exec; this.nativeTransaction = transaction; }
  async connect() { return this; }
  release() {}
  async end() {}
  withTransaction(fn) { return this.nativeTransaction(() => fn(this)); }
  withSavepoint(fn) { return this.nativeTransaction(fn); }
  async query(source, values = []) {
    if (/^SET TRANSACTION /i.test(source)) return {rows:[],rowCount:0};
    // Keep nested JSON typed and preserve PostgreSQL's string bigint API.
    if (source.startsWith('INSERT INTO snapshot_items(snapshot_id,ordinal,data) SELECT')) {
      const [id, space, generation] = values;
      const items = [];
      for (const [table, type] of [['projects','project'],['study_sessions','session'],['account_preferences','prefs']]) {
        const {rows} = await this.query(`SELECT * FROM ${table} WHERE space_id=$1 AND generation=$2`, [space,generation]);
        for (const r of rows) items.push({entityType:type,entityId:type==='prefs'?'account':r.id,serverVersion:r.server_version,data:r.data,deleted:!!r.deleted_at});
      }
      items.sort((a,b)=>a.entityType.localeCompare(b.entityType)||a.entityId.localeCompare(b.entityId));
      for (let i=0;i<items.length;i++) await this.query('INSERT INTO snapshot_items(snapshot_id,ordinal,data) VALUES($1,$2,$3)',[id,i+1,items[i]]);
      return {rows:[],rowCount:items.length};
    }
    let sql = source
      .replace(/=ANY\(\$(\d+)::uuid\[\]\)/g, ' IN (SELECT value FROM json_each($$$1))')
      .replace(/::(?:text|int|uuid)\b/g, '')
      .replace(/ FOR UPDATE(?: OF \w+)?/g, '')
      .replace(/now\(\)\s*\+\s*interval '(\d+) (day|days)'/g, "strftime('%Y-%m-%dT%H:%M:%fZ','now','+$1 days')")
      .replace(/now\(\)/g, "strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      .replace(/to_timestamp\((\$\d+)\)/g, "strftime('%Y-%m-%dT%H:%M:%fZ',$1,'unixepoch')")
      .replace(/octet_length\(data\)/g, 'length(CAST(data AS BLOB))')
      .replace(/count\(\*\)(?!\s+AS)/gi, 'count(*) AS count');
    const bindings = [];
    sql = sql.replace(/\$(\d+)/g, (_, index) => {
      const value = values[Number(index)-1];
      bindings.push(value instanceof Date ? value.toISOString() : typeof value==='boolean' ? Number(value) : value && typeof value==='object' && !ArrayBuffer.isView(value) ? JSON.stringify(value) : value ?? null);
      return '?';
    });
    try {
      const result = this.exec(sql, bindings);
      const rows = result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,
        value===null ? null : jsonColumns.has(key) ? JSON.parse(value) : integerColumns.has(key) ? String(value) : dateColumns.test(key) ? new Date(value) : value instanceof Uint8Array || value instanceof ArrayBuffer ? Buffer.from(value) : key==='deleted' ? !!value : value
      ])));
      return {rows,rowCount:result.rowCount,command:source.split(' ')[0],fields:[],oid:0};
    } catch(error) {
      if (/UNIQUE constraint/.test(error.message)) error.code='23505';
      if (/FOREIGN KEY constraint/.test(error.message)) error.code='23503';
      throw error;
    }
  }
}
