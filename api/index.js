import { app, runMigrations, runSeed } from '../server/index.js'

let initialized = false
let initPromise = null

async function ensureInit() {
  if (initialized) return
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await runMigrations()
        await runSeed()
        initialized = true
      } catch (err) {
        console.error('[CampusShare Vercel Init Error]:', err.message)
        initPromise = null
        throw err
      }
    })()
  }
  return initPromise
}

export default async function handler(req, res) {
  try {
    await ensureInit()
    return app(req, res)
  } catch (err) {
    console.error('[CampusShare Handler Error]:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server initialization error', detail: err.message })
    }
  }
}
