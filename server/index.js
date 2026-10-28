import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data')
fs.mkdirSync(dataDir, { recursive: true })
const dbFile = process.env.DATABASE_FILE || path.join(dataDir, 'campushare.sqlite')
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

const COOKIE_NAME = 'campus_session'
const SESSION_DAYS = 7
const TZ_OFFSET = Number(process.env.BOOKING_TIMEZONE_OFFSET_MINUTES || 330)
const isProduction = process.env.NODE_ENV === 'production'

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','owner','admin')),
  title TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')),
  verified_at TEXT,
  verified_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  capability_tags TEXT NOT NULL DEFAULT '[]',
  required_training TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','maintenance','inactive')),
  icon TEXT NOT NULL DEFAULT 'package',
  gradient TEXT NOT NULL DEFAULT 'violet',
  asset_code TEXT NOT NULL UNIQUE,
  uses INTEGER NOT NULL DEFAULT 0,
  instructions TEXT NOT NULL DEFAULT '',
  value_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_id);
CREATE TABLE IF NOT EXISTS training_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  training_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verified','expired','rejected')),
  valid_until TEXT,
  verified_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, training_code)
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','waitlisted','checked_out','returned','cancelled')),
  decision_reason TEXT,
  condition_before TEXT,
  condition_before_notes TEXT,
  condition_after TEXT,
  condition_after_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_resource_schedule ON bookings(resource_id, start_date, status, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id, created_at);
CREATE TABLE IF NOT EXISTS condition_reports (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  stage TEXT NOT NULL CHECK (stage IN ('before','after')),
  condition TEXT NOT NULL CHECK (condition IN ('good','minor','damage')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  reporter_id TEXT NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','resolved')),
  resolution TEXT,
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, created_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL,
  resource_id TEXT REFERENCES resources(id),
  booking_id TEXT REFERENCES bookings(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, booking_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
CREATE TABLE IF NOT EXISTS resource_blocks (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS booking_extensions (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id),
  original_end_time TEXT NOT NULL,
  requested_end_time TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decision_reason TEXT,
  decided_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_booking_extensions_booking ON booking_extensions(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_extensions_status ON booking_extensions(status, created_at ASC);
`
db.exec(schema)

const nowIso = () => new Date().toISOString()
const makeId = prefix => `${prefix}_${crypto.randomBytes(9).toString('hex')}`
const hashToken = value => crypto.createHash('sha256').update(value).digest('hex')
const encodeJson = value => JSON.stringify(value ?? [])
const decodeJson = value => { try { return JSON.parse(value || '[]') } catch { return [] } }
const titleForRole = role => ({ student: 'Student', owner: 'Resource owner', admin: 'Campus administrator' })[role] || 'Member'
const initialsFor = name => String(name || 'User').split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase()

function ensureSeedUsers() {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return
  if (isProduction && process.env.SEED_INITIAL_ACCOUNTS !== 'true') {
    throw new Error('No users exist. Set SEED_INITIAL_ACCOUNTS=true and provide unique INITIAL_* credentials for first deployment.')
  }
  const defaults = isProduction ? {} : {
    studentEmail: 'student@campusshare.local', studentPassword: 'CampusStudent!2026',
    secondStudentEmail: 'student2@campusshare.local', secondStudentPassword: 'CampusStudent2!2026',
    ownerEmail: 'owner@campusshare.local', ownerPassword: 'CampusOwner!2026',
    adminEmail: 'admin@campusshare.local', adminPassword: 'CampusAdmin!2026',
  }
  const config = {
    studentEmail: process.env.INITIAL_STUDENT_EMAIL || defaults.studentEmail,
    studentPassword: process.env.INITIAL_STUDENT_PASSWORD || defaults.studentPassword,
    secondStudentEmail: process.env.INITIAL_STUDENT2_EMAIL || defaults.secondStudentEmail,
    secondStudentPassword: process.env.INITIAL_STUDENT2_PASSWORD || defaults.secondStudentPassword,
    ownerEmail: process.env.INITIAL_OWNER_EMAIL || defaults.ownerEmail,
    ownerPassword: process.env.INITIAL_OWNER_PASSWORD || defaults.ownerPassword,
    adminEmail: process.env.INITIAL_ADMIN_EMAIL || defaults.adminEmail,
    adminPassword: process.env.INITIAL_ADMIN_PASSWORD || defaults.adminPassword,
  }
  const required = ['studentEmail','studentPassword','ownerEmail','ownerPassword','adminEmail','adminPassword']
  if (required.some(key => !config[key] || String(config[key]).length < (key.endsWith('Password') ? 12 : 5))) {
    throw new Error('Initial account credentials are missing or too short. Set INITIAL_STUDENT/OWNER/ADMIN_EMAIL and INITIAL_STUDENT/OWNER/ADMIN_PASSWORD (passwords must be at least 12 characters).')
  }
  const insert = db.prepare(`INSERT INTO users(id,name,email,password_hash,role,title,verification_status,verified_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
  const timestamp = nowIso()
  const users = [
    ['student-aarav', 'Aarav Menon', config.studentEmail, config.studentPassword, 'student', 'Student · Project team'],
    ['owner-meera', 'Dr. Meera Iyer', config.ownerEmail, config.ownerPassword, 'owner', 'Resource owner'],
    ['admin-nikhil', 'Nikhil Rao', config.adminEmail, config.adminPassword, 'admin', 'Campus administrator'],
  ]
  if (config.secondStudentEmail && config.secondStudentPassword) {
    users.push(['student-diya', 'Diya Sharma', config.secondStudentEmail, config.secondStudentPassword, 'student', 'Student · Research team'])
  }
  const seedUsers = db.transaction(() => {
    for (const [id, name, email, password, role, title] of users) {
      insert.run(id, name, email, bcrypt.hashSync(password, 12), role, title, 'verified', timestamp, timestamp)
    }
  })
  seedUsers()
}

function ensureSeedResources() {
  if (db.prepare('SELECT COUNT(*) n FROM resources').get().n > 0) return
  if (isProduction && process.env.SEED_INITIAL_RESOURCES !== 'true') return
  const owner = db.prepare("SELECT id,name FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get()
  if (!owner) return
  const resources = [
    { id:'res-esp32',name:'ESP32 IoT Starter Kit',category:'Electronics',description:'Wi-Fi and Bluetooth microcontroller board with basic prototyping accessories.',location:'Innovation Lab · B-204',tags:['iot','microcontroller','sensor','programming','prototype','electronics'],training:[],status:'available',icon:'cpu',gradient:'violet',asset:'CSX-EL-042',instructions:'Return all jumper wires and sensors to the labelled tray. Keep power within the kit rating.',label:'Starter kit' },
    { id:'res-sensor',name:'Sensor & Breadboard Kit',category:'Electronics',description:'Breadboard, jumper wires, LEDs, resistors and common environmental sensors.',location:'Innovation Lab · B-204',tags:['iot','sensor','prototype','circuit','electronics','breadboard'],training:[],status:'available',icon:'zap',gradient:'amber',asset:'CSX-EL-057',instructions:'Count components before returning. Store sensor modules in their labelled compartments.',label:'Component kit' },
    { id:'res-multimeter',name:'Digital Multimeter',category:'Testing',description:'Handheld instrument for voltage, resistance and continuity measurements.',location:'Electronics Store · C-110',tags:['testing','measurement','voltage','circuit','debugging','electronics'],training:[],status:'available',icon:'activity',gradient:'blue',asset:'CSX-TM-014',instructions:'Inspect probe insulation before use. Return both probes with the instrument.',label:'Test instrument' },
    { id:'res-scope',name:'Digital Oscilloscope',category:'Testing',description:'Bench oscilloscope for signal, timing and communication debugging.',location:'Advanced Electronics Lab · C-212',tags:['testing','signal','measurement','circuit','debugging','electronics'],training:['lab-safety'],status:'available',icon:'activity',gradient:'teal',asset:'CSX-TM-006',instructions:'Lab safety induction is mandatory. Use approved probes and remain within rated limits.',label:'Restricted instrument' },
    { id:'res-camera',name:'DSLR Camera Kit',category:'Media',description:'Camera body, lens, battery, charger and tripod for project documentation.',location:'Media Desk · A-105',tags:['video','camera','recording','documentation','photography'],training:[],status:'available',icon:'camera',gradient:'rose',asset:'CSX-MD-021',instructions:'Keep the lens cap on when not in use. Return the battery and charger with the kit.',label:'Media kit' },
    { id:'res-laptop',name:'Development Laptop',category:'Computing',description:'Configured laptop for software development, embedded tooling and project presentations.',location:'Computing Hub · D-301',tags:['programming','development','iot','coding','prototype','computing'],training:[],status:'available',icon:'laptop',gradient:'indigo',asset:'CSX-IT-018',instructions:'Save work to your own storage and sign out of all accounts before return.',label:'Computing device' },
    { id:'res-room',name:'Project Collaboration Room',category:'Spaces',description:'Four-person project room with display, whiteboard and video-conference setup.',location:'Learning Commons · Level 2',tags:['meeting','team','presentation','collaboration','project','room'],training:[],status:'available',icon:'door',gradient:'green',asset:'CSX-SP-011',instructions:'Leave the room ready for the next group and clear the whiteboard.',label:'Bookable space' },
    { id:'res-solder',name:'Soldering Workstation',category:'Lab equipment',description:'Supervised soldering station with fume extraction and basic hand tools.',location:'Fabrication Lab · F-108',tags:['electronics','soldering','circuit','prototype','fabrication'],training:['soldering-safety'],status:'maintenance',icon:'wrench',gradient:'slate',asset:'CSX-FB-009',instructions:'Training and staff supervision are required. The resource is currently in maintenance.',label:'Supervised workstation' },
  ]
  const insert = db.prepare(`INSERT INTO resources(id,name,category,description,location,owner_id,capability_tags,required_training,status,icon,gradient,asset_code,uses,instructions,value_label,created_at) VALUES(@id,@name,@category,@description,@location,@ownerId,@tags,@training,@status,@icon,@gradient,@asset,@uses,@instructions,@label,@createdAt)`)
  const tx = db.transaction(() => {
    for (const r of resources) {
      insert.run({ ...r, ownerId: owner.id, tags: encodeJson(r.tags), training: encodeJson(r.training), uses: 0, createdAt: nowIso() })
      addAudit(null, 'System', 'Resource registered', r.name, 'Initial resource catalogue record created.', r.id, null)
    }
  })
  tx()
  // Do not auto-grant training in seed data. An authorised administrator must verify it.
}

function addAudit(actor, actorName, action, target, detail, resourceId = null, bookingId = null) {
  db.prepare(`INSERT INTO audit_events(id,actor_id,actor_name,action,target,detail,resource_id,booking_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(makeId('evt'), actor?.id || null, actorName || 'System', action, target, detail || '', resourceId, bookingId, nowIso())
}
function notify(userId, bookingId, kind, title, body) {
  if (!userId) return
  db.prepare(`INSERT OR IGNORE INTO notifications(id,user_id,booking_id,kind,title,body,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(makeId('ntf'), userId, bookingId || null, kind, title, body, nowIso())
}
ensureSeedUsers()
ensureSeedResources()

function rowUser(row) {
  if (!row) return null
  const codes = db.prepare(`SELECT training_code FROM training_records WHERE user_id=? AND status='verified' AND (valid_until IS NULL OR valid_until >= date('now'))`).all(row.id).map(x => x.training_code)
  return {
    id: row.id, name: row.name, email: row.email, role: row.role,
    title: row.title || titleForRole(row.role), initials: initialsFor(row.name),
    verificationStatus: row.verification_status, trainingCodes: codes,
    createdAt: row.created_at,
  }
}
function userById(id) { return rowUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) }
function trainingCodesForUser(userId) {
  return db.prepare(`SELECT training_code FROM training_records WHERE user_id=? AND status='verified' AND (valid_until IS NULL OR valid_until >= date('now')) ORDER BY training_code`).all(userId).map(row => row.training_code)
}
function directoryUsers() {
  return db.prepare(`SELECT id,name,email,role,verification_status,created_at FROM users ORDER BY CASE verification_status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC`).all().map(row => ({
    id: row.id, name: row.name, email: row.email, role: row.role, verificationStatus: row.verification_status,
    trainingCodes: trainingCodesForUser(row.id), createdAt: row.created_at,
  }))
}
function resourceView(row) {
  return {
    id: row.id, name: row.name, category: row.category, description: row.description, location: row.location,
    ownerId: row.owner_id, ownerName: row.owner_name || 'Resource owner', capabilityTags: decodeJson(row.capability_tags),
    requiredTraining: decodeJson(row.required_training), status: row.status, icon: row.icon, gradient: row.gradient,
    assetCode: row.asset_code, uses: row.uses, instructions: row.instructions, valueLabel: row.value_label,
  }
}
function getResourceRows() {
  return db.prepare(`SELECT r.*,u.name owner_name FROM resources r JOIN users u ON u.id=r.owner_id ORDER BY CASE r.status WHEN 'available' THEN 0 WHEN 'maintenance' THEN 1 ELSE 2 END, r.name`).all()
}
function getResourceById(id) {
  const row = db.prepare(`SELECT r.*,u.name owner_name FROM resources r JOIN users u ON u.id=r.owner_id WHERE r.id=?`).get(id)
  return row ? resourceView(row) : null
}
function eligibleUserForResource(userId, resource) {
  const userRow = db.prepare('SELECT * FROM users WHERE id=?').get(userId)
  if (!userRow || userRow.verification_status !== 'verified') return { passed: false, reason: 'Institutional profile verification is required.' }
  const codes = rowUser(userRow).trainingCodes
  const missing = resource.requiredTraining.filter(code => !codes.includes(code))
  if (missing.length) return { passed: false, reason: `Missing required training: ${missing.join(', ')}.`, missingTraining: missing }
  return { passed: true, reason: null, missingTraining: [] }
}
function currentDateInCampusTime() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const take = type => parts.find(p => p.type === type)?.value
  return `${take('year')}-${take('month')}-${take('day')}`
}
function toEpoch(date, time) {
  const sign = TZ_OFFSET >= 0 ? '+' : '-'
  const abs = Math.abs(TZ_OFFSET)
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return new Date(`${date}T${time}:00${offset}`).getTime()
}
function generateScheduledNotifications() {
  const now = Date.now()
  const rows = db.prepare(`SELECT b.*,r.owner_id,r.name resource_name,u.name user_name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=b.user_id WHERE b.status IN ('approved','checked_out')`).all()
  for (const b of rows) {
    const start = toEpoch(b.start_date, b.start_time)
    const end = toEpoch(b.start_date, b.end_time)
    if (b.status === 'approved' && start > now && start - now <= 24 * 60 * 60 * 1000) {
      notify(b.user_id, b.id, 'booking_reminder', 'Upcoming resource booking', `${b.resource_name} starts at ${b.start_time} on ${b.start_date}. Review the access and handover instructions.`)
    }
    if (b.status === 'checked_out' && end > now && end - now <= 24 * 60 * 60 * 1000) {
      notify(b.user_id, b.id, 'return_due_soon', 'Return due soon', `${b.resource_name} is due back at ${b.end_time} on ${b.start_date}. Please confirm the return.`)
    }
    if (b.status === 'checked_out' && end < now) {
      notify(b.user_id, b.id, 'overdue_return', 'Resource return overdue', `${b.resource_name} was due at ${b.end_time} on ${b.start_date}. Please contact the resource owner.`)
      notify(b.owner_id, b.id, 'overdue_return_owner', 'Overdue resource return', `${b.resource_name}, currently checked out by ${b.user_name}, is past its return time.`)
    }
  }
}

function getBookingRows(user) {
  let where = ''
  let params = []
  if (user.role === 'student') { where = 'WHERE b.user_id=?'; params = [user.id] }
  else if (user.role === 'owner') { where = 'WHERE r.owner_id=?'; params = [user.id] }
  const rows = db.prepare(`SELECT b.*,r.name resource_name,r.owner_id resource_owner_id,u.name user_name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=b.user_id ${where} ORDER BY b.created_at DESC`).all(...params)
  return rows.map(row => {
    const resource = getResourceById(row.resource_id)
    const eligibility = eligibleUserForResource(row.user_id, resource)
    return {
      id: row.id, resourceId: row.resource_id, resourceName: row.resource_name, userId: row.user_id,
      userName: row.user_name, startDate: row.start_date, startTime: row.start_time, endTime: row.end_time,
      purpose: row.purpose, status: row.status, decisionReason: row.decision_reason || undefined,
      conditionBefore: row.condition_before || undefined, conditionBeforeNotes: row.condition_before_notes || undefined,
      conditionAfter: row.condition_after || undefined, conditionAfterNotes: row.condition_after_notes || undefined,
      createdAt: row.created_at, eligibilityPassed: eligibility.passed, eligibilityReason: eligibility.reason,
    }
  })
}
function authorizedResourceOwner(user, resource) { return user.role === 'admin' || (user.role === 'owner' && resource?.ownerId === user.id) }
function requireAuth(req, res, next) {
  const cookieHeader = req.headers.cookie || ''
  const item = cookieHeader.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE_NAME}=`))
  if (!item) return res.status(401).json({ error: 'Sign in to continue.', code: 'AUTH_REQUIRED' })
  const rawToken = decodeURIComponent(item.slice(COOKIE_NAME.length + 1))
  const row = db.prepare(`SELECT s.id session_id,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(rawToken))
  if (!row || Date.parse(row.expires_at) < Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE id=?').run(row.session_id)
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isProduction ? '; Secure' : ''}`)
    return res.status(401).json({ error: 'Your session expired. Please sign in again.', code: 'SESSION_EXPIRED' })
  }
  req.user = rowUser(row)
  next()
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your account does not have permission to perform this action.', code: 'ROLE_FORBIDDEN' })
}
function fail(res, status, message, code) { return res.status(status).json({ error: message, code }) }
function checkOwner(user, resource) {
  if (!resource) return false
  return user.role === 'admin' || (user.role === 'owner' && resource.ownerId === user.id)
}
function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  db.prepare('INSERT INTO sessions(id,token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?,?)').run(makeId('ses'), hashToken(token), userId, expiresAt, nowIso())
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${isProduction ? '; Secure' : ''}`)
}
function recordBookingEvent(user, booking, action, detail) {
  addAudit(user, user.name, action, booking.resourceName, detail, booking.resourceId, booking.id)
}
function makeWorkspace(user) {
  generateScheduledNotifications()
  const resources = getResourceRows().map(resourceView)
  const bookings = getBookingRows(user)
  const bookingIds = bookings.map(b => b.id)
  let incidentRows
  if (user.role === 'admin') {
    incidentRows = db.prepare(`SELECT i.*,r.name resource_name,u.name reporter_name FROM incidents i JOIN bookings b ON b.id=i.booking_id JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=i.reporter_id ORDER BY i.created_at DESC`).all()
  } else if (user.role === 'owner') {
    incidentRows = db.prepare(`SELECT i.*,r.name resource_name,u.name reporter_name FROM incidents i JOIN bookings b ON b.id=i.booking_id JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=i.reporter_id WHERE r.owner_id=? ORDER BY i.created_at DESC`).all(user.id)
  } else {
    incidentRows = db.prepare(`SELECT i.*,r.name resource_name,u.name reporter_name FROM incidents i JOIN bookings b ON b.id=i.booking_id JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=i.reporter_id WHERE b.user_id=? OR i.reporter_id=? ORDER BY i.created_at DESC`).all(user.id, user.id)
  }
  const incidents = incidentRows.map(row => ({ id: row.id, bookingId: row.booking_id, resourceName: row.resource_name, reporter: row.reporter_name, description: row.description, severity: row.severity, status: row.status, createdAt: row.created_at, resolution: row.resolution || undefined }))
  let auditRows
  if (user.role === 'admin') {
    auditRows = db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 300').all()
  } else if (user.role === 'owner') {
    auditRows = db.prepare(`SELECT a.* FROM audit_events a LEFT JOIN resources r ON r.id=a.resource_id WHERE r.owner_id=? OR a.actor_id=? ORDER BY a.created_at DESC LIMIT 300`).all(user.id, user.id)
  } else {
    auditRows = db.prepare(`SELECT a.* FROM audit_events a WHERE a.actor_id=? OR a.booking_id IN (SELECT id FROM bookings WHERE user_id=?) ORDER BY a.created_at DESC LIMIT 300`).all(user.id, user.id)
  }
  const audit = auditRows.map(row => ({ id: row.id, actor: row.actor_name, action: row.action, target: row.target, detail: row.detail, createdAt: row.created_at }))
  const notifications = db.prepare(`SELECT id,kind,title,body,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).all(user.id).map(row => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, readAt: row.read_at || undefined, createdAt: row.created_at }))
  let extensionWhere = ''
  let extensionParams = []
  if (user.role === 'student') { extensionWhere = 'WHERE b.user_id=?'; extensionParams = [user.id] }
  else if (user.role === 'owner') { extensionWhere = 'WHERE r.owner_id=?'; extensionParams = [user.id] }
  const extensions = db.prepare(`SELECT e.*,b.resource_id,b.user_id,b.start_date,b.end_time current_end_time,r.name resource_name,u.name user_name FROM booking_extensions e JOIN bookings b ON b.id=e.booking_id JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=b.user_id ${extensionWhere} ORDER BY CASE e.status WHEN 'pending' THEN 0 ELSE 1 END,e.created_at ASC LIMIT 250`).all(...extensionParams).map(row => ({ id: row.id, bookingId: row.booking_id, resourceId: row.resource_id, resourceName: row.resource_name, userId: row.user_id, userName: row.user_name, startDate: row.start_date, originalEndTime: row.original_end_time, currentEndTime: row.status === 'pending' ? row.current_end_time : row.original_end_time, requestedEndTime: row.requested_end_time, reason: row.reason, status: row.status, decisionReason: row.decision_reason || undefined, createdAt: row.created_at }))
  const users = user.role === 'admin' ? directoryUsers() : []
  return { user: userById(user.id), resources, bookings, incidents, audit, notifications, users, extensions }
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', isProduction ? 1 : false)
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'self'"], fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], formAction: ["'self'"], frameAncestors: ["'none'"], imgSrc: ["'self'", 'data:', 'https:'], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], connectSrc: ["'self'"] } } }))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '20kb' }))
app.use((req, res, next) => {
  if (isProduction && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
    try {
      const originHost = new URL(req.headers.origin).host
      const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
      if (originHost !== requestHost) return res.status(403).json({ error: 'Cross-origin state-changing requests are not allowed.', code: 'ORIGIN_FORBIDDEN' })
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.', code: 'ORIGIN_FORBIDDEN' })
    }
  }
  next()
})
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many authentication attempts. Try again later.' } })

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'CampusShare X API', timestamp: nowIso() }))
app.post('/api/auth/login', authLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !password) return fail(res, 400, 'Enter your email and password.', 'VALIDATION_ERROR')
  const row = db.prepare('SELECT * FROM users WHERE email=?').get(email)
  if (!row || !bcrypt.compareSync(password, row.password_hash)) return fail(res, 401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS')
  createSession(row.id, res)
  addAudit(rowUser(row), row.name, 'Signed in', 'Account', 'Authenticated session created.')
  res.json({ user: userById(row.id) })
})
app.post('/api/auth/register', authLimiter, (req, res) => {
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (name.length < 2 || name.length > 80) return fail(res, 400, 'Enter your full name (2–80 characters).', 'VALIDATION_ERROR')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid email address.', 'VALIDATION_ERROR')
  if (password.length < 12) return fail(res, 400, 'Use a password with at least 12 characters.', 'WEAK_PASSWORD')
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return fail(res, 409, 'An account with this email already exists.', 'EMAIL_EXISTS')
  const id = makeId('usr')
  const title = 'Student · Awaiting verification'
  db.prepare(`INSERT INTO users(id,name,email,password_hash,role,title,verification_status,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(id, name, email, bcrypt.hashSync(password, 12), 'student', title, 'pending', nowIso())
  addAudit({ id, name }, name, 'Account registered', 'User profile', 'Student account created and queued for institutional verification.')
  const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all()
  for (const admin of admins) notify(admin.id, null, `account_verification_${id}`, 'Student verification required', `${name} (${email}) registered and needs institutional verification.`)
  createSession(id, res)
  res.status(201).json({ user: userById(id) })
})
app.get('/api/auth/me', (req, res) => {
  const cookieHeader = req.headers.cookie || ''
  const item = cookieHeader.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE_NAME}=`))
  if (!item) return res.status(401).json({ error: 'Not signed in.' })
  const token = decodeURIComponent(item.slice(COOKIE_NAME.length + 1))
  const row = db.prepare(`SELECT s.id session_id,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(token))
  if (!row || Date.parse(row.expires_at) < Date.now()) return res.status(401).json({ error: 'Session expired.' })
  res.json({ user: userById(row.id) })
})
app.post('/api/auth/logout', (req, res) => {
  const item = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE_NAME}=`))
  if (item) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(decodeURIComponent(item.slice(COOKIE_NAME.length + 1))))
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isProduction ? '; Secure' : ''}`)
  res.json({ ok: true })
})
app.get('/api/workspace', requireAuth, (req, res) => res.json(makeWorkspace(req.user)))

app.post('/api/smartmatch', requireAuth, async (req, res) => {
  const goal = String(req.body?.goal || '').trim().slice(0, 1200)
  if (goal.length < 3) return fail(res, 400, 'Describe what you are trying to do.', 'VALIDATION_ERROR')
  const allResources = getResourceRows().map(resourceView)
  const allowedTags = [...new Set(allResources.flatMap(r => r.capabilityTags))]
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
          model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Extract capability tags needed for a project from user intent. Return JSON only: {"capabilities":[...],"summary":"..."}. Only use exact tags from the provided allowlist. Do not make access, safety, or availability decisions.' },
            { role: 'user', content: JSON.stringify({ goal, allowedTags }) },
          ],
        }),
        signal: AbortSignal.timeout(7000),
      })
      if (!response.ok) throw new Error(`AI provider returned ${response.status}`)
      const payload = await response.json()
      const parsed = JSON.parse(payload.choices?.[0]?.message?.content || '{}')
      const safe = Array.isArray(parsed.capabilities) ? parsed.capabilities.filter(tag => allowedTags.includes(tag)) : []
      if (safe.length) { requestedTags = [...new Set(safe)]; reasoningMode = 'llm-assisted' }
    } catch (error) {
      console.warn('SmartMatch AI fallback used:', error instanceof Error ? error.message : 'provider error')
    }
  }
  const items = allResources.map(resource => {
    const matches = resource.capabilityTags.filter(tag => requestedTags.some(q => q === tag || q.includes(tag) || tag.includes(q)))
    const score = Math.round(Math.min(100, (matches.length / Math.max(1, Math.min(requestedTags.length, 5))) * 100))
    const eligibility = eligibleUserForResource(req.user.id, resource)
    const reasons = matches.length ? [`Matches: ${matches.slice(0, 4).join(', ')}`] : ['No direct capability tag match; inspect specifications before requesting.']
    if (!eligibility.passed) reasons.push(eligibility.reason)
    if (resource.status !== 'available') reasons.push(`Resource status is ${resource.status}.`)
    return { resourceId: resource.id, matchScore: score, reasons, eligibility: { status: eligibility.passed ? 'eligible' : 'blocked', reason: eligibility.reason }, operationalStatus: resource.status, availability: { status: 'slot_selection_required', note: 'Select a date and time; the server will verify the slot when you submit.' } }
  }).sort((a, b) => b.matchScore - a.matchScore)
  res.json({ goal, requiredCapabilities: requestedTags, reasoningMode, results: items })
})

function deriveTags(text, allowedTags) {
  const lower = text.toLowerCase()
  const aliases = {
    iot: ['iot','internet of things','embedded','esp32','arduino','microcontroller','sensor','prototype'],
    sensor: ['sensor','temperature','humidity','environmental','iot'],
    electronics: ['electronic','circuit','breadboard','electronics','solder','voltage'],
    testing: ['test','testing','debug','debugging','measurement','measure','oscilloscope','multimeter','signal'],
    video: ['video','record','camera','photography','filming'],
    camera: ['camera','record','photography','video'],
    recording: ['record','video','filming'],
    meeting: ['meeting','team','collaboration','discussion'],
    team: ['team','group','collaboration'],
    room: ['room','meeting','collaboration'],
    presentation: ['presentation','display','demo'],
    programming: ['program','programming','code','coding','software','firmware'],
    computing: ['laptop','computer','development','software'],
    prototype: ['prototype','prototyping','build','make','circuit','iot'],
    microcontroller: ['microcontroller','esp32','arduino','embedded','iot'],
    breadboard: ['breadboard','circuit','prototyping'],
    voltage: ['voltage','measure','measurement','multimeter'],
    measurement: ['measure','measurement','test','multimeter','signal'],
    debugging: ['debug','debugging','test','circuit','signal'],
    signal: ['signal','oscilloscope','communication','frequency'],
    documentation: ['documentation','document','record','camera','video'],
    collaboration: ['collaboration','team','meeting','group'],
    project: ['project','team','meeting','prototype'],
    development: ['development','programming','code','iot'],
    coding: ['code','coding','programming'],
    photography: ['photography','camera','picture'],
    fabrication: ['fabrication','solder','prototype','electronics'],
    soldering: ['solder','soldering'],
  }
  const found = allowedTags.filter(tag => lower.includes(tag.replaceAll('-', ' ')) || (aliases[tag] || []).some(word => lower.includes(word)))
  return [...new Set(found)].slice(0, 12).length ? [...new Set(found)].slice(0, 12) : allowedTags.filter(tag => lower.includes(tag)).slice(0, 8)
}

app.post('/api/resources', requireAuth, requireRole('owner','admin'), (req, res) => {
  const { name, category, location, description, capabilityTags, requiredTraining, instructions, status } = req.body || {}
  if (String(name || '').trim().length < 2 || String(location || '').trim().length < 2) return fail(res, 400, 'Resource name and location are required.', 'VALIDATION_ERROR')
  const tags = Array.isArray(capabilityTags) ? capabilityTags.filter(v => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(Boolean).slice(0, 30) : String(capabilityTags || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean).slice(0, 30)
  const training = Array.isArray(requiredTraining) ? requiredTraining.filter(v => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(Boolean).slice(0, 20) : String(requiredTraining || '').split(',').map(v => v.trim().toLowerCase().replaceAll(' ', '-')).filter(Boolean).slice(0, 20)
  const resourceId = makeId('res')
  const assetCode = `CSX-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  const icon = category === 'Computing' ? 'laptop' : category === 'Media' ? 'camera' : category === 'Spaces' ? 'door' : 'cpu'
  const gradient = ({ Electronics:'violet',Testing:'blue',Computing:'indigo',Media:'rose',Spaces:'green','Lab equipment':'slate' })[category] || 'violet'
  db.prepare(`INSERT INTO resources(id,name,category,description,location,owner_id,capability_tags,required_training,status,icon,gradient,asset_code,uses,instructions,value_label,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(resourceId, String(name).trim(), String(category || 'Other').slice(0, 60), String(description || 'Institution-managed shared resource.').trim().slice(0, 1500), String(location).trim().slice(0, 160), req.user.id, encodeJson(tags), encodeJson(training), ['available','maintenance','inactive'].includes(status) ? status : 'available', icon, gradient, assetCode, 0, String(instructions || 'Follow the owner-provided usage and return instructions.').slice(0, 1500), String(category || 'Resource').slice(0, 80), nowIso())
  addAudit(req.user, req.user.name, 'Resource listed', String(name).trim(), `Location: ${String(location).trim()}`, resourceId)
  res.status(201).json({ resource: getResourceById(resourceId) })
})

app.patch('/api/resources/:id/status', requireAuth, requireRole('owner','admin'), (req, res) => {
  const resource = getResourceById(req.params.id)
  if (!resource) return fail(res, 404, 'Resource not found.', 'NOT_FOUND')
  if (!checkOwner(req.user, resource)) return fail(res, 403, 'You can only manage resources you own.', 'RESOURCE_FORBIDDEN')
  const status = req.body?.status
  if (!['available','maintenance','inactive'].includes(status)) return fail(res, 400, 'Invalid resource status.', 'VALIDATION_ERROR')
  if (status !== 'available') {
    if (db.prepare("SELECT id FROM bookings WHERE resource_id=? AND status='checked_out' LIMIT 1").get(resource.id)) return fail(res, 409, 'A checked-out resource cannot be marked unavailable until it is returned.', 'RESOURCE_IN_USE')
    if (db.prepare("SELECT id FROM bookings WHERE resource_id=? AND start_date>=? AND status='approved' LIMIT 1").get(resource.id, currentDateInCampusTime())) return fail(res, 409, 'A resource with upcoming approved bookings cannot be marked unavailable. Add a specific time block or resolve those bookings first.', 'APPROVED_BOOKING_EXISTS')
  }
  db.prepare('UPDATE resources SET status=? WHERE id=?').run(status, resource.id)
  addAudit(req.user, req.user.name, 'Resource status changed', resource.name, `Status changed from ${resource.status} to ${status}.`, resource.id)
  res.json({ resource: getResourceById(resource.id) })
})

app.post('/api/resources/:id/blocks', requireAuth, requireRole('owner','admin'), (req, res) => {
  const resource = getResourceById(req.params.id)
  if (!resource) return fail(res, 404, 'Resource not found.', 'NOT_FOUND')
  if (!checkOwner(req.user, resource)) return fail(res, 403, 'You can only schedule blocks for resources you own.', 'RESOURCE_FORBIDDEN')
  const startDate = String(req.body?.startDate || '')
  const startTime = String(req.body?.startTime || '')
  const endTime = String(req.body?.endTime || '')
  const reason = String(req.body?.reason || '').trim().slice(0, 300)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || endTime <= startTime || timeValue(endTime)-timeValue(startTime)>8*60 || reason.length<4) return fail(res, 400, 'Provide a valid date, time range of at most 8 hours, and a clear reason.', 'VALIDATION_ERROR')
  const blockDateParts = startDate.split('-').map(Number)
  const blockDate = new Date(Date.UTC(blockDateParts[0], blockDateParts[1] - 1, blockDateParts[2]))
  if (blockDate.getUTCFullYear() !== blockDateParts[0] || blockDate.getUTCMonth() !== blockDateParts[1] - 1 || blockDate.getUTCDate() !== blockDateParts[2]) return fail(res, 400, 'Choose a real calendar date for the maintenance block.', 'INVALID_DATE')
  if (startDate < currentDateInCampusTime() || toEpoch(startDate,startTime) <= Date.now()) return fail(res, 400, 'Blocks must start in the future.', 'PAST_TIME')
  const booking = db.prepare(`SELECT id FROM bookings WHERE resource_id=? AND start_date=? AND status IN ('approved','checked_out') AND start_time < ? AND end_time > ? LIMIT 1`).get(resource.id,startDate,endTime,startTime)
  if (booking) return fail(res, 409, 'The block overlaps an approved or checked-out booking.', 'SLOT_CONFLICT')
  const id = makeId('blk')
  db.prepare('INSERT INTO resource_blocks(id,resource_id,start_date,start_time,end_time,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,resource.id,startDate,startTime,endTime,reason,req.user.id,nowIso())
  addAudit(req.user, req.user.name, 'Resource time blocked', resource.name, `${startDate} ${startTime}–${endTime}: ${reason}`, resource.id)
  res.status(201).json({ id, startDate, startTime, endTime, reason })
})

app.get('/api/resources/:id/availability', requireAuth, (req, res) => {
  const resource = getResourceById(req.params.id)
  if (!resource) return fail(res, 404, 'Resource not found.', 'NOT_FOUND')
  const date = String(req.query?.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'Provide a valid date in YYYY-MM-DD format.', 'INVALID_DATE')
  const parts = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
  if (parsed.getUTCFullYear() !== parts[0] || parsed.getUTCMonth() !== parts[1] - 1 || parsed.getUTCDate() !== parts[2]) return fail(res, 400, 'Choose a real calendar date.', 'INVALID_DATE')
  const confirmedSlots = db.prepare(`SELECT start_time,end_time,status FROM bookings WHERE resource_id=? AND start_date=? AND status IN ('approved','checked_out') ORDER BY start_time`).all(resource.id, date).map(row => ({ startTime: row.start_time, endTime: row.end_time, status: row.status }))
  const pendingRequests = db.prepare(`SELECT start_time,end_time,status FROM bookings WHERE resource_id=? AND start_date=? AND status IN ('pending','waitlisted') ORDER BY created_at ASC`).all(resource.id, date).map(row => ({ startTime: row.start_time, endTime: row.end_time, status: row.status }))
  const maintenanceBlocks = db.prepare(`SELECT start_time,end_time,reason FROM resource_blocks WHERE resource_id=? AND start_date=? ORDER BY start_time`).all(resource.id, date).map(row => ({ startTime: row.start_time, endTime: row.end_time, reason: row.reason }))
  const eligibility = eligibleUserForResource(req.user.id, resource)
  res.json({ resourceId: resource.id, date, timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata', resourceStatus: resource.status, eligibility: { status: eligibility.passed ? 'eligible' : 'blocked', reason: eligibility.reason }, confirmedSlots, pendingRequests, maintenanceBlocks, checkedAt: nowIso() })
})

app.post('/api/bookings', requireAuth, (req, res) => {
  const resourceId = String(req.body?.resourceId || '')
  const startDate = String(req.body?.startDate || '')
  const startTime = String(req.body?.startTime || '')
  const endTime = String(req.body?.endTime || '')
  const purpose = String(req.body?.purpose || '').trim().slice(0, 800)
  const waitlist = Boolean(req.body?.waitlist)
  const resource = getResourceById(resourceId)
  if (!resource) return fail(res, 404, 'Resource not found.', 'NOT_FOUND')
  if (req.user.verificationStatus !== 'verified') return fail(res, 403, 'Your account is awaiting institutional verification. You can browse resources, but cannot submit booking requests yet.', 'VERIFICATION_REQUIRED')
  if (resource.status !== 'available') return fail(res, 409, 'This resource is not currently available for new bookings.', 'RESOURCE_UNAVAILABLE')
  const eligibility = eligibleUserForResource(req.user.id, resource)
  if (!eligibility.passed) return fail(res, 403, eligibility.reason, 'ELIGIBILITY_BLOCKED')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) return fail(res, 400, 'Choose a valid date and time.', 'VALIDATION_ERROR')
  const dateParts = startDate.split('-').map(Number)
  const parsedDate = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]))
  if (parsedDate.getUTCFullYear() !== dateParts[0] || parsedDate.getUTCMonth() !== dateParts[1] - 1 || parsedDate.getUTCDate() !== dateParts[2]) return fail(res, 400, 'Choose a real calendar date.', 'INVALID_DATE')
  if (startDate < currentDateInCampusTime()) return fail(res, 400, 'Bookings cannot be made for a past date.', 'PAST_DATE')
  if (toEpoch(startDate, startTime) <= Date.now()) return fail(res, 400, 'Choose a start time in the future.', 'PAST_TIME')
  if (endTime <= startTime) return fail(res, 400, 'The end time must be later than the start time on the selected day.', 'INVALID_TIME_RANGE')
  if ((timeValue(endTime) - timeValue(startTime)) > 8 * 60) return fail(res, 400, 'A single booking may not exceed 8 hours.', 'DURATION_LIMIT')
  if (purpose.length < 4) return fail(res, 400, 'Describe the intended use of the resource.', 'VALIDATION_ERROR')
  const hardConflict = db.prepare(`SELECT id FROM bookings WHERE resource_id=? AND start_date=? AND status IN ('approved','checked_out') AND start_time < ? AND end_time > ? LIMIT 1`).get(resourceId, startDate, endTime, startTime)
  const maintenanceConflict = db.prepare(`SELECT id,reason FROM resource_blocks WHERE resource_id=? AND start_date=? AND start_time < ? AND end_time > ? LIMIT 1`).get(resourceId, startDate, endTime, startTime)
  if (maintenanceConflict) return fail(res, 409, `The selected time is blocked: ${maintenanceConflict.reason}`, 'RESOURCE_BLOCKED')
  if (hardConflict && !waitlist) return fail(res, 409, 'That slot overlaps a confirmed booking. Join the waitlist to request the same time.', 'SLOT_CONFLICT')
  const activeReservations = db.prepare(`SELECT COUNT(*) n FROM bookings WHERE user_id=? AND ((start_date>=? AND status IN ('pending','approved','waitlisted')) OR status='checked_out')`).get(req.user.id, currentDateInCampusTime()).n
  if (activeReservations >= 3) return fail(res, 429, 'Fair-use limit reached: each user may hold up to 3 active or upcoming reservations at a time. Complete, cancel or wait for existing requests to close.', 'FAIR_USE_LIMIT')
  const duplicate = db.prepare(`SELECT id FROM bookings WHERE resource_id=? AND user_id=? AND start_date=? AND start_time=? AND end_time=? AND status IN ('pending','approved','waitlisted','checked_out') LIMIT 1`).get(resourceId, req.user.id, startDate, startTime, endTime)
  if (duplicate) return fail(res, 409, 'You already have an active request for this resource and time.', 'DUPLICATE_REQUEST')
  const id = makeId('bk')
  const status = waitlist || hardConflict ? 'waitlisted' : 'pending'
  const reason = status === 'waitlisted' ? 'Added to the transparent waitlist for this time slot.' : null
  db.prepare(`INSERT INTO bookings(id,resource_id,user_id,start_date,start_time,end_time,purpose,status,decision_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, resourceId, req.user.id, startDate, startTime, endTime, purpose, status, reason, nowIso(), nowIso())
  recordBookingEvent(req.user, { id, resourceId, resourceName: resource.name }, status === 'waitlisted' ? 'Joined waitlist' : 'Booking requested', `${startDate} · ${startTime}–${endTime}. Purpose: ${purpose}`)
  const owners = resource.ownerId
  notify(owners, id, 'booking_request', status === 'waitlisted' ? 'Waitlist entry received' : 'Booking request received', `${req.user.name} requested ${resource.name} for ${startDate}, ${startTime}–${endTime}.`)
  res.status(201).json({ booking: { id, resourceId, resourceName: resource.name, userId: req.user.id, userName: req.user.name, startDate, startTime, endTime, purpose, status, decisionReason: reason, createdAt: nowIso() } })
})

app.patch('/api/bookings/:id/status', requireAuth, requireRole('owner','admin'), (req, res) => {
  const bookingRow = db.prepare(`SELECT b.*,r.owner_id,r.name resource_name FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=?`).get(req.params.id)
  if (!bookingRow) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
  const resource = getResourceById(bookingRow.resource_id)
  if (!checkOwner(req.user, resource)) return fail(res, 403, 'Only the resource owner or an administrator may decide this request.', 'BOOKING_FORBIDDEN')
  const nextStatus = String(req.body?.status || '')
  const reason = String(req.body?.reason || '').trim().slice(0, 500)
  if (!['approved','rejected','waitlisted','pending'].includes(nextStatus)) return fail(res, 400, 'Invalid booking decision.', 'VALIDATION_ERROR')
  if (['approved','pending'].includes(nextStatus) && resource.status !== 'available') return fail(res, 409, 'This resource is not operational and cannot be approved for booking.', 'RESOURCE_UNAVAILABLE')
  if (!['pending','waitlisted'].includes(bookingRow.status)) return fail(res, 409, 'This booking is no longer awaiting a decision.', 'BOOKING_STATE_CONFLICT')
  if (nextStatus === 'pending' && bookingRow.status !== 'waitlisted') return fail(res, 400, 'Only a waitlisted request can be returned to owner review.', 'INVALID_TRANSITION')
  if (nextStatus === 'approved' || nextStatus === 'pending') {
    const eligibility = eligibleUserForResource(bookingRow.user_id, resource)
    if (!eligibility.passed) return fail(res, 403, `Cannot proceed: ${eligibility.reason}`, 'ELIGIBILITY_BLOCKED')
    const conflict = db.prepare(`SELECT id FROM bookings WHERE resource_id=? AND start_date=? AND id<>? AND status IN ('approved','checked_out') AND start_time < ? AND end_time > ? LIMIT 1`).get(bookingRow.resource_id, bookingRow.start_date, bookingRow.id, bookingRow.end_time, bookingRow.start_time)
    if (conflict) return fail(res, 409, 'Another confirmed booking occupies this slot. Keep the request waitlisted or choose another time.', 'SLOT_CONFLICT')
    const block = db.prepare(`SELECT reason FROM resource_blocks WHERE resource_id=? AND start_date=? AND start_time < ? AND end_time > ? LIMIT 1`).get(bookingRow.resource_id, bookingRow.start_date, bookingRow.end_time, bookingRow.start_time)
    if (block) return fail(res, 409, `The requested slot is blocked: ${block.reason}`, 'RESOURCE_BLOCKED')
  }
  const tx = db.transaction(() => {
    const decisionText = reason || (nextStatus === 'approved' ? 'Approved by the authorised resource owner.' : nextStatus === 'rejected' ? 'Rejected by the authorised resource owner.' : nextStatus === 'waitlisted' ? 'Placed on the waitlist under the resource allocation policy.' : 'Returned to owner review from the waitlist.')
    db.prepare('UPDATE bookings SET status=?,decision_reason=?,updated_at=? WHERE id=?').run(nextStatus, decisionText, nowIso(), bookingRow.id)
    recordBookingEvent(req.user, { id: bookingRow.id, resourceId: bookingRow.resource_id, resourceName: bookingRow.resource_name }, `Booking ${nextStatus.replace('_',' ')}`, `${bookingRow.user_name || userById(bookingRow.user_id)?.name || 'Requester'} · ${bookingRow.start_date}. ${decisionText}`)
    if (nextStatus === 'approved') {
      const competitors = db.prepare(`SELECT b.id,b.user_id,b.start_time,b.end_time FROM bookings b WHERE b.resource_id=? AND b.start_date=? AND b.id<>? AND b.status='pending' AND b.start_time < ? AND b.end_time > ?`).all(bookingRow.resource_id, bookingRow.start_date, bookingRow.id, bookingRow.end_time, bookingRow.start_time)
      for (const competing of competitors) {
        const queueReason = 'Placed on the waitlist because a competing request was approved. The owner may review this queue if the slot becomes free.'
        db.prepare('UPDATE bookings SET status=\'waitlisted\',decision_reason=?,updated_at=? WHERE id=?').run(queueReason, nowIso(), competing.id)
        notify(competing.user_id, competing.id, 'booking_waitlisted', 'Booking moved to waitlist', `${bookingRow.resource_name} at ${bookingRow.start_time}–${bookingRow.end_time} was allocated to another request. ${queueReason}`)
      }
    }
    const user = userById(bookingRow.user_id)
    notify(user.id, bookingRow.id, `booking_${nextStatus}`, nextStatus === 'approved' ? 'Booking approved' : nextStatus === 'rejected' ? 'Booking rejected' : nextStatus === 'waitlisted' ? 'Booking waitlisted' : 'Booking returned to review', `${bookingRow.resource_name}: ${decisionText}`)
  })
  tx()
  res.json({ ok: true, status: nextStatus })
})

app.post('/api/bookings/:id/cancel', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT b.*,r.name resource_name,r.owner_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=?`).get(req.params.id)
  if (!row) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
  const isOwner = req.user.role === 'admin' || (req.user.role === 'owner' && row.owner_id === req.user.id)
  if (req.user.id !== row.user_id && !isOwner) return fail(res, 403, 'You cannot cancel another user’s booking.', 'BOOKING_FORBIDDEN')
  if (!['pending','approved','waitlisted'].includes(row.status)) return fail(res, 409, 'This booking can no longer be cancelled.', 'INVALID_TRANSITION')
  const reason = String(req.body?.reason || 'Cancelled by an authorised user.').slice(0, 300)
  db.prepare("UPDATE bookings SET status='cancelled',decision_reason=?,updated_at=? WHERE id=?").run(reason, nowIso(), row.id)
  recordBookingEvent(req.user, { id: row.id, resourceId: row.resource_id, resourceName: row.resource_name }, 'Booking cancelled', reason)
  notify(row.user_id, row.id, 'booking_cancelled', 'Booking cancelled', `${row.resource_name}: ${reason}`)
  if (row.owner_id !== row.user_id) notify(row.owner_id, row.id, 'booking_cancelled_owner', 'Booking cancelled by requester', `${row.resource_name}: ${reason}`)
  res.json({ ok: true })
})

app.post('/api/bookings/:id/check-in', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT b.*,r.name resource_name,r.owner_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=?`).get(req.params.id)
  if (!row) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
  const canUse = req.user.role === 'admin' || req.user.id === row.user_id || (req.user.role === 'owner' && req.user.id === row.owner_id)
  if (!canUse) return fail(res, 403, 'You cannot check in this booking.', 'BOOKING_FORBIDDEN')
  if (row.status !== 'approved') return fail(res, 409, 'Only an approved booking can be checked out.', 'INVALID_TRANSITION')
  const resource = getResourceById(row.resource_id)
  if (resource.status !== 'available') return fail(res, 409, 'This resource is not operational. Contact the owner before collection.', 'RESOURCE_UNAVAILABLE')
  const eligibility = eligibleUserForResource(row.user_id, resource)
  if (!eligibility.passed) return fail(res, 403, `Access blocked: ${eligibility.reason}`, 'ELIGIBILITY_BLOCKED')
  const condition = ['good','minor','damage'].includes(req.body?.condition) ? req.body.condition : 'good'
  const notes = String(req.body?.notes || '').trim().slice(0, 1000)
  const tx = db.transaction(() => {
    db.prepare("UPDATE bookings SET status='checked_out',condition_before=?,condition_before_notes=?,updated_at=? WHERE id=?").run(condition, notes, nowIso(), row.id)
    db.prepare('INSERT INTO condition_reports(id,booking_id,stage,condition,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId('cr'), row.id, 'before', condition, notes, req.user.id, nowIso())
    recordBookingEvent(req.user, { id: row.id, resourceId: row.resource_id, resourceName: row.resource_name }, 'Resource checked out', `Initial condition: ${condition}${notes ? ` · ${notes}` : ''}`)
    notify(row.owner_id, row.id, 'resource_checked_out', 'Resource checked out', `${row.resource_name} was checked out by ${userById(row.user_id)?.name || 'the requester'}.`)
  })
  tx()
  res.json({ ok: true, status: 'checked_out' })
})

app.post('/api/bookings/:id/return', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT b.*,r.name resource_name,r.owner_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=?`).get(req.params.id)
  if (!row) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
  const canUse = req.user.role === 'admin' || req.user.id === row.user_id || (req.user.role === 'owner' && req.user.id === row.owner_id)
  if (!canUse) return fail(res, 403, 'You cannot return this booking.', 'BOOKING_FORBIDDEN')
  if (row.status !== 'checked_out') return fail(res, 409, 'Only a checked-out booking can be returned.', 'INVALID_TRANSITION')
  const condition = ['good','minor','damage'].includes(req.body?.condition) ? req.body.condition : null
  if (!condition) return fail(res, 400, 'Choose the return condition.', 'VALIDATION_ERROR')
  const notes = String(req.body?.notes || '').trim().slice(0, 1000)
  if (condition !== 'good' && notes.length < 4) return fail(res, 400, 'Describe the issue observed at return.', 'CONDITION_NOTES_REQUIRED')
  const tx = db.transaction(() => {
    db.prepare("UPDATE bookings SET status='returned',condition_after=?,condition_after_notes=?,updated_at=? WHERE id=?").run(condition, notes, nowIso(), row.id)
    db.prepare('INSERT INTO condition_reports(id,booking_id,stage,condition,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId('cr'), row.id, 'after', condition, notes, req.user.id, nowIso())
    db.prepare('UPDATE resources SET uses=uses+1 WHERE id=?').run(row.resource_id)
    recordBookingEvent(req.user, { id: row.id, resourceId: row.resource_id, resourceName: row.resource_name }, 'Resource returned', `Final condition: ${condition}${notes ? ` · ${notes}` : ''}`)
    notify(row.owner_id, row.id, 'resource_returned', 'Resource return recorded', `${row.resource_name} was returned. Condition: ${condition}.`)
    if (condition !== 'good') {
      const incidentId = makeId('inc')
      const severity = condition === 'damage' ? 'high' : 'low'
      const description = notes || 'A condition issue was noted during return.'
      db.prepare('INSERT INTO incidents(id,booking_id,reporter_id,description,severity,status,created_at) VALUES(?,?,?,?,?,?,?)').run(incidentId, row.id, req.user.id, description, severity, 'open', nowIso())
      addAudit(req.user, req.user.name, 'Incident opened', row.resource_name, description, row.resource_id, row.id)
      notify(row.owner_id, row.id, 'incident_reported', 'Return issue needs review', `${row.resource_name}: ${description}`)
    }
  })
  tx()
  res.json({ ok: true, status: 'returned' })
})

app.post('/api/bookings/:id/extension', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT b.*,r.name resource_name,r.owner_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=?`).get(req.params.id)
  if (!row) return fail(res, 404, 'Booking not found.', 'NOT_FOUND')
  if (req.user.id !== row.user_id) return fail(res, 403, 'Only the requester can ask to extend this booking.', 'BOOKING_FORBIDDEN')
  if (row.status !== 'checked_out') return fail(res, 409, 'Extensions can only be requested while a resource is checked out.', 'INVALID_TRANSITION')
  const requestedEndTime = String(req.body?.requestedEndTime || '')
  const reason = String(req.body?.reason || '').trim().slice(0, 500)
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedEndTime)) return fail(res, 400, 'Choose a valid requested end time.', 'VALIDATION_ERROR')
  if (requestedEndTime <= row.end_time) return fail(res, 400, 'The requested extension must end later than the current return time.', 'INVALID_EXTENSION')
  if ((timeValue(requestedEndTime) - timeValue(row.start_time)) > 8 * 60) return fail(res, 400, 'The total booking duration cannot exceed 8 hours.', 'DURATION_LIMIT')
  if (toEpoch(row.start_date, requestedEndTime) <= Date.now()) return fail(res, 400, 'The requested end time must be in the future.', 'PAST_TIME')
  if (reason.length < 4) return fail(res, 400, 'Explain why the extension is needed.', 'VALIDATION_ERROR')
  const pending = db.prepare("SELECT id FROM booking_extensions WHERE booking_id=? AND status='pending' LIMIT 1").get(row.id)
  if (pending) return fail(res, 409, 'An extension request is already awaiting a decision.', 'EXTENSION_PENDING')
  const conflict = db.prepare(`SELECT id FROM bookings WHERE resource_id=? AND start_date=? AND id<>? AND status IN ('approved','checked_out') AND start_time < ? AND end_time > ? LIMIT 1`).get(row.resource_id, row.start_date, row.id, requestedEndTime, row.start_time)
  if (conflict) return fail(res, 409, 'The extension overlaps another confirmed booking. Request a shorter extension or arrange another slot.', 'SLOT_CONFLICT')
  const id = makeId('ext')
  const now = nowIso()
  db.prepare(`INSERT INTO booking_extensions(id,booking_id,requested_by,original_end_time,requested_end_time,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(id, row.id, req.user.id, row.end_time, requestedEndTime, reason, 'pending', now)
  addAudit(req.user, req.user.name, 'Extension requested', row.resource_name, `Current end: ${row.end_time}; requested end: ${requestedEndTime}. Reason: ${reason}`, row.resource_id, row.id)
  notify(row.owner_id, row.id, 'extension_request', 'Booking extension requires review', `${row.resource_name}: ${req.user.name} requested an extension to ${requestedEndTime}. ${reason}`)
  res.status(201).json({ id, status: 'pending', requestedEndTime })
})

app.patch('/api/extensions/:id/decision', requireAuth, requireRole('owner','admin'), (req, res) => {
  const ext = db.prepare(`SELECT e.*,b.resource_id,b.user_id,b.start_date,b.start_time,b.end_time current_end_time,b.status booking_status,r.name resource_name,r.owner_id,u.name user_name FROM booking_extensions e JOIN bookings b ON b.id=e.booking_id JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=b.user_id WHERE e.id=?`).get(req.params.id)
  if (!ext) return fail(res, 404, 'Extension request not found.', 'NOT_FOUND')
  const resource = getResourceById(ext.resource_id)
  if (!checkOwner(req.user, resource)) return fail(res, 403, 'Only the resource owner or an administrator can decide this extension.', 'BOOKING_FORBIDDEN')
  if (ext.status !== 'pending') return fail(res, 409, 'This extension request has already been decided.', 'INVALID_TRANSITION')
  const decision = req.body?.status
  const reason = String(req.body?.reason || '').trim().slice(0, 500)
  if (!['approved','rejected'].includes(decision)) return fail(res, 400, 'Choose approve or reject.', 'VALIDATION_ERROR')
  if (decision === 'approved') {
    if (ext.booking_status !== 'checked_out') return fail(res, 409, 'The booking is no longer checked out; the extension cannot be approved.', 'INVALID_TRANSITION')
    if (ext.requested_end_time <= ext.current_end_time) return fail(res, 409, 'The requested end time is no longer later than the current return time.', 'INVALID_EXTENSION')
    const conflict = db.prepare(`SELECT id FROM bookings WHERE resource_id=? AND start_date=? AND id<>? AND status IN ('approved','checked_out') AND start_time < ? AND end_time > ? LIMIT 1`).get(ext.resource_id, ext.start_date, ext.booking_id, ext.requested_end_time, ext.start_time)
    if (conflict) return fail(res, 409, 'The extension now conflicts with another confirmed booking.', 'SLOT_CONFLICT')
    const block = db.prepare(`SELECT reason FROM resource_blocks WHERE resource_id=? AND start_date=? AND start_time < ? AND end_time > ? LIMIT 1`).get(ext.resource_id, ext.start_date, ext.requested_end_time, ext.current_end_time)
    if (block) return fail(res, 409, `The extension overlaps a scheduled block: ${block.reason}`, 'RESOURCE_BLOCKED')
    if (toEpoch(ext.start_date, ext.requested_end_time) <= Date.now()) return fail(res, 409, 'The requested end time has passed; the extension cannot be approved.', 'PAST_TIME')
  }
  const tx = db.transaction(() => {
    const now = nowIso()
    const decisionReason = reason || (decision === 'approved' ? 'Extension approved by the authorised resource owner.' : 'Extension rejected by the authorised resource owner.')
    db.prepare('UPDATE booking_extensions SET status=?,decision_reason=?,decided_by=?,decided_at=? WHERE id=?').run(decision, decisionReason, req.user.id, now, ext.id)
    if (decision === 'approved') db.prepare('UPDATE bookings SET end_time=?,updated_at=? WHERE id=?').run(ext.requested_end_time, now, ext.booking_id)
    addAudit(req.user, req.user.name, `Extension ${decision}`, ext.resource_name, `${ext.user_name}: ${ext.current_end_time} → ${ext.requested_end_time}. ${decisionReason}`, ext.resource_id, ext.booking_id)
    notify(ext.user_id, ext.booking_id, `extension_${decision}`, decision === 'approved' ? 'Booking extension approved' : 'Booking extension rejected', `${ext.resource_name}: ${decisionReason}`)
  })
  tx()
  res.json({ ok: true, status: decision })
})

app.post('/api/incidents', requireAuth, (req, res) => {
  const bookingId = String(req.body?.bookingId || '')
  const description = String(req.body?.description || '').trim().slice(0, 2000)
  const severity = ['low','medium','high'].includes(req.body?.severity) ? req.body.severity : 'medium'
  if (description.length < 5) return fail(res, 400, 'Describe what happened (at least 5 characters).', 'VALIDATION_ERROR')
  const row = db.prepare(`SELECT b.*,r.name resource_name,r.owner_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=?`).get(bookingId)
  if (!row) return fail(res, 404, 'Related booking not found.', 'NOT_FOUND')
  const canReport = req.user.role === 'admin' || req.user.id === row.user_id || (req.user.role === 'owner' && req.user.id === row.owner_id)
  if (!canReport) return fail(res, 403, 'Incident reports must be tied to a booking you are authorised to access.', 'INCIDENT_FORBIDDEN')
  const id = makeId('inc')
  db.prepare('INSERT INTO incidents(id,booking_id,reporter_id,description,severity,status,created_at) VALUES(?,?,?,?,?,?,?)').run(id, bookingId, req.user.id, description, severity, 'open', nowIso())
  addAudit(req.user, req.user.name, 'Incident reported', row.resource_name, description, row.resource_id, row.id)
  notify(row.owner_id, row.id, 'incident_reported', 'Incident requires review', `${row.resource_name}: ${description}`)
  res.status(201).json({ id })
})

app.patch('/api/incidents/:id/resolve', requireAuth, requireRole('owner','admin'), (req, res) => {
  const incident = db.prepare(`SELECT i.*,b.resource_id,r.owner_id,r.name resource_name FROM incidents i JOIN bookings b ON b.id=i.booking_id JOIN resources r ON r.id=b.resource_id WHERE i.id=?`).get(req.params.id)
  if (!incident) return fail(res, 404, 'Incident not found.', 'NOT_FOUND')
  if (req.user.role === 'owner' && incident.owner_id !== req.user.id) return fail(res, 403, 'Only the resource owner or an administrator may resolve this incident.', 'INCIDENT_FORBIDDEN')
  const resolution = String(req.body?.resolution || '').trim().slice(0, 1000)
  if (resolution.length < 4) return fail(res, 400, 'Enter a resolution note for the audit trail.', 'VALIDATION_ERROR')
  if (incident.status === 'resolved') return fail(res, 409, 'This incident is already resolved.', 'INVALID_TRANSITION')
  db.prepare("UPDATE incidents SET status='resolved',resolution=?,resolved_by=?,resolved_at=? WHERE id=?").run(resolution, req.user.id, nowIso(), incident.id)
  addAudit(req.user, req.user.name, 'Incident resolved', incident.resource_name, resolution, incident.resource_id, incident.booking_id)
  const booking = db.prepare('SELECT user_id FROM bookings WHERE id=?').get(incident.booking_id)
  notify(booking.user_id, incident.booking_id, 'incident_resolved', 'Incident review completed', `${incident.resource_name}: ${resolution}`)
  res.json({ ok: true })
})

app.get('/api/users', requireAuth, requireRole('admin'), (_req, res) => res.json({ users: directoryUsers() }))

app.patch('/api/users/:id/verification', requireAuth, requireRole('admin'), (req, res) => {
  const status = req.body?.status
  if (!['verified','rejected','pending'].includes(status)) return fail(res, 400, 'Invalid verification status.', 'VALIDATION_ERROR')
  const row = db.prepare('SELECT id,name,email,role,verification_status FROM users WHERE id=?').get(req.params.id)
  if (!row) return fail(res, 404, 'User not found.', 'NOT_FOUND')
  if (row.role !== 'student') return fail(res, 400, 'Only student profiles can be verified from this screen.', 'INVALID_USER_TYPE')
  db.prepare('UPDATE users SET verification_status=?,verified_at=?,verified_by=?,title=? WHERE id=?').run(status, status === 'verified' ? nowIso() : null, status === 'verified' ? req.user.id : null, status === 'verified' ? 'Student · Verified' : 'Student · Awaiting verification', row.id)
  addAudit(req.user, req.user.name, `User verification ${status}`, row.name, `Institutional verification status changed from ${row.verification_status} to ${status}.`)
  notify(row.id, null, `verification_${status}_${nowIso().slice(0,10)}`, status === 'verified' ? 'Account verified' : status === 'rejected' ? 'Account verification rejected' : 'Verification reopened', status === 'verified' ? 'Your profile is verified. You can now submit resource requests subject to each resource policy.' : status === 'rejected' ? 'Your account could not be verified. Contact the campus administrator for review.' : 'Your profile requires further institutional verification.')
  res.json({ ok: true, status })
})

app.patch('/api/users/:id/role', requireAuth, requireRole('admin'), (req, res) => {
  const role = req.body?.role
  if (!['student', 'owner'].includes(role)) return fail(res, 400, 'Only student and resource-owner roles can be assigned here.', 'VALIDATION_ERROR')
  const row = db.prepare('SELECT id,name,email,role,verification_status FROM users WHERE id=?').get(req.params.id)
  if (!row) return fail(res, 404, 'User not found.', 'NOT_FOUND')
  if (row.role === 'admin') return fail(res, 400, 'Administrator accounts cannot be changed from this control.', 'INVALID_USER_TYPE')
  if (role === 'owner' && row.verification_status !== 'verified') return fail(res, 409, 'Verify institutional membership before granting resource-owner privileges.', 'VERIFICATION_REQUIRED')
  if (role === 'student' && row.role === 'owner') {
    const owned = db.prepare('SELECT COUNT(*) n FROM resources WHERE owner_id=?').get(row.id).n
    if (owned > 0) return fail(res, 409, 'Transfer this owner’s resources to another authorised owner before removing the role.', 'OWNER_HAS_RESOURCES')
  }
  const title = role === 'owner' ? 'Resource owner · Verified' : row.verification_status === 'verified' ? 'Student · Verified' : 'Student · Awaiting verification'
  db.prepare('UPDATE users SET role=?,title=? WHERE id=?').run(role, title, row.id)
  addAudit(req.user, req.user.name, 'User role changed', row.name, `Role changed from ${row.role} to ${role}.`)
  notify(row.id, null, `role_changed_${nowIso().slice(0,10)}`, 'Account role updated', `Your account role is now ${role === 'owner' ? 'Resource owner' : 'Student'}.`)
  res.json({ ok: true, role })
})

app.put('/api/users/:id/training', requireAuth, requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT id,name,role,verification_status FROM users WHERE id=?').get(req.params.id)
  if (!user) return fail(res, 404, 'User not found.', 'NOT_FOUND')
  if (!['student','owner'].includes(user.role)) return fail(res, 400, 'Training records can only be assigned to a student or resource owner.', 'INVALID_USER_TYPE')
  const code = String(req.body?.trainingCode || '').trim().toLowerCase().replaceAll(' ', '-')
  const status = req.body?.status
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(code)) return fail(res, 400, 'Use a training identifier containing 3–80 letters, numbers or hyphens.', 'VALIDATION_ERROR')
  if (!['verified','expired'].includes(status)) return fail(res, 400, 'Training status must be verified or expired.', 'VALIDATION_ERROR')
  if (status === 'verified' && user.verification_status !== 'verified') return fail(res, 409, 'Verify the user’s institutional profile before granting training.', 'VERIFICATION_REQUIRED')
  const now = nowIso()
  db.prepare(`INSERT INTO training_records(id,user_id,training_code,status,valid_until,verified_by,created_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id,training_code) DO UPDATE SET status=excluded.status,valid_until=excluded.valid_until,verified_by=excluded.verified_by,created_at=excluded.created_at`)
    .run(makeId('trn'), user.id, code, status, null, status === 'verified' ? req.user.id : null, now)
  addAudit(req.user, req.user.name, status === 'verified' ? 'Training verified' : 'Training revoked', user.name, `${code} training record set to ${status}.`)
  notify(user.id, null, `training_${code}_${status}_${now.slice(0,10)}`, status === 'verified' ? 'Training record verified' : 'Training access revoked', `${code} is now ${status}. Resource eligibility will reflect this record.`)
  res.json({ ok: true, trainingCode: code, status, trainingCodes: trainingCodesForUser(user.id) })
})

app.patch('/api/notifications/:id/read', requireAuth, (req, res) => {
  const result = db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(nowIso(), req.params.id, req.user.id)
  if (!result.changes) return fail(res, 404, 'Notification not found.', 'NOT_FOUND')
  res.json({ ok: true })
})

app.get('/api/audit.csv', requireAuth, (req, res) => {
  const data = makeWorkspace(req.user).audit
  const headers = ['Timestamp','Actor','Action','Target','Details']
  const escape = value => `"${String(value ?? '').replaceAll('"','""')}"`
  const csv = [headers, ...data.map(row => [row.createdAt,row.actor,row.action,row.target,row.detail])].map(row => row.map(escape).join(',')).join('\r\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="campushare-audit-log.csv"')
  res.send(csv)
})

// The API and the built React application share one origin in production.
app.use(express.static(path.join(projectRoot, 'dist'), { index: false, maxAge: isProduction ? '1h' : 0 }))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  const indexFile = path.join(projectRoot, 'dist', 'index.html')
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile)
  return res.status(404).send('CampusShare X frontend is not built yet. In development, run npm run dev. For production, run npm run build first.')
})
app.use((err, _req, res, _next) => {
  console.error(err)
  if (res.headersSent) return
  res.status(500).json({ error: 'Unexpected server error. Check the server log for details.', code: 'INTERNAL_ERROR' })
})

function timeValue(value) { const [h,m] = value.split(':').map(Number); return h * 60 + m }
const reminderTimer = setInterval(generateScheduledNotifications, 60_000)
reminderTimer.unref()

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3001)
  app.listen(port, '0.0.0.0', () => console.log(`CampusShare X server listening on http://localhost:${port} (database: ${dbFile})`))
}

export { app, db }
