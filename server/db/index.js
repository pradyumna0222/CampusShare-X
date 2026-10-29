import 'dotenv/config'
import pg from 'pg'

const { Pool, types } = pg

// Ensure PostgreSQL dates and timestamps are formatted consistently as ISO strings
// OID 1082: DATE -> return raw 'YYYY-MM-DD' string (prevents timezone-shift bugs)
types.setTypeParser(1082, (val) => val)
// OID 1114: TIMESTAMP WITHOUT TIME ZONE -> ISO string
types.setTypeParser(1114, (val) => (val ? new Date(val + 'Z').toISOString() : null))
// OID 1184: TIMESTAMPTZ -> ISO string
types.setTypeParser(1184, (val) => (val ? new Date(val).toISOString() : null))

let poolInstance = null
let pgliteInstance = null

function createPgPool(connectionString) {
  const isProduction = process.env.NODE_ENV === 'production'
  const isNeon = connectionString.includes('neon.tech')
  const requiresSsl = isProduction || isNeon || connectionString.includes('sslmode=require') || process.env.DATABASE_SSL === 'true'

  const pool = new Pool({
    connectionString,
    ssl: requiresSsl ? { rejectUnauthorized: false } : false,
    max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  })

  pool.on('error', (err) => {
    console.error('[CampusShare DB Pool] Unexpected client error:', err.message)
  })

  return pool
}

async function getPglitePool() {
  if (!pgliteInstance) {
    const { PGlite } = await import('@electric-sql/pglite')
    const dbPath = process.env.PGLITE_DATA_DIR || undefined
    const pglite = new PGlite(dbPath)

    pgliteInstance = {
      isPglite: true,
      async query(text, params = []) {
        if ((!params || params.length === 0) && text.includes(';')) {
          await pglite.exec(text)
          return { rows: [], rowCount: 0 }
        }
        const res = await pglite.query(text, params)
        return {
          rows: res.rows || [],
          rowCount: res.affectedRows ?? res.rows?.length ?? 0,
        }
      },
      async connect() {
        return {
          query: async (text, params = []) => {
            if ((!params || params.length === 0) && text.includes(';')) {
              await pglite.exec(text)
              return { rows: [], rowCount: 0 }
            }
            const res = await pglite.query(text, params)
            return {
              rows: res.rows || [],
              rowCount: res.affectedRows ?? res.rows?.length ?? 0,
            }
          },
          release: () => {},
        }
      },
      async end() {
        if (pglite.close) await pglite.close()
        pgliteInstance = null
      },
      on: () => {},
    }
  }
  return pgliteInstance
}

export async function getPool() {
  if (poolInstance) return poolInstance

  const connectionString = process.env.DATABASE_URL
  if (connectionString && connectionString !== 'memory' && !connectionString.startsWith('sqlite:')) {
    poolInstance = createPgPool(connectionString)
    return poolInstance
  }

  // Fallback to embedded PostgreSQL (PGlite) for zero-config testing and local offline runs
  poolInstance = await getPglitePool()
  return poolInstance
}

export async function query(text, params = []) {
  const pool = await getPool()
  return pool.query(text, params)
}

export async function getClient() {
  const pool = await getPool()
  return pool.connect()
}

export async function withTransaction(fn) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rbErr) {
      console.error('[CampusShare DB] Rollback error:', rbErr.message)
    }
    throw error
  } finally {
    client.release()
  }
}

export async function ping() {
  const res = await query('SELECT 1 as connected')
  return res.rows[0]?.connected === 1 || res.rows[0]?.connected === '1'
}

export async function closeDb() {
  if (poolInstance) {
    await poolInstance.end()
    poolInstance = null
  }
}

export default {
  getPool,
  query,
  getClient,
  withTransaction,
  ping,
  closeDb,
}
