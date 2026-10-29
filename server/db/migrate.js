import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, withTransaction, getPool } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(__dirname, 'migrations')

export async function runMigrations() {
  await getPool()

  // Ensure tracking table exists
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(120) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  const appliedRows = await query('SELECT version FROM schema_migrations ORDER BY version ASC')
  const applied = new Set(appliedRows.rows.map((r) => r.version))

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  let count = 0
  for (const file of files) {
    if (applied.has(file)) continue

    const filePath = path.join(migrationsDir, file)
    const sql = fs.readFileSync(filePath, 'utf8')

    console.log(`[CampusShare DB Migration] Applying ${file}...`)
    await withTransaction(async (client) => {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations(version, applied_at) VALUES($1, NOW())', [file])
    })
    console.log(`[CampusShare DB Migration] Applied ${file} successfully.`)
    count++
  }

  if (count === 0) {
    console.log('[CampusShare DB Migration] Schema is already up to date.')
  } else {
    console.log(`[CampusShare DB Migration] Successfully applied ${count} migration(s).`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => {
      console.log('[CampusShare DB Migration] Completed.')
      process.exit(0)
    })
    .catch((err) => {
      console.error('[CampusShare DB Migration] Failed:', err)
      process.exit(1)
    })
}
