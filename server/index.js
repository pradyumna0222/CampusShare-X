import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, withTransaction, ping, closeDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { runSeed } from './db/seed.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const COOKIE_NAME = 'campus_session'
const SESSION_DAYS = 7
const TZ_OFFSET = Number(process.env.BOOKING_TIMEZONE_OFFSET_MINUTES || 330)
const isProduction = process.env.NODE_ENV === 'production'

const nowIso = () => new Date().toISOString()
const makeId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`
const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex')
const encodeJson = (value) => JSON.stringify(value ?? [])
const decodeJson = (value) => {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null) return value
  try {
    return JSON.parse(value || '[]')
  } catch {
    return []
  }
}
const titleForRole = (role) => ({ student: 'Student', owner: 'Resource owner', admin: 'Campus administrator' })[role] || 'Member'
const initialsFor = (name) =>
  String(name || 'User')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase()

function timeValue(value) {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

function toEpoch(date, time) {
  const sign = TZ_OFFSET >= 0 ? '+' : '-'
  const abs = Math.abs(TZ_OFFSET)
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return new Date(`${date}T${time}:00${offset}`).getTime()
}

function currentDateInCampusTime() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const take = (type) => parts.find((p) => p.type === type)?.value
  return `${take('year')}-${take('month')}-${take('day')}`
}

async function addAudit(actor, actorName, action, target, detail, resourceId = null, bookingId = null, client = null) {
  const sql = `INSERT INTO audit_events(id, actor_id, actor_name, action, target, detail, resource_id, booking_id, created_at)
               VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`
  const params = [makeId('evt'), actor?.id || null, actorName || 'System', action, target, detail || '', resourceId, bookingId, nowIso()]
  if (client) {
    await client.query(sql, params)
  } else {
    await query(sql, params)
  }
}

async function notify(userId, bookingId, kind, title, body, client = null) {
  if (!userId) return
  const runner = client || { query }
  if (bookingId) {
    await runner.query(
      `INSERT INTO notifications(id, user_id, booking_id, kind, title, body, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, booking_id, kind) WHERE booking_id IS NOT NULL DO NOTHING`,
      [makeId('ntf'), userId, bookingId, kind, title, body, nowIso()]
    )
  } else {
    await runner.query(
      `INSERT INTO notifications(id, user_id, booking_id, kind, title, body, created_at)
       VALUES($1, $2, NULL, $3, $4, $5, $6)
       ON CONFLICT (user_id, kind) WHERE booking_id IS NULL DO NOTHING`,
      [makeId('ntf'), userId, kind, title, body, nowIso()]
    )
  }
}

async function trainingCodesForUser(userId, client = null) {
  const runner = client || { query }
  const res = await runner.query(
    `SELECT training_code FROM training_records
     WHERE user_id = $1 AND status = 'verified' AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
     ORDER BY training_code`,
    [userId]
  )
  return res.rows.map((row) => row.training_code)
}

async function rowUser(row, trainingCodes = null) {
  if (!row) return null
  const codes = trainingCodes !== null ? trainingCodes : await trainingCodesForUser(row.id)
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    title: row.title || titleForRole(row.role),
    initials: initialsFor(row.name),
    verificationStatus: row.verification_status,
    trainingCodes: codes,
    createdAt: row.created_at,
  }
}

async function userById(id, client = null) {
  const runner = client || { query }
  const res = await runner.query('SELECT * FROM users WHERE id = $1', [id])
  return res.rows[0] ? rowUser(res.rows[0]) : null
}

async function directoryUsers() {
  const res = await query(
    `SELECT id, name, email, role, verification_status, created_at
     FROM users
     ORDER BY CASE verification_status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`
  )
  const trainingRes = await query(
    `SELECT user_id, training_code FROM training_records
     WHERE status = 'verified' AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)`
  )
  const trainingMap = new Map()
  for (const tr of trainingRes.rows) {
    if (!trainingMap.has(tr.user_id)) trainingMap.set(tr.user_id, [])
    trainingMap.get(tr.user_id).push(tr.training_code)
  }
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    verificationStatus: row.verification_status,
    trainingCodes: trainingMap.get(row.id) || [],
    createdAt: row.created_at,
  }))
}

function resourceView(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    location: row.location,
    ownerId: row.owner_id,
    ownerName: row.owner_name || 'Resource owner',
    capabilityTags: decodeJson(row.capability_tags),
    requiredTraining: decodeJson(row.required_training),
    status: row.status,
    icon: row.icon,
    gradient: row.gradient,
    assetCode: row.asset_code,
    uses: Number(row.uses) || 0,
    instructions: row.instructions,
    valueLabel: row.value_label,
  }
}

async function getResourceRows(client = null) {
  const runner = client || { query }
  const res = await runner.query(
    `SELECT r.*, u.name as owner_name
     FROM resources r
     JOIN users u ON u.id = r.owner_id
     ORDER BY CASE r.status WHEN 'available' THEN 0 WHEN 'maintenance' THEN 1 ELSE 2 END, r.name`
  )
  return res.rows
}

async function getResourceById(id, client = null) {
  const runner = client || { query }
  const res = await runner.query(
    `SELECT r.*, u.name as owner_name
     FROM resources r
     JOIN users u ON u.id = r.owner_id
     WHERE r.id = $1`,
    [id]
  )
  return res.rows[0] ? resourceView(res.rows[0]) : null
}

async function eligibleUserForResource(userId, resource, client = null) {
  const runner = client || { query }
  const res = await runner.query('SELECT * FROM users WHERE id = $1', [userId])
  const userRow = res.rows[0]
  if (!userRow || userRow.verification_status !== 'verified') {
    return { passed: false, reason: 'Institutional profile verification is required.', missingTraining: [] }
  }
  const codes = await trainingCodesForUser(userId, client)
  const missing = resource.requiredTraining.filter((code) => !codes.includes(code))
  if (missing.length) {
    return { passed: false, reason: `Missing required training: ${missing.join(', ')}.`, missingTraining: missing }
  }
  return { passed: true, reason: null, missingTraining: [] }
}

async function generateScheduledNotifications() {
  const now = Date.now()
  const res = await query(
    `SELECT b.*, r.owner_id, r.name as resource_name, u.name as user_name
     FROM bookings b
     JOIN resources r ON r.id = b.resource_id
     JOIN users u ON u.id = b.user_id
     WHERE b.status IN ('approved', 'checked_out')`
  )
  for (const b of res.rows) {
    const start = toEpoch(b.start_date, b.start_time)
    const end = toEpoch(b.start_date, b.end_time)
    if (b.status === 'approved' && start > now && start - now <= 24 * 60 * 60 * 1000) {
      await notify(
        b.user_id,
        b.id,
        'booking_reminder',
        'Upcoming resource booking',
        `${b.resource_name} starts at ${b.start_time} on ${b.start_date}. Review the access and handover instructions.`
      )
    }
    if (b.status === 'checked_out' && end > now && end - now <= 24 * 60 * 60 * 1000) {
      await notify(
        b.user_id,
        b.id,
        'return_due_soon',
        'Return due soon',
        `${b.resource_name} is due back at ${b.end_time} on ${b.start_date}. Please confirm the return.`
      )
    }
    if (b.status === 'checked_out' && end < now) {
      await notify(
        b.user_id,
        b.id,
        'overdue_return',
        'Resource return overdue',
        `${b.resource_name} was due at ${b.end_time} on ${b.start_date}. Please contact the resource owner.`
      )
      await notify(
        b.owner_id,
        b.id,
        'overdue_return_owner',
        'Overdue resource return',
        `${b.resource_name}, currently checked out by ${b.user_name}, is past its return time.`
      )
    }
  }
}

async function getBookingRows(user) {
  let where = ''
  let params = []
  if (user.role === 'student') {
    where = 'WHERE b.user_id = $1'
    params = [user.id]
  } else if (user.role === 'owner') {
    where = 'WHERE r.owner_id = $1'
    params = [user.id]
  }
  const res = await query(
    `SELECT b.*, r.name as resource_name, r.owner_id as resource_owner_id, u.name as user_name
     FROM bookings b
     JOIN resources r ON r.id = b.resource_id
     JOIN users u ON u.id = b.user_id
     ${where}
     ORDER BY b.created_at DESC`,
    params
  )
  const rows = []
  for (const row of res.rows) {
    const resource = await getResourceById(row.resource_id)
    const eligibility = await eligibleUserForResource(row.user_id, resource)
    rows.push({
      id: row.id,
      resourceId: row.resource_id,
      resourceName: row.resource_name,
      userId: row.user_id,
      userName: row.user_name,
      startDate: row.start_date,
      startTime: row.start_time,
      endTime: row.end_time,
      purpose: row.purpose,
      status: row.status,
      decisionReason: row.decision_reason || undefined,
      conditionBefore: row.condition_before || undefined,
      conditionBeforeNotes: row.condition_before_notes || undefined,
      conditionAfter: row.condition_after || undefined,
      conditionAfterNotes: row.condition_after_notes || undefined,
      createdAt: row.created_at,
      eligibilityPassed: eligibility.passed,
      eligibilityReason: eligibility.reason,
    })
  }
  return rows
}

function checkOwner(user, resource) {
  if (!resource) return false
  return user.role === 'admin' || (user.role === 'owner' && resource.ownerId === user.id)
}

async function requireAuth(req, res, next) {
  try {
    const cookieHeader = req.headers.cookie || ''
    const item = cookieHeader
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${COOKIE_NAME}=`))
    if (!item) return res.status(401).json({ error: 'Sign in to continue.', code: 'AUTH_REQUIRED' })
    const rawToken = decodeURIComponent(item.slice(COOKIE_NAME.length + 1))
    const tokenHash = hashToken(rawToken)
    const rowRes = await query(
      `SELECT s.id as session_id, s.expires_at, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [tokenHash]
    )
    const row = rowRes.rows[0]
    if (!row || Date.parse(row.expires_at) < Date.now()) {
      if (row) await query('DELETE FROM sessions WHERE id = $1', [row.session_id])
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isProduction ? '; Secure' : ''}`)
      return res.status(401).json({ error: 'Your session expired. Please sign in again.', code: 'SESSION_EXPIRED' })
    }
    req.user = await rowUser(row)
    next()
  } catch (err) {
    next(err)
  }
}

function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ error: 'Your account does not have permission to perform this action.', code: 'ROLE_FORBIDDEN' })
}

function fail(res, status, message, code) {
  return res.status(status).json({ error: message, code })
}

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  await query('INSERT INTO sessions(id, token_hash, user_id, expires_at, created_at) VALUES($1, $2, $3, $4, $5)', [
    makeId('ses'),
    hashToken(token),
    userId,
    expiresAt,
    nowIso(),
  ])
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${isProduction ? '; Secure' : ''}`
  )
}

async function recordBookingEvent(user, booking, action, detail, client = null) {
  await addAudit(user, user.name, action, booking.resourceName, detail, booking.resourceId, booking.id, client)
}

async function makeWorkspace(user) {
  await generateScheduledNotifications()
  const resourceRows = await getResourceRows()
  const resources = resourceRows.map(resourceView)
  const bookings = await getBookingRows(user)

  let incidentRows
  if (user.role === 'admin') {
    incidentRows = (
      await query(
        `SELECT i.*, r.name as resource_name, u.name as reporter_name
         FROM incidents i
         JOIN bookings b ON b.id = i.booking_id
         JOIN resources r ON r.id = b.resource_id
         JOIN users u ON u.id = i.reporter_id
         ORDER BY i.created_at DESC`
      )
    ).rows
  } else if (user.role === 'owner') {
    incidentRows = (
      await query(
        `SELECT i.*, r.name as resource_name, u.name as reporter_name
         FROM incidents i
         JOIN bookings b ON b.id = i.booking_id
         JOIN resources r ON r.id = b.resource_id
         JOIN users u ON u.id = i.reporter_id
         WHERE r.owner_id = $1
         ORDER BY i.created_at DESC`,
        [user.id]
      )
    ).rows
  } else {
    incidentRows = (
      await query(
        `SELECT i.*, r.name as resource_name, u.name as reporter_name
         FROM incidents i
         JOIN bookings b ON b.id = i.booking_id
         JOIN resources r ON r.id = b.resource_id
         JOIN users u ON u.id = i.reporter_id
         WHERE b.user_id = $1 OR i.reporter_id = $2
         ORDER BY i.created_at DESC`,
        [user.id, user.id]
      )
    ).rows
  }
  const incidents = incidentRows.map((row) => ({
    id: row.id,
    bookingId: row.booking_id,
    resourceName: row.resource_name,
    reporter: row.reporter_name,
    description: row.description,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    resolution: row.resolution || undefined,
  }))

  let auditRows
  if (user.role === 'admin') {
    auditRows = (await query('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 300')).rows
  } else if (user.role === 'owner') {
    auditRows = (
      await query(
        `SELECT a.* FROM audit_events a
         LEFT JOIN resources r ON r.id = a.resource_id
         WHERE r.owner_id = $1 OR a.actor_id = $2
         ORDER BY a.created_at DESC LIMIT 300`,
        [user.id, user.id]
      )
    ).rows
  } else {
    auditRows = (
      await query(
        `SELECT a.* FROM audit_events a
         WHERE a.actor_id = $1 OR a.booking_id IN (SELECT id FROM bookings WHERE user_id = $2)
         ORDER BY a.created_at DESC LIMIT 300`,
        [user.id, user.id]
      )
    ).rows
  }
  const audit = auditRows.map((row) => ({
    id: row.id,
    actor: row.actor_name,
    action: row.action,
    target: row.target,
    detail: row.detail,
    createdAt: row.created_at,
  }))

  const notifRes = await query('SELECT id, kind, title, body, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [
    user.id,
  ])
  const notifications = notifRes.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    readAt: row.read_at || undefined,
    createdAt: row.created_at,
  }))

  let extensionWhere = ''
  let extensionParams = []
  if (user.role === 'student') {
    extensionWhere = 'WHERE b.user_id = $1'
    extensionParams = [user.id]
  } else if (user.role === 'owner') {
    extensionWhere = 'WHERE r.owner_id = $1'
    extensionParams = [user.id]
  }
  const extRes = await query(
    `SELECT e.*, b.resource_id, b.user_id, b.start_date, b.end_time as current_end_time, r.name as resource_name, u.name as user_name
     FROM booking_extensions e
     JOIN bookings b ON b.id = e.booking_id
     JOIN resources r ON r.id = b.resource_id
     JOIN users u ON u.id = b.user_id
     ${extensionWhere}
     ORDER BY CASE e.status WHEN 'pending' THEN 0 ELSE 1 END, e.created_at ASC
     LIMIT 250`,
    extensionParams
  )
  const extensions = extRes.rows.map((row) => ({
    id: row.id,
    bookingId: row.booking_id,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    userId: row.user_id,
    userName: row.user_name,
    startDate: row.start_date,
    originalEndTime: row.original_end_time,
    currentEndTime: row.status === 'pending' ? row.current_end_time : row.original_end_time,
    requestedEndTime: row.requested_end_time,
    reason: row.reason,
    status: row.status,
    decisionReason: row.decision_reason || undefined,
    createdAt: row.created_at,
  }))

  const users = user.role === 'admin' ? await directoryUsers() : []
  return { user: await userById(user.id), resources, bookings, incidents, audit, notifications, users, extensions }
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', isProduction ? 1 : false)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        connectSrc: ["'self'"],
      },
    },
  })
)
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '20kb' }))
app.use((req, res, next) => {
  if (isProduction && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
    try {
      const originHost = new URL(req.headers.origin).host
      const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
        .split(',')[0]
        .trim()
      if (originHost !== requestHost) return res.status(403).json({ error: 'Cross-origin state-changing requests are not allowed.', code: 'ORIGIN_FORBIDDEN' })
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.', code: 'ORIGIN_FORBIDDEN' })
    }
  }
  next()
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again later.' },
})

app.get('/api/health', async (_req, res) => {
  try {
    const isDbAlive = await ping()
    if (!isDbAlive) throw new Error('Database ping failed')
    res.json({ status: 'ok', service: 'CampusShare X API', database: 'connected', timestamp: nowIso() })
  } catch (err) {
    res.status(503).json({ status: 'degraded', service: 'CampusShare X API', database: 'disconnected', error: err.message, timestamp: nowIso() })
  }
})

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase()
    const password = String(req.body?.password || '')
    if (!email || !password) return fail(res, 400, 'Enter your email and password.', 'VALIDATION_ERROR')
    const userRes = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email])
    const row = userRes.rows[0]
    if (!row || !bcrypt.compareSync(password, row.password_hash)) return fail(res, 401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS')
    await createSession(row.id, res)
    await addAudit(await rowUser(row), row.name, 'Signed in', 'Account', 'Authenticated session created.')
    res.json({ user: await userById(row.id) })
  } catch (err) {
    next(err)
  }
})

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim()
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase()
    const password = String(req.body?.password || '')
    if (name.length < 2 || name.length > 80) return fail(res, 400, 'Enter your full name (2–80 characters).', 'VALIDATION_ERROR')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid email address.', 'VALIDATION_ERROR')
    if (password.length < 12) return fail(res, 400, 'Use a password with at least 12 characters.', 'WEAK_PASSWORD')

    const existingRes = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email])
    if (existingRes.rows[0]) return fail(res, 409, 'An account with this email already exists.', 'EMAIL_EXISTS')

    const id = makeId('usr')
    const title = 'Student · Awaiting verification'
    const now = nowIso()

    await query(
      `INSERT INTO users(id, name, email, password_hash, role, title, verification_status, created_at)
       VALUES($1, $2, $3, $4, 'student', $5, 'pending', $6)`,
      [id, name, email, bcrypt.hashSync(password, 12), title, now]
    )

    await addAudit({ id, name }, name, 'Account registered', 'User profile', 'Student account created and queued for institutional verification.')
    const adminsRes = await query("SELECT id FROM users WHERE role = 'admin'")
    for (const admin of adminsRes.rows) {
      await notify(admin.id, null, `account_verification_${id}`, 'Student verification required', `${name} (${email}) registered and needs institutional verification.`)
    }

    await createSession(id, res)
    res.status(201).json({ user: await userById(id) })
  } catch (err) {
    next(err)
  }
})

app.get('/api/auth/me', async (req, res, next) => {
  try {
    const cookieHeader = req.headers.cookie || ''
    const item = cookieHeader
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${COOKIE_NAME}=`))
    if (!item) return res.status(401).json({ error: 'Not signed in.' })
    const token = decodeURIComponent(item.slice(COOKIE_NAME.length + 1))
    const userRes = await query(
      `SELECT s.id as session_id, s.expires_at, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [hashToken(token)]
    )
    const row = userRes.rows[0]
    if (!row || Date.parse(row.expires_at) < Date.now()) return res.status(401).json({ error: 'Session expired.' })
    res.json({ user: await userById(row.id) })
  } catch (err) {
    next(err)
  }
})

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const item = (req.headers.cookie || '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${COOKIE_NAME}=`))
    if (item) {
      await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(decodeURIComponent(item.slice(COOKIE_NAME.length + 1)))])
    }
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isProduction ? '; Secure' : ''}`)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.get('/api/workspace', requireAuth, async (req, res, next) => {
  try {
    const data = await makeWorkspace(req.user)
    res.json(data)
  } catch (err) {
    next(err)
  }
})

app.post('/api/smartmatch', requireAuth, async (req, res, next) => {
  try {
    const goal = String(req.body?.goal || '')
      .trim()
      .slice(0, 1200)
    if (goal.length < 3) return fail(res, 400, 'Describe what you are trying to do.', 'VALIDATION_ERROR')
    const resourceRows = await getResourceRows()
    const allResources = resourceRows.map(resourceView)
    const allowedTags = [...new Set(allResources.flatMap((r) => r.capabilityTags))]
    const fallbackTags = deriveTags(goal, allowedTags)
    let requestedTags = fallbackTags
    let reasoningMode = 'rule-based-fallback'
    if (process.env.OPENAI_API_KEY) {
      try {
        const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content:
                  'Extract capability tags needed for a project from user intent. Return JSON only: {"capabilities":[...],"summary":"..."}. Only use exact tags from the provided allowlist. Do not make access, safety, or availability decisions.',
              },
              { role: 'user', content: JSON.stringify({ goal, allowedTags }) },
            ],
          }),
          signal: AbortSignal.timeout(7000),
        })
        if (!response.ok) throw new Error(`AI provider returned ${response.status}`)
        const payload = await response.json()
        const parsed = JSON.parse(payload.choices?.[0]?.message?.content || '{}')
        const safe = Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((tag) => allowedTags.includes(tag)) : []
        if (safe.length) {
          requestedTags = [...new Set(safe)]
          reasoningMode = 'llm-assisted'
        }
      } catch (error) {
        console.warn('SmartMatch AI fallback used:', error instanceof Error ? error.message : 'provider error')
      }
    }
    const items = []
    for (const resource of allResources) {
      const matches = resource.capabilityTags.filter((tag) => requestedTags.some((q) => q === tag || q.includes(tag) || tag.includes(q)))
      const score = Math.round(Math.min(100, (matches.length / Math.max(1, Math.min(requestedTags.length, 5))) * 100))
      const eligibility = await eligibleUserForResource(req.user.id, resource)
      const reasons = matches.length ? [`Matches: ${matches.slice(0, 4).join(', ')}`] : ['No direct capability tag match; inspect specifications before requesting.']
      if (!eligibility.passed) reasons.push(eligibility.reason)
      if (resource.status !== 'available') reasons.push(`Resource status is ${resource.status}.`)
      items.push({
        resourceId: resource.id,
        matchScore: score,
        reasons,
        eligibility: { status: eligibility.passed ? 'eligible' : 'blocked', reason: eligibility.reason },
        operationalStatus: resource.status,
        availability: { status: 'slot_selection_required', note: 'Select a date and time; the server will verify the slot when you submit.' },
      })
    }
    items.sort((a, b) => b.matchScore - a.matchScore)
    res.json({ goal, requiredCapabilities: requestedTags, reasoningMode, results: items })
  } catch (err) {
    next(err)
  }
})

function deriveTags(text, allowedTags) {
  const lower = text.toLowerCase()
  const aliases = {
    iot: ['iot', 'internet of things', 'embedded', 'esp32', 'arduino', 'microcontroller', 'sensor', 'prototype'],
    sensor: ['sensor', 'temperature', 'humidity', 'environmental', 'iot'],
    electronics: ['electronic', 'circuit', 'breadboard', 'electronics', 'solder', 'voltage'],
    testing: ['test', 'testing', 'debug', 'debugging', 'measurement', 'measure', 'oscilloscope', 'multimeter', 'signal'],
    video: ['video', 'record', 'camera', 'photography', 'filming'],
    camera: ['camera', 'record', 'photography', 'video'],
    recording: ['record', 'video', 'filming'],
    meeting: ['meeting', 'team', 'collaboration', 'discussion'],
    team: ['team', 'group', 'collaboration'],
    room: ['room', 'meeting', 'collaboration'],
    presentation: ['presentation', 'display', 'demo'],
    programming: ['program', 'programming', 'code', 'coding', 'software', 'firmware'],
    computing: ['laptop', 'computer', 'development', 'software'],
    prototype: ['prototype', 'prototyping', 'build', 'make', 'circuit', 'iot'],
    microcontroller: ['microcontroller', 'esp32', 'arduino', 'embedded', 'iot'],
    breadboard: ['breadboard', 'circuit', 'prototyping'],
    voltage: ['voltage', 'measure', 'measurement', 'multimeter'],
    measurement: ['measure', 'measurement', 'test', 'multimeter', 'signal'],
    debugging: ['debug', 'debugging', 'test', 'circuit', 'signal'],
    signal: ['signal', 'oscilloscope', 'communication', 'frequency'],
    documentation: ['documentation', 'document', 'record', 'camera', 'video'],
    collaboration: ['collaboration', 'team', 'meeting', 'group'],
    project: ['project', 'team', 'meeting', 'prototype'],
    development: ['development', 'programming', 'code', 'iot'],
    coding: ['code', 'coding', 'programming'],
    photography: ['photography', 'camera', 'picture'],
    fabrication: ['fabrication', 'solder', 'prototype', 'electronics'],
    soldering: ['solder', 'soldering'],
  }
  const found = allowedTags.filter((tag) => lower.includes(tag.replaceAll('-', ' ')) || (aliases[tag] || []).some((word) => lower.includes(word)))
  return [...new Set(found)].slice(0, 12).length ? [...new Set(found)].slice(0, 12) : allowedTags.filter((tag) => lower.includes(tag)).slice(0, 8)
}

app.post('/api/resources', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { name, category, location, description, capabilityTags, requiredTraining, instructions, status } = req.body || {}
    if (String(name || '').trim().length < 2 || String(location || '').trim().length < 2) {
      return fail(res, 400, 'Resource name and location are required.', 'VALIDATION_ERROR')
    }
    const tags = Array.isArray(capabilityTags)
      ? capabilityTags.filter((v) => typeof v === 'string').map((v) => v.trim().toLowerCase()).filter(Boolean).slice(0, 30)
      : String(capabilityTags || '')
          .split(',')
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 30)
    const training = Array.isArray(requiredTraining)
      ? requiredTraining.filter((v) => typeof v === 'string').map((v) => v.trim().toLowerCase()).filter(Boolean).slice(0, 20)
      : String(requiredTraining || '')
          .split(',')
          .map((v) => v.trim().toLowerCase().replaceAll(' ', '-'))
          .filter(Boolean)
          .slice(0, 20)
    const resourceId = makeId('res')
    const assetCode = `CSX-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
    const icon = category === 'Computing' ? 'laptop' : category === 'Media' ? 'camera' : category === 'Spaces' ? 'door' : 'cpu'
    const gradient = ({ Electronics: 'violet', Testing: 'blue', Computing: 'indigo', Media: 'rose', Spaces: 'green', 'Lab equipment': 'slate' })[category] || 'violet'

    await query(
      `INSERT INTO resources(id, name, category, description, location, owner_id, capability_tags, required_training, status, icon, gradient, asset_code, uses, instructions, value_label, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, $14, $15)`,
      [
        resourceId,
        String(name).trim(),
        String(category || 'Other').slice(0, 60),
        String(description || 'Institution-managed shared resource.').trim().slice(0, 1500),
        String(location).trim().slice(0, 160),
        req.user.id,
        encodeJson(tags),
        encodeJson(training),
        ['available', 'maintenance', 'inactive'].includes(status) ? status : 'available',
        icon,
        gradient,
        assetCode,
        String(instructions || 'Follow the owner-provided usage and return instructions.').slice(0, 1500),
        String(category || 'Resource').slice(0, 80),
        nowIso(),
      ]
    )
    await addAudit(req.user, req.user.name, 'Resource listed', String(name).trim(), `Location: ${String(location).trim()}`, resourceId)
    res.status(201).json({ resource: await getResourceById(resourceId) })
  } catch (err) {
    next(err)
  }
})

app.patch('/api/resources/:id/status', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const resource = await getResourceById(req.params.id)
    if (!resource) return fail(res, 404, 'Resource not found.', 'NOT_FOUND')
    if (!checkOwner(req.user, resource)) return fail(res, 403, 'You can only manage resources you own.', 'RESOURCE_FORBIDDEN')
    const status = req.body?.status
    if (!['available', 'maintenance', 'inactive'].includes(status)) return fail(res, 400, 'Invalid resource status.', 'VALIDATION_ERROR')
    if (status !== 'available') {
      const activeBooking = await query("SELECT id FROM bookings WHERE resource_id = $1 AND status = 'checked_out' LIMIT 1", [resource.id])
      if (activeBooking.rows[0]) return fail(res, 409, 'A checked-out resource cannot be marked unavailable until it is returned.', 'RESOURCE_IN_USE')
      const upcomingBooking = await query("SELECT id FROM bookings WHERE resource_id = $1 AND start_date >= $2 AND status = 'approved' LIMIT 1", [
        resource.id,
        currentDateInCampusTime(),
      ])
      if (upcomingBooking.rows[0]) {
        return fail(res, 409, 'A resource with upcoming approved bookings cannot be marked unavailable. Add a specific time block or resolve those bookings first.', 'APPROVED_BOOKING_EXISTS')
      }
    }
    await query('UPDATE resources SET status = $1 WHERE id = $2', [status, resource.id])
    await addAudit(req.user, req.user.name, 'Resource status changed', resource.name, `Status changed from ${resource.status} to ${status}.`, resource.id)
    res.json({ resource: await getResourceById(resource.id) })
  } catch (err) {
    next(err)
  }
})

app.post('/api/resources/:id/blocks', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const resource = await getResourceById(req.params.id)
    if (!resource) return fail(res, 404, 'Resource not found.', 'NOT_FOUND')
    if (!checkOwner(req.user, resource)) return fail(res, 403, 'You can only schedule blocks for resources you own.', 'RESOURCE_FORBIDDEN')
    const startDate = String(req.body?.startDate || '')
    const startTime = String(req.body?.startTime || '')
    const endTime = String(req.body?.endTime || '')
    const reason = String(req.body?.reason || '')
      .trim()
      .slice(0, 300)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) ||
      endTime <= startTime ||
      timeValue(endTime) - timeValue(startTime) > 8 * 60 ||
      reason.length < 4
    ) {
      return fail(res, 400, 'Provide a valid date, time range of at most 8 hours, and a clear reason.', 'VALIDATION_ERROR')
    }
    const blockDateParts = startDate.split('-').map(Number)
    const blockDate = new Date(Date.UTC(blockDateParts[0], blockDateParts[1] - 1, blockDateParts[2]))
    if (blockDate.getUTCFullYear() !== blockDateParts[0] || blockDate.getUTCMonth() !== blockDateParts[1] - 1 || blockDate.getUTCDate() !== blockDateParts[2]) {
      return fail(res, 400, 'Choose a real calendar date for the maintenance block.', 'INVALID_DATE')
    }
    if (startDate < currentDateInCampusTime() || toEpoch(startDate, startTime) <= Date.now()) {
      return fail(res, 400, 'Blocks must start in the future.', 'PAST_TIME')
    }
    const bookingRes = await query(
      `SELECT id FROM bookings
       WHERE resource_id = $1 AND start_date = $2 AND status IN ('approved', 'checked_out')
         AND start_time < $3 AND end_time > $4 LIMIT 1`,
      [resource.id, startDate, endTime, startTime]
    )
    if (bookingRes.rows[0]) return fail(res, 409, 'The block overlaps an approved or checked-out booking.', 'SLOT_CONFLICT')

    const id = makeId('blk')
    await query(
      'INSERT INTO resource_blocks(id, resource_id, start_date, start_time, end_time, reason, created_by, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, resource.id, startDate, startTime, endTime, reason, req.user.id, nowIso()]
    )
    await addAudit(req.user, req.user.name, 'Resource time blocked', resource.name, `${startDate} ${startTime}–${endTime}: ${reason}`, resource.id)
    res.status(201).json({ id, startDate, startTime, endTime, reason })
  } catch (err) {
    next(err)
  }
})

app.get('/api/resources/:id/availability', requireAuth, async (req, res, next) => {
  try {
    const resource = await getResourceById(req.params.id)
    if (!resource) return fail(res, 404, 'Resource not found.', 'NOT_FOUND')
    const date = String(req.query?.date || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'Provide a valid date in YYYY-MM-DD format.', 'INVALID_DATE')
    const parts = date.split('-').map(Number)
    const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
    if (parsed.getUTCFullYear() !== parts[0] || parsed.getUTCMonth() !== parts[1] - 1 || parsed.getUTCDate() !== parts[2]) {
      return fail(res, 400, 'Choose a real calendar date.', 'INVALID_DATE')
    }

    const confirmedRes = await query(
      `SELECT start_time, end_time, status FROM bookings
       WHERE resource_id = $1 AND start_date = $2 AND status IN ('approved', 'checked_out')
       ORDER BY start_time`,
      [resource.id, date]
    )
    const pendingRes = await query(
      `SELECT start_time, end_time, status FROM bookings
       WHERE resource_id = $1 AND start_date = $2 AND status IN ('pending', 'waitlisted')
       ORDER BY created_at ASC`,
      [resource.id, date]
    )
    const blocksRes = await query(
      `SELECT start_time, end_time, reason FROM resource_blocks
       WHERE resource_id = $1 AND start_date = $2
       ORDER BY start_time`,
      [resource.id, date]
    )

    const eligibility = await eligibleUserForResource(req.user.id, resource)
    res.json({
      resourceId: resource.id,
      date,
      timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
      resourceStatus: resource.status,
      eligibility: { status: eligibility.passed ? 'eligible' : 'blocked', reason: eligibility.reason },
      confirmedSlots: confirmedRes.rows.map((row) => ({ startTime: row.start_time, endTime: row.end_time, status: row.status })),
      pendingRequests: pendingRes.rows.map((row) => ({ startTime: row.start_time, endTime: row.end_time, status: row.status })),
      maintenanceBlocks: blocksRes.rows.map((row) => ({ startTime: row.start_time, endTime: row.end_time, reason: row.reason })),
      checkedAt: nowIso(),
    })
  } catch (err) {
    next(err)
  }
})

app.post('/api/bookings', requireAuth, async (req, res, next) => {
  try {
    const resourceId = String(req.body?.resourceId || '')
    const startDate = String(req.body?.startDate || '')
    const startTime = String(req.body?.startTime || '')
    const endTime = String(req.body?.endTime || '')
    const purpose = String(req.body?.purpose || '')
      .trim()
      .slice(0, 800)
    const waitlist = Boolean(req.body?.waitlist)

    const resource = await getResourceById(resourceId)
    if (!resource) return fail(res, 404, 'Resource not found.', 'NOT_FOUND')
    if (req.user.verificationStatus !== 'verified') {
      return fail(res, 403, 'Your account is awaiting institutional verification. You can browse resources, but cannot submit booking requests yet.', 'VERIFICATION_REQUIRED')
    }
    if (resource.status !== 'available') return fail(res, 409, 'This resource is not currently available for new bookings.', 'RESOURCE_UNAVAILABLE')

    const eligibility = await eligibleUserForResource(req.user.id, resource)
    if (!eligibility.passed) return fail(res, 403, eligibility.reason, 'ELIGIBILITY_BLOCKED')

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
      return fail(res, 400, 'Choose a valid date and time.', 'VALIDATION_ERROR')
    }
    const dateParts = startDate.split('-').map(Number)
    const parsedDate = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]))
    if (parsedDate.getUTCFullYear() !== dateParts[0] || parsedDate.getUTCMonth() !== dateParts[1] - 1 || parsedDate.getUTCDate() !== dateParts[2]) {
      return fail(res, 400, 'Choose a real calendar date.', 'INVALID_DATE')
    }
    if (startDate < currentDateInCampusTime()) return fail(res, 400, 'Bookings cannot be made for a past date.', 'PAST_DATE')
    if (toEpoch(startDate, startTime) <= Date.now()) return fail(res, 400, 'Choose a start time in the future.', 'PAST_TIME')
    if (endTime <= startTime) return fail(res, 400, 'The end time must be later than the start time on the selected day.', 'INVALID_TIME_RANGE')
    if (timeValue(endTime) - timeValue(startTime) > 8 * 60) return fail(res, 400, 'A single booking may not exceed 8 hours.', 'DURATION_LIMIT')
    if (purpose.length < 4) return fail(res, 400, 'Describe the intended use of the resource.', 'VALIDATION_ERROR')

    // Concurrency-safe booking creation using row-level locking
    const booking = await withTransaction(async (client) => {
      await client.query('SELECT id FROM resources WHERE id = $1 FOR UPDATE', [resourceId])

      const hardConflictRes = await client.query(
        `SELECT id FROM bookings
         WHERE resource_id = $1 AND start_date = $2 AND status IN ('approved', 'checked_out')
           AND start_time < $3 AND end_time > $4
         LIMIT 1`,
        [resourceId, startDate, endTime, startTime]
      )
      const hardConflict = hardConflictRes.rows[0]

      const maintConflictRes = await client.query(
        `SELECT id, reason FROM resource_blocks
         WHERE resource_id = $1 AND start_date = $2 AND start_time < $3 AND end_time > $4
         LIMIT 1`,
        [resourceId, startDate, endTime, startTime]
      )
      const maintenanceConflict = maintConflictRes.rows[0]
      if (maintenanceConflict) {
        const err = new Error(`The selected time is blocked: ${maintenanceConflict.reason}`)
        err.status = 409
        err.code = 'RESOURCE_BLOCKED'
        throw err
      }
      if (hardConflict && !waitlist) {
        const err = new Error('That slot overlaps a confirmed booking. Join the waitlist to request the same time.')
        err.status = 409
        err.code = 'SLOT_CONFLICT'
        throw err
      }

      const activeRes = await client.query(
        `SELECT COUNT(*)::int as n FROM bookings
         WHERE user_id = $1 AND ((start_date >= $2 AND status IN ('pending', 'approved', 'waitlisted')) OR status = 'checked_out')`,
        [req.user.id, currentDateInCampusTime()]
      )
      if (activeRes.rows[0].n >= 3) {
        const err = new Error('Fair-use limit reached: each user may hold up to 3 active or upcoming reservations at a time. Complete, cancel or wait for existing requests to close.')
        err.status = 429
        err.code = 'FAIR_USE_LIMIT'
        throw err
      }

      const dupRes = await client.query(
        `SELECT id FROM bookings
         WHERE resource_id = $1 AND user_id = $2 AND start_date = $3 AND start_time = $4 AND end_time = $5
           AND status IN ('pending', 'approved', 'waitlisted', 'checked_out')
         LIMIT 1`,
        [resourceId, req.user.id, startDate, startTime, endTime]
      )
      if (dupRes.rows[0]) {
        const err = new Error('You already have an active request for this resource and time.')
        err.status = 409
        err.code = 'DUPLICATE_REQUEST'
        throw err
      }

      const id = makeId('bk')
      const status = waitlist || hardConflict ? 'waitlisted' : 'pending'
      const reason = status === 'waitlisted' ? 'Added to the transparent waitlist for this time slot.' : null
      const now = nowIso()

      await client.query(
        `INSERT INTO bookings(id, resource_id, user_id, start_date, start_time, end_time, purpose, status, decision_reason, created_at, updated_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, resourceId, req.user.id, startDate, startTime, endTime, purpose, status, reason, now, now]
      )

      await recordBookingEvent(
        req.user,
        { id, resourceId, resourceName: resource.name },
        status === 'waitlisted' ? 'Joined waitlist' : 'Booking requested',
        `${startDate} · ${startTime}–${endTime}. Purpose: ${purpose}`,
        client
      )
      await notify(
        resource.ownerId,
        id,
        'booking_request',
        status === 'waitlisted' ? 'Waitlist entry received' : 'Booking request received',
        `${req.user.name} requested ${resource.name} for ${startDate}, ${startTime}–${endTime}.`,
        client
      )

      return {
        id,
        resourceId,
        resourceName: resource.name,
        userId: req.user.id,
        userName: req.user.name,
        startDate,
        startTime,
        endTime,
        purpose,
        status,
        decisionReason: reason,
        createdAt: now,
      }
    })

    res.status(201).json({ booking })
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message, err.code)
    next(err)
  }
})

app.patch('/api/bookings/:id/status', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const nextStatus = String(req.body?.status || '')
    const reason = String(req.body?.reason || '')
      .trim()
      .slice(0, 500)
    if (!['approved', 'rejected', 'waitlisted', 'pending'].includes(nextStatus)) {
      return fail(res, 400, 'Invalid booking decision.', 'VALIDATION_ERROR')
    }

    await withTransaction(async (client) => {
      const bookingRes = await client.query(
        `SELECT b.*, r.owner_id, r.name as resource_name
         FROM bookings b
         JOIN resources r ON r.id = b.resource_id
         WHERE b.id = $1
         FOR UPDATE OF b`,
        [req.params.id]
      )
      const bookingRow = bookingRes.rows[0]
      if (!bookingRow) {
        const err = new Error('Booking not found.')
        err.status = 404
        err.code = 'NOT_FOUND'
        throw err
      }

      const resource = await getResourceById(bookingRow.resource_id, client)
      if (!checkOwner(req.user, resource)) {
        const err = new Error('Only the resource owner or an administrator may decide this request.')
        err.status = 403
        err.code = 'BOOKING_FORBIDDEN'
        throw err
      }

      if (['approved', 'pending'].includes(nextStatus) && resource.status !== 'available') {
        const err = new Error('This resource is not operational and cannot be approved for booking.')
        err.status = 409
        err.code = 'RESOURCE_UNAVAILABLE'
        throw err
      }
      if (!['pending', 'waitlisted'].includes(bookingRow.status)) {
        const err = new Error('This booking is no longer awaiting a decision.')
        err.status = 409
        err.code = 'BOOKING_STATE_CONFLICT'
        throw err
      }
      if (nextStatus === 'pending' && bookingRow.status !== 'waitlisted') {
        const err = new Error('Only a waitlisted request can be returned to owner review.')
        err.status = 400
        err.code = 'INVALID_TRANSITION'
        throw err
      }

      if (nextStatus === 'approved' || nextStatus === 'pending') {
        const eligibility = await eligibleUserForResource(bookingRow.user_id, resource, client)
        if (!eligibility.passed) {
          const err = new Error(`Cannot proceed: ${eligibility.reason}`)
          err.status = 403
          err.code = 'ELIGIBILITY_BLOCKED'
          throw err
        }

        const conflictRes = await client.query(
          `SELECT id FROM bookings
           WHERE resource_id = $1 AND start_date = $2 AND id <> $3
             AND status IN ('approved', 'checked_out')
             AND start_time < $4 AND end_time > $5
           LIMIT 1`,
          [bookingRow.resource_id, bookingRow.start_date, bookingRow.id, bookingRow.end_time, bookingRow.start_time]
        )
        if (conflictRes.rows[0]) {
          const err = new Error('Another confirmed booking occupies this slot. Keep the request waitlisted or choose another time.')
          err.status = 409
          err.code = 'SLOT_CONFLICT'
          throw err
        }

        const blockRes = await client.query(
          `SELECT reason FROM resource_blocks
           WHERE resource_id = $1 AND start_date = $2 AND start_time < $3 AND end_time > $4
           LIMIT 1`,
          [bookingRow.resource_id, bookingRow.start_date, bookingRow.end_time, bookingRow.start_time]
        )
        if (blockRes.rows[0]) {
          const err = new Error(`The requested slot is blocked: ${blockRes.rows[0].reason}`)
          err.status = 409
          err.code = 'RESOURCE_BLOCKED'
          throw err
        }
      }

      const now = nowIso()
      const decisionText =
        reason ||
        (nextStatus === 'approved'
          ? 'Approved by the authorised resource owner.'
          : nextStatus === 'rejected'
          ? 'Rejected by the authorised resource owner.'
          : nextStatus === 'waitlisted'
          ? 'Placed on the waitlist under the resource allocation policy.'
          : 'Returned to owner review from the waitlist.')

      await client.query('UPDATE bookings SET status = $1, decision_reason = $2, updated_at = $3 WHERE id = $4', [
        nextStatus,
        decisionText,
        now,
        bookingRow.id,
      ])

      const requesterUser = await userById(bookingRow.user_id, client)
      await recordBookingEvent(
        req.user,
        { id: bookingRow.id, resourceId: bookingRow.resource_id, resourceName: bookingRow.resource_name },
        `Booking ${nextStatus.replace('_', ' ')}`,
        `${bookingRow.user_name || requesterUser?.name || 'Requester'} · ${bookingRow.start_date}. ${decisionText}`,
        client
      )

      if (nextStatus === 'approved') {
        const competitorsRes = await client.query(
          `SELECT b.id, b.user_id, b.start_time, b.end_time
           FROM bookings b
           WHERE b.resource_id = $1 AND b.start_date = $2 AND b.id <> $3 AND b.status = 'pending'
             AND b.start_time < $4 AND b.end_time > $5
           FOR UPDATE`,
          [bookingRow.resource_id, bookingRow.start_date, bookingRow.id, bookingRow.end_time, bookingRow.start_time]
        )
        for (const competing of competitorsRes.rows) {
          const queueReason = 'Placed on the waitlist because a competing request was approved. The owner may review this queue if the slot becomes free.'
          await client.query('UPDATE bookings SET status = \'waitlisted\', decision_reason = $1, updated_at = $2 WHERE id = $3', [
            queueReason,
            now,
            competing.id,
          ])
          await notify(
            competing.user_id,
            competing.id,
            'booking_waitlisted',
            'Booking moved to waitlist',
            `${bookingRow.resource_name} at ${bookingRow.start_time}–${bookingRow.end_time} was allocated to another request. ${queueReason}`,
            client
          )
        }
      }

      await notify(
        bookingRow.user_id,
        bookingRow.id,
        `booking_${nextStatus}`,
        nextStatus === 'approved'
          ? 'Booking approved'
          : nextStatus === 'rejected'
          ? 'Booking rejected'
          : nextStatus === 'waitlisted'
          ? 'Booking waitlisted'
          : 'Booking returned to review',
        `${bookingRow.resource_name}: ${decisionText}`,
        client
      )
    })

    res.json({ ok: true, status: nextStatus })
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message, err.code)
    next(err)
  }
})

app.post('/api/bookings/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const rowRes = await query(
      `SELECT b.*, r.name as resource_name, r.owner_id
       FROM bookings b
       JOIN resources r ON r.id = b.resource_id
       WHERE b.id = $1`,
      [req.params.id]
    )
    const row = rowRes.rows[0]
    if (!row) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
    const isOwner = req.user.role === 'admin' || (req.user.role === 'owner' && row.owner_id === req.user.id)
    if (req.user.id !== row.user_id && !isOwner) return fail(res, 403, 'You cannot cancel another user’s booking.', 'BOOKING_FORBIDDEN')
    if (!['pending', 'approved', 'waitlisted'].includes(row.status)) {
      return fail(res, 409, 'This booking can no longer be cancelled.', 'INVALID_TRANSITION')
    }
    const reason = String(req.body?.reason || 'Cancelled by an authorised user.').slice(0, 300)
    const now = nowIso()
    await query("UPDATE bookings SET status = 'cancelled', decision_reason = $1, updated_at = $2 WHERE id = $3", [reason, now, row.id])
    await recordBookingEvent(req.user, { id: row.id, resourceId: row.resource_id, resourceName: row.resource_name }, 'Booking cancelled', reason)
    await notify(row.user_id, row.id, 'booking_cancelled', 'Booking cancelled', `${row.resource_name}: ${reason}`)
    if (row.owner_id !== row.user_id) {
      await notify(row.owner_id, row.id, 'booking_cancelled_owner', 'Booking cancelled by requester', `${row.resource_name}: ${reason}`)
    }
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.post('/api/bookings/:id/check-in', requireAuth, async (req, res, next) => {
  try {
    const rowRes = await query(
      `SELECT b.*, r.name as resource_name, r.owner_id
       FROM bookings b
       JOIN resources r ON r.id = b.resource_id
       WHERE b.id = $1`,
      [req.params.id]
    )
    const row = rowRes.rows[0]
    if (!row) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
    const canUse = req.user.role === 'admin' || req.user.id === row.user_id || (req.user.role === 'owner' && req.user.id === row.owner_id)
    if (!canUse) return fail(res, 403, 'You cannot check in this booking.', 'BOOKING_FORBIDDEN')
    if (row.status !== 'approved') return fail(res, 409, 'Only an approved booking can be checked out.', 'INVALID_TRANSITION')

    const resource = await getResourceById(row.resource_id)
    if (resource.status !== 'available') return fail(res, 409, 'This resource is not operational. Contact the owner before collection.', 'RESOURCE_UNAVAILABLE')
    const eligibility = await eligibleUserForResource(row.user_id, resource)
    if (!eligibility.passed) return fail(res, 403, `Access blocked: ${eligibility.reason}`, 'ELIGIBILITY_BLOCKED')

    const condition = ['good', 'minor', 'damage'].includes(req.body?.condition) ? req.body.condition : 'good'
    const notes = String(req.body?.notes || '')
      .trim()
      .slice(0, 1000)
    const now = nowIso()

    await withTransaction(async (client) => {
      await client.query("UPDATE bookings SET status = 'checked_out', condition_before = $1, condition_before_notes = $2, updated_at = $3 WHERE id = $4", [
        condition,
        notes,
        now,
        row.id,
      ])
      await client.query(
        'INSERT INTO condition_reports(id, booking_id, stage, condition, notes, created_by, created_at) VALUES($1, $2, $3, $4, $5, $6, $7)',
        [makeId('cr'), row.id, 'before', condition, notes, req.user.id, now]
      )
      await recordBookingEvent(
        req.user,
        { id: row.id, resourceId: row.resource_id, resourceName: row.resource_name },
        'Resource checked out',
        `Initial condition: ${condition}${notes ? ` · ${notes}` : ''}`,
        client
      )
      const borrower = await userById(row.user_id, client)
      await notify(row.owner_id, row.id, 'resource_checked_out', 'Resource checked out', `${row.resource_name} was checked out by ${borrower?.name || 'the requester'}.`, client)
    })

    res.json({ ok: true, status: 'checked_out' })
  } catch (err) {
    next(err)
  }
})

app.post('/api/bookings/:id/return', requireAuth, async (req, res, next) => {
  try {
    const rowRes = await query(
      `SELECT b.*, r.name as resource_name, r.owner_id
       FROM bookings b
       JOIN resources r ON r.id = b.resource_id
       WHERE b.id = $1`,
      [req.params.id]
    )
    const row = rowRes.rows[0]
    if (!row) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
    const canUse = req.user.role === 'admin' || req.user.id === row.user_id || (req.user.role === 'owner' && req.user.id === row.owner_id)
    if (!canUse) return fail(res, 403, 'You cannot return this booking.', 'BOOKING_FORBIDDEN')
    if (row.status !== 'checked_out') return fail(res, 409, 'Only a checked-out booking can be returned.', 'INVALID_TRANSITION')

    const condition = ['good', 'minor', 'damage'].includes(req.body?.condition) ? req.body.condition : null
    if (!condition) return fail(res, 400, 'Choose the return condition.', 'VALIDATION_ERROR')
    const notes = String(req.body?.notes || '')
      .trim()
      .slice(0, 1000)
    if (condition !== 'good' && notes.length < 4) return fail(res, 400, 'Describe the issue observed at return.', 'CONDITION_NOTES_REQUIRED')
    const now = nowIso()

    await withTransaction(async (client) => {
      await client.query("UPDATE bookings SET status = 'returned', condition_after = $1, condition_after_notes = $2, updated_at = $3 WHERE id = $4", [
        condition,
        notes,
        now,
        row.id,
      ])
      await client.query(
        'INSERT INTO condition_reports(id, booking_id, stage, condition, notes, created_by, created_at) VALUES($1, $2, $3, $4, $5, $6, $7)',
        [makeId('cr'), row.id, 'after', condition, notes, req.user.id, now]
      )
      await client.query('UPDATE resources SET uses = uses + 1 WHERE id = $1', [row.resource_id])
      await recordBookingEvent(
        req.user,
        { id: row.id, resourceId: row.resource_id, resourceName: row.resource_name },
        'Resource returned',
        `Final condition: ${condition}${notes ? ` · ${notes}` : ''}`,
        client
      )
      await notify(row.owner_id, row.id, 'resource_returned', 'Resource return recorded', `${row.resource_name} was returned. Condition: ${condition}.`, client)

      if (condition !== 'good') {
        const incidentId = makeId('inc')
        const severity = condition === 'damage' ? 'high' : 'low'
        const description = notes || 'A condition issue was noted during return.'
        await client.query(
          'INSERT INTO incidents(id, booking_id, reporter_id, description, severity, status, created_at) VALUES($1, $2, $3, $4, $5, $6, $7)',
          [incidentId, row.id, req.user.id, description, severity, 'open', now]
        )
        await addAudit(req.user, req.user.name, 'Incident opened', row.resource_name, description, row.resource_id, row.id, client)
        await notify(row.owner_id, row.id, 'incident_reported', 'Return issue needs review', `${row.resource_name}: ${description}`, client)
      }
    })

    res.json({ ok: true, status: 'returned' })
  } catch (err) {
    next(err)
  }
})

app.post('/api/bookings/:id/extension', requireAuth, async (req, res, next) => {
  try {
    const rowRes = await query(
      `SELECT b.*, r.name as resource_name, r.owner_id
       FROM bookings b
       JOIN resources r ON r.id = b.resource_id
       WHERE b.id = $1`,
      [req.params.id]
    )
    const row = rowRes.rows[0]
    if (!row) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
    if (req.user.id !== row.user_id) return fail(res, 403, 'Only the requester can ask to extend this booking.', 'BOOKING_FORBIDDEN')
    if (row.status !== 'checked_out') return fail(res, 409, 'Extensions can only be requested while a resource is checked out.', 'INVALID_TRANSITION')

    const requestedEndTime = String(req.body?.requestedEndTime || '')
    const reason = String(req.body?.reason || '')
      .trim()
      .slice(0, 500)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedEndTime)) return fail(res, 400, 'Choose a valid requested end time.', 'VALIDATION_ERROR')
    if (requestedEndTime <= row.end_time) return fail(res, 400, 'The requested extension must end later than the current return time.', 'INVALID_EXTENSION')
    if (timeValue(requestedEndTime) - timeValue(row.start_time) > 8 * 60) {
      return fail(res, 400, 'The total booking duration cannot exceed 8 hours.', 'DURATION_LIMIT')
    }
    if (toEpoch(row.start_date, requestedEndTime) <= Date.now()) return fail(res, 400, 'The requested end time must be in the future.', 'PAST_TIME')
    if (reason.length < 4) return fail(res, 400, 'Explain why the extension is needed.', 'VALIDATION_ERROR')

    const pendingRes = await query("SELECT id FROM booking_extensions WHERE booking_id = $1 AND status = 'pending' LIMIT 1", [row.id])
    if (pendingRes.rows[0]) return fail(res, 409, 'An extension request is already awaiting a decision.', 'EXTENSION_PENDING')

    const conflictRes = await query(
      `SELECT id FROM bookings
       WHERE resource_id = $1 AND start_date = $2 AND id <> $3
         AND status IN ('approved', 'checked_out')
         AND start_time < $4 AND end_time > $5
       LIMIT 1`,
      [row.resource_id, row.start_date, row.id, requestedEndTime, row.start_time]
    )
    if (conflictRes.rows[0]) {
      return fail(res, 409, 'The extension overlaps another confirmed booking. Request a shorter extension or arrange another slot.', 'SLOT_CONFLICT')
    }

    const id = makeId('ext')
    const now = nowIso()
    await query(
      `INSERT INTO booking_extensions(id, booking_id, requested_by, original_end_time, requested_end_time, reason, status, created_at)
       VALUES($1, $2, $3, $4, $5, $6, 'pending', $7)`,
      [id, row.id, req.user.id, row.end_time, requestedEndTime, reason, now]
    )
    await addAudit(
      req.user,
      req.user.name,
      'Extension requested',
      row.resource_name,
      `Current end: ${row.end_time}; requested end: ${requestedEndTime}. Reason: ${reason}`,
      row.resource_id,
      row.id
    )
    await notify(row.owner_id, row.id, 'extension_request', 'Booking extension requires review', `${row.resource_name}: ${req.user.name} requested an extension to ${requestedEndTime}. ${reason}`)
    res.status(201).json({ id, status: 'pending', requestedEndTime })
  } catch (err) {
    next(err)
  }
})

app.patch('/api/extensions/:id/decision', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const extRes = await query(
      `SELECT e.*, b.resource_id, b.user_id, b.start_date, b.start_time, b.end_time as current_end_time, b.status as booking_status,
              r.name as resource_name, r.owner_id, u.name as user_name
       FROM booking_extensions e
       JOIN bookings b ON b.id = e.booking_id
       JOIN resources r ON r.id = b.resource_id
       JOIN users u ON u.id = b.user_id
       WHERE e.id = $1`,
      [req.params.id]
    )
    const ext = extRes.rows[0]
    if (!ext) return fail(res, 404, 'Extension request not found.', 'NOT_FOUND')

    const resource = await getResourceById(ext.resource_id)
    if (!checkOwner(req.user, resource)) return fail(res, 403, 'Only the resource owner or an administrator can decide this extension.', 'BOOKING_FORBIDDEN')
    if (ext.status !== 'pending') return fail(res, 409, 'This extension request has already been decided.', 'INVALID_TRANSITION')

    const decision = req.body?.status
    const reason = String(req.body?.reason || '')
      .trim()
      .slice(0, 500)
    if (!['approved', 'rejected'].includes(decision)) return fail(res, 400, 'Choose approve or reject.', 'VALIDATION_ERROR')

    if (decision === 'approved') {
      if (ext.booking_status !== 'checked_out') return fail(res, 409, 'The booking is no longer checked out; the extension cannot be approved.', 'INVALID_TRANSITION')
      if (ext.requested_end_time <= ext.current_end_time) return fail(res, 409, 'The requested end time is no longer later than the current return time.', 'INVALID_EXTENSION')

      const conflictRes = await query(
        `SELECT id FROM bookings
         WHERE resource_id = $1 AND start_date = $2 AND id <> $3
           AND status IN ('approved', 'checked_out')
           AND start_time < $4 AND end_time > $5
         LIMIT 1`,
        [ext.resource_id, ext.start_date, ext.booking_id, ext.requested_end_time, ext.start_time]
      )
      if (conflictRes.rows[0]) return fail(res, 409, 'The extension now conflicts with another confirmed booking.', 'SLOT_CONFLICT')

      const blockRes = await query(
        `SELECT reason FROM resource_blocks
         WHERE resource_id = $1 AND start_date = $2 AND start_time < $3 AND end_time > $4
         LIMIT 1`,
        [ext.resource_id, ext.start_date, ext.requested_end_time, ext.current_end_time]
      )
      if (blockRes.rows[0]) return fail(res, 409, `The extension overlaps a scheduled block: ${blockRes.rows[0].reason}`, 'RESOURCE_BLOCKED')

      if (toEpoch(ext.start_date, ext.requested_end_time) <= Date.now()) {
        return fail(res, 409, 'The requested end time has passed; the extension cannot be approved.', 'PAST_TIME')
      }
    }

    await withTransaction(async (client) => {
      const now = nowIso()
      const decisionReason = reason || (decision === 'approved' ? 'Extension approved by the authorised resource owner.' : 'Extension rejected by the authorised resource owner.')
      await client.query('UPDATE booking_extensions SET status = $1, decision_reason = $2, decided_by = $3, decided_at = $4 WHERE id = $5', [
        decision,
        decisionReason,
        req.user.id,
        now,
        ext.id,
      ])
      if (decision === 'approved') {
        await client.query('UPDATE bookings SET end_time = $1, updated_at = $2 WHERE id = $3', [ext.requested_end_time, now, ext.booking_id])
      }
      await addAudit(
        req.user,
        req.user.name,
        `Extension ${decision}`,
        ext.resource_name,
        `${ext.user_name}: ${ext.current_end_time} → ${ext.requested_end_time}. ${decisionReason}`,
        ext.resource_id,
        ext.booking_id,
        client
      )
      await notify(
        ext.user_id,
        ext.booking_id,
        `extension_${decision}`,
        decision === 'approved' ? 'Booking extension approved' : 'Booking extension rejected',
        `${ext.resource_name}: ${decisionReason}`,
        client
      )
    })

    res.json({ ok: true, status: decision })
  } catch (err) {
    next(err)
  }
})

app.post('/api/incidents', requireAuth, async (req, res, next) => {
  try {
    const bookingId = String(req.body?.bookingId || '')
    const description = String(req.body?.description || '')
      .trim()
      .slice(0, 2000)
    const severity = ['low', 'medium', 'high'].includes(req.body?.severity) ? req.body.severity : 'medium'
    if (description.length < 5) return fail(res, 400, 'Describe what happened (at least 5 characters).', 'VALIDATION_ERROR')

    const rowRes = await query(
      `SELECT b.*, r.name as resource_name, r.owner_id
       FROM bookings b
       JOIN resources r ON r.id = b.resource_id
       WHERE b.id = $1`,
      [bookingId]
    )
    const row = rowRes.rows[0]
    if (!row) return fail(res, 404, 'Related booking not found.', 'NOT_FOUND')
    const canReport = req.user.role === 'admin' || req.user.id === row.user_id || (req.user.role === 'owner' && req.user.id === row.owner_id)
    if (!canReport) return fail(res, 403, 'Incident reports must be tied to a booking you are authorised to access.', 'INCIDENT_FORBIDDEN')

    const id = makeId('inc')
    const now = nowIso()
    await query(
      'INSERT INTO incidents(id, booking_id, reporter_id, description, severity, status, created_at) VALUES($1, $2, $3, $4, $5, $6, $7)',
      [id, bookingId, req.user.id, description, severity, 'open', now]
    )
    await addAudit(req.user, req.user.name, 'Incident reported', row.resource_name, description, row.resource_id, row.id)
    await notify(row.owner_id, row.id, 'incident_reported', 'Incident requires review', `${row.resource_name}: ${description}`)
    res.status(201).json({ id })
  } catch (err) {
    next(err)
  }
})

app.patch('/api/incidents/:id/resolve', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const incRes = await query(
      `SELECT i.*, b.resource_id, r.owner_id, r.name as resource_name
       FROM incidents i
       JOIN bookings b ON b.id = i.booking_id
       JOIN resources r ON r.id = b.resource_id
       WHERE i.id = $1`,
      [req.params.id]
    )
    const incident = incRes.rows[0]
    if (!incident) return fail(res, 404, 'Incident not found.', 'NOT_FOUND')
    if (req.user.role === 'owner' && incident.owner_id !== req.user.id) {
      return fail(res, 403, 'Only the resource owner or an administrator may resolve this incident.', 'INCIDENT_FORBIDDEN')
    }
    const resolution = String(req.body?.resolution || '')
      .trim()
      .slice(0, 1000)
    if (resolution.length < 4) return fail(res, 400, 'Enter a resolution note for the audit trail.', 'VALIDATION_ERROR')
    if (incident.status === 'resolved') return fail(res, 409, 'This incident is already resolved.', 'INVALID_TRANSITION')

    const now = nowIso()
    await query('UPDATE incidents SET status = \'resolved\', resolution = $1, resolved_by = $2, resolved_at = $3 WHERE id = $4', [
      resolution,
      req.user.id,
      now,
      incident.id,
    ])
    await addAudit(req.user, req.user.name, 'Incident resolved', incident.resource_name, resolution, incident.resource_id, incident.booking_id)

    const bookingRes = await query('SELECT user_id FROM bookings WHERE id = $1', [incident.booking_id])
    if (bookingRes.rows[0]) {
      await notify(bookingRes.rows[0].user_id, incident.booking_id, 'incident_resolved', 'Incident review completed', `${incident.resource_name}: ${resolution}`)
    }
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.get('/api/users', requireAuth, requireRole('admin'), async (_req, res, next) => {
  try {
    const users = await directoryUsers()
    res.json({ users })
  } catch (err) {
    next(err)
  }
})

app.patch('/api/users/:id/verification', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const status = req.body?.status
    if (!['verified', 'rejected', 'pending'].includes(status)) return fail(res, 400, 'Invalid verification status.', 'VALIDATION_ERROR')
    const userRes = await query('SELECT id, name, email, role, verification_status FROM users WHERE id = $1', [req.params.id])
    const row = userRes.rows[0]
    if (!row) return fail(res, 404, 'User not found.', 'NOT_FOUND')
    if (row.role !== 'student') return fail(res, 400, 'Only student profiles can be verified from this screen.', 'INVALID_USER_TYPE')

    const now = nowIso()
    const title = status === 'verified' ? 'Student · Verified' : 'Student · Awaiting verification'
    await query('UPDATE users SET verification_status = $1, verified_at = $2, verified_by = $3, title = $4 WHERE id = $5', [
      status,
      status === 'verified' ? now : null,
      status === 'verified' ? req.user.id : null,
      title,
      row.id,
    ])
    await addAudit(req.user, req.user.name, `User verification ${status}`, row.name, `Institutional verification status changed from ${row.verification_status} to ${status}.`)
    await notify(
      row.id,
      null,
      `verification_${status}_${now.slice(0, 10)}`,
      status === 'verified' ? 'Account verified' : status === 'rejected' ? 'Account verification rejected' : 'Verification reopened',
      status === 'verified'
        ? 'Your profile is verified. You can now submit resource requests subject to each resource policy.'
        : status === 'rejected'
        ? 'Your account could not be verified. Contact the campus administrator for review.'
        : 'Your profile requires further institutional verification.'
    )
    res.json({ ok: true, status })
  } catch (err) {
    next(err)
  }
})

app.patch('/api/users/:id/role', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const role = req.body?.role
    if (!['student', 'owner'].includes(role)) return fail(res, 400, 'Only student and resource-owner roles can be assigned here.', 'VALIDATION_ERROR')
    const userRes = await query('SELECT id, name, email, role, verification_status FROM users WHERE id = $1', [req.params.id])
    const row = userRes.rows[0]
    if (!row) return fail(res, 404, 'User not found.', 'NOT_FOUND')
    if (row.role === 'admin') return fail(res, 400, 'Administrator accounts cannot be changed from this control.', 'INVALID_USER_TYPE')
    if (role === 'owner' && row.verification_status !== 'verified') {
      return fail(res, 409, 'Verify institutional membership before granting resource-owner privileges.', 'VERIFICATION_REQUIRED')
    }
    if (role === 'student' && row.role === 'owner') {
      const ownedRes = await query('SELECT COUNT(*)::int as n FROM resources WHERE owner_id = $1', [row.id])
      if (ownedRes.rows[0].n > 0) return fail(res, 409, 'Transfer this owner’s resources to another authorised owner before removing the role.', 'OWNER_HAS_RESOURCES')
    }

    const title = role === 'owner' ? 'Resource owner · Verified' : row.verification_status === 'verified' ? 'Student · Verified' : 'Student · Awaiting verification'
    await query('UPDATE users SET role = $1, title = $2 WHERE id = $3', [role, title, row.id])
    await addAudit(req.user, req.user.name, 'User role changed', row.name, `Role changed from ${row.role} to ${role}.`)
    await notify(row.id, null, `role_changed_${nowIso().slice(0, 10)}`, 'Account role updated', `Your account role is now ${role === 'owner' ? 'Resource owner' : 'Student'}.`)
    res.json({ ok: true, role })
  } catch (err) {
    next(err)
  }
})

app.put('/api/users/:id/training', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const userRes = await query('SELECT id, name, role, verification_status FROM users WHERE id = $1', [req.params.id])
    const user = userRes.rows[0]
    if (!user) return fail(res, 404, 'User not found.', 'NOT_FOUND')
    if (!['student', 'owner'].includes(user.role)) return fail(res, 400, 'Training records can only be assigned to a student or resource owner.', 'INVALID_USER_TYPE')
    const code = String(req.body?.trainingCode || '')
      .trim()
      .toLowerCase()
      .replaceAll(' ', '-')
    const status = req.body?.status
    if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(code)) return fail(res, 400, 'Use a training identifier containing 3–80 letters, numbers or hyphens.', 'VALIDATION_ERROR')
    if (!['verified', 'expired'].includes(status)) return fail(res, 400, 'Training status must be verified or expired.', 'VALIDATION_ERROR')
    if (status === 'verified' && user.verification_status !== 'verified') {
      return fail(res, 409, 'Verify the user’s institutional profile before granting training.', 'VERIFICATION_REQUIRED')
    }

    const now = nowIso()
    await query(
      `INSERT INTO training_records(id, user_id, training_code, status, valid_until, verified_by, created_at)
       VALUES($1, $2, $3, $4, NULL, $5, $6)
       ON CONFLICT (user_id, training_code) DO UPDATE
       SET status = EXCLUDED.status, valid_until = EXCLUDED.valid_until, verified_by = EXCLUDED.verified_by, created_at = EXCLUDED.created_at`,
      [makeId('trn'), user.id, code, status, status === 'verified' ? req.user.id : null, now]
    )

    await addAudit(req.user, req.user.name, status === 'verified' ? 'Training verified' : 'Training revoked', user.name, `${code} training record set to ${status}.`)
    await notify(
      user.id,
      null,
      `training_${code}_${status}_${now.slice(0, 10)}`,
      status === 'verified' ? 'Training record verified' : 'Training access revoked',
      `${code} is now ${status}. Resource eligibility will reflect this record.`
    )
    res.json({ ok: true, trainingCode: code, status, trainingCodes: await trainingCodesForUser(user.id) })
  } catch (err) {
    next(err)
  }
})

app.patch('/api/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const result = await query('UPDATE notifications SET read_at = $1 WHERE id = $2 AND user_id = $3', [nowIso(), req.params.id, req.user.id])
    if (!result.rowCount) return fail(res, 404, 'Notification not found.', 'NOT_FOUND')
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.get('/api/audit.csv', requireAuth, async (req, res, next) => {
  try {
    const ws = await makeWorkspace(req.user)
    const data = ws.audit
    const headers = ['Timestamp', 'Actor', 'Action', 'Target', 'Details']
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const csv = [headers, ...data.map((row) => [row.createdAt, row.actor, row.action, row.target, row.detail])].map((row) => row.map(escape).join(',')).join('\r\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="campushare-audit-log.csv"')
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

// Production static assets and SPA fallback
app.use(express.static(path.join(projectRoot, 'dist'), { index: false, maxAge: isProduction ? '1h' : 0 }))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  const indexFile = path.join(projectRoot, 'dist', 'index.html')
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile)
  return res.status(404).send('CampusShare X frontend is not built yet. In development, run npm run dev. For production, run npm run build first.')
})

app.use((err, _req, res, _next) => {
  console.error('[CampusShare Server Error]', err)
  if (res.headersSent) return
  res.status(500).json({ error: 'Unexpected server error. Check the server log for details.', code: 'INTERNAL_ERROR' })
})

let reminderTimer = null

export async function startServer() {
  await runMigrations()
  await runSeed()

  reminderTimer = setInterval(() => {
    generateScheduledNotifications().catch((err) => console.error('[Scheduled Notification Error]:', err.message))
  }, 60_000)
  reminderTimer.unref()

  const port = Number(process.env.PORT || 3001)
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`CampusShare X server listening on http://localhost:${port} (PostgreSQL connection pool active)`)
  })
  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    console.error('Failed to start CampusShare X server:', err)
    process.exit(1)
  })
}

export { app, query, closeDb, runMigrations, runSeed }
export default app
