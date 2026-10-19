// Data store for the deployed Disciplr API.
// - If DATABASE_URL is set, uses Postgres (the real `vaults` / `milestones` tables created by
//   `npm run migrate:latest`, and `activity_log`, all owned by migrations).
// - Explicit memory mode or non-production without a URL uses demo memory.
// - Postgres failures and production without a URL fail closed.
import { createStoreProvider } from './store-bootstrap.mjs'
import { seed } from './demo-data.mjs'
const iso = (d) => new Date(d).toISOString()

export class MemoryStore {
  kind = 'memory'
  constructor() { const s = seed(); this.vaults = s.vaults; this.activity = s.activity }
  async init() {}
  async listVaults({ creator, status } = {}) {
    return this.vaults.filter((v) => (!creator || v.creator === creator) && (!status || v.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async getVault(id) { return this.vaults.find((v) => v.id === id) || null }
  async createVault(v) { this.vaults.push(v); return v }
  async saveVault(v) { v.updatedAt = iso(Date.now()); return v }
  async addActivity(a) { this.activity.push(a); return a }
  async listActivity({ vaultId } = {}) {
    return this.activity.filter((a) => !vaultId || a.vaultId === vaultId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}

export class PgStore {
  kind = 'postgres'
  constructor(pool) { this.pool = pool }
  async init() {
    await this.pool.query('SELECT 1')
  }

  rowToVault(r, ms) {
    return {
      id: r.id, name: r.name || `Vault ${r.id}`, creator: r.creator, amount: String(Number(r.amount)), status: r.status, startDate: iso(r.start_date), endDate: iso(r.end_date),
      verifier: r.verifier, successDestination: r.success_destination, failureDestination: r.failure_destination,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
      milestones: ms.filter((m) => m.vault_id === r.id).sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => ({ id: m.id, title: m.title, amount: String(Number(m.amount)), dueDate: iso(m.due_date || m.deadline), status: m.status })),
    }
  }
  async listVaults({ creator, status } = {}) {
    const w = ['deleted_at IS NULL']; const p = []
    if (creator) { p.push(creator); w.push(`creator = $${p.length}`) }
    if (status) { p.push(status); w.push(`status = $${p.length}::vault_status`) }
    const { rows } = await this.pool.query(`SELECT * FROM vaults WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, p)
    if (!rows.length) return []
    const ms = (await this.pool.query('SELECT * FROM milestones WHERE vault_id = ANY($1) AND deleted_at IS NULL', [rows.map((r) => r.id)])).rows
    return rows.map((r) => this.rowToVault(r, ms))
  }
  async getVault(id) {
    const { rows } = await this.pool.query('SELECT * FROM vaults WHERE id = $1 AND deleted_at IS NULL', [id])
    if (!rows[0]) return null
    const ms = (await this.pool.query('SELECT * FROM milestones WHERE vault_id = $1 AND deleted_at IS NULL', [id])).rows
    return this.rowToVault(rows[0], ms)
  }
  async createVault(v) {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO vaults (id, name, creator, amount, start_date, end_date, verifier, success_destination, failure_destination, status, created_at, updated_at)
        VALUES ($1,$11,$2,$3,$4,$5,$6,$7,$8,$9::vault_status,$10,$10)`,
      [v.id, v.creator, v.amount, v.startDate, v.endDate, v.verifier, v.successDestination, v.failureDestination, v.status, v.createdAt, v.name])
      let i = 0
      for (const m of v.milestones) {
        await c.query(`INSERT INTO milestones (id, vault_id, title, target_amount, amount, deadline, due_date, status, sort_order)
          VALUES ($1,$2,$3,$4,$4,$5,$5,$6::milestone_status,$7)`, [m.id, v.id, m.title, m.amount, m.dueDate, m.status, i++])
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    return v
  }
  async saveVault(v) {
    await this.pool.query('UPDATE vaults SET status=$2::vault_status, updated_at=now() WHERE id=$1', [v.id, v.status])
    for (const m of v.milestones) await this.pool.query('UPDATE milestones SET status=$2::milestone_status, updated_at=now() WHERE id=$1', [m.id, m.status])
    return v
  }
  async addActivity(a) {
    await this.pool.query('INSERT INTO activity_log (id,type,vault_id,amount,status,hash,memo,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [a.id, a.type, a.vaultId, a.amount, a.status, a.hash, a.memo, a.createdAt])
    return a
  }
  async listActivity({ vaultId } = {}) {
    const { rows } = vaultId
      ? await this.pool.query('SELECT * FROM activity_log WHERE vault_id=$1 ORDER BY created_at DESC LIMIT 200', [vaultId])
      : await this.pool.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 200')
    return rows.map((r) => ({ id: r.id, type: r.type, vaultId: r.vault_id, amount: String(Number(r.amount)), status: r.status, hash: r.hash, memo: r.memo, createdAt: iso(r.created_at) }))
  }
}

export const getStore = createStoreProvider({
  makePool: async (config) => new (await import('pg')).default.Pool(config),
  makePostgres: (pool) => new PgStore(pool),
  makeMemory: () => new MemoryStore(),
})
