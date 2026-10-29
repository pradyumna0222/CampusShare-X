import 'dotenv/config'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { query, withTransaction } from './index.js'

const isProduction = process.env.NODE_ENV === 'production'
const nowIso = () => new Date().toISOString()
const makeId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`

const DEV_DEFAULTS = {
  studentEmail: 'student@campusshare.local',
  studentPassword: 'CampusStudent!2026',
  secondStudentEmail: 'student2@campusshare.local',
  secondStudentPassword: 'CampusStudent2!2026',
  ownerEmail: 'owner@campusshare.local',
  ownerPassword: 'CampusOwner!2026',
  adminEmail: 'admin@campusshare.local',
  adminPassword: 'CampusAdmin!2026',
}

export async function ensureSeedUsers() {
  const countRes = await query('SELECT COUNT(*)::int as n FROM users')
  if (countRes.rows[0].n > 0) return

  if (isProduction && process.env.SEED_INITIAL_ACCOUNTS !== 'true') {
    throw new Error('No users exist in the database. Set SEED_INITIAL_ACCOUNTS=true and provide unique INITIAL_* credentials in Render environment variables for initial setup.')
  }

  const studentEmail = process.env.INITIAL_STUDENT_EMAIL || (!isProduction ? DEV_DEFAULTS.studentEmail : '')
  const studentPassword = process.env.INITIAL_STUDENT_PASSWORD || (!isProduction ? DEV_DEFAULTS.studentPassword : '')
  const secondStudentEmail = process.env.INITIAL_STUDENT2_EMAIL || (!isProduction ? DEV_DEFAULTS.secondStudentEmail : '')
  const secondStudentPassword = process.env.INITIAL_STUDENT2_PASSWORD || (!isProduction ? DEV_DEFAULTS.secondStudentPassword : '')
  const ownerEmail = process.env.INITIAL_OWNER_EMAIL || (!isProduction ? DEV_DEFAULTS.ownerEmail : '')
  const ownerPassword = process.env.INITIAL_OWNER_PASSWORD || (!isProduction ? DEV_DEFAULTS.ownerPassword : '')
  const adminEmail = process.env.INITIAL_ADMIN_EMAIL || (!isProduction ? DEV_DEFAULTS.adminEmail : '')
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || (!isProduction ? DEV_DEFAULTS.adminPassword : '')

  const required = [
    { key: 'INITIAL_STUDENT_EMAIL', val: studentEmail, minLen: 5 },
    { key: 'INITIAL_STUDENT_PASSWORD', val: studentPassword, minLen: 12 },
    { key: 'INITIAL_OWNER_EMAIL', val: ownerEmail, minLen: 5 },
    { key: 'INITIAL_OWNER_PASSWORD', val: ownerPassword, minLen: 12 },
    { key: 'INITIAL_ADMIN_EMAIL', val: adminEmail, minLen: 5 },
    { key: 'INITIAL_ADMIN_PASSWORD', val: adminPassword, minLen: 12 },
  ]

  for (const { key, val, minLen } of required) {
    if (!val || val.length < minLen) {
      throw new Error(`Initial account credential ${key} is missing or too short (minimum ${minLen} characters required).`)
    }
  }

  if (isProduction) {
    // Prohibit deploying known default passwords in production
    const prohibitedPasswords = Object.values(DEV_DEFAULTS).filter((v) => v.includes('!'))
    if (prohibitedPasswords.includes(studentPassword) || prohibitedPasswords.includes(ownerPassword) || prohibitedPasswords.includes(adminPassword)) {
      throw new Error('Security violation: Production deployment cannot use sample/development passwords. Set unique INITIAL_*_PASSWORD values.')
    }
  }

  const timestamp = nowIso()
  const usersToSeed = [
    { id: 'student-aarav', name: 'Aarav Menon', email: studentEmail.toLowerCase(), pass: studentPassword, role: 'student', title: 'Student · Project team' },
    { id: 'owner-meera', name: 'Dr. Meera Iyer', email: ownerEmail.toLowerCase(), pass: ownerPassword, role: 'owner', title: 'Resource owner' },
    { id: 'admin-nikhil', name: 'Nikhil Rao', email: adminEmail.toLowerCase(), pass: adminPassword, role: 'admin', title: 'Campus administrator' },
  ]

  if (secondStudentEmail && secondStudentPassword) {
    usersToSeed.push({
      id: 'student-diya',
      name: 'Diya Sharma',
      email: secondStudentEmail.toLowerCase(),
      pass: secondStudentPassword,
      role: 'student',
      title: 'Student · Research team',
    })
  }

  await withTransaction(async (client) => {
    for (const u of usersToSeed) {
      const hash = bcrypt.hashSync(u.pass, 12)
      await client.query(
        `INSERT INTO users(id, name, email, password_hash, role, title, verification_status, verified_at, created_at)
         VALUES($1, $2, $3, $4, $5, $6, 'verified', $7, $8)
         ON CONFLICT (email) DO NOTHING`,
        [u.id, u.name, u.email, hash, u.role, u.title, timestamp, timestamp]
      )
    }
  })

  console.log(`[CampusShare DB Seed] Seeded ${usersToSeed.length} initial institutional accounts.`)
}

export async function ensureSeedResources() {
  const countRes = await query('SELECT COUNT(*)::int as n FROM resources')
  if (countRes.rows[0].n > 0) return

  if (isProduction && process.env.SEED_INITIAL_RESOURCES !== 'true') return

  const ownerRes = await query("SELECT id, name FROM users WHERE role='owner' ORDER BY created_at ASC LIMIT 1")
  const owner = ownerRes.rows[0]
  if (!owner) return

  const catalog = [
    {
      id: 'res-esp32',
      name: 'ESP32 IoT Starter Kit',
      category: 'Electronics',
      description: 'Wi-Fi and Bluetooth microcontroller board with basic prototyping accessories.',
      location: 'Innovation Lab · B-204',
      tags: ['iot', 'microcontroller', 'sensor', 'programming', 'prototype', 'electronics'],
      training: [],
      status: 'available',
      icon: 'cpu',
      gradient: 'violet',
      asset: 'CSX-EL-042',
      instructions: 'Return all jumper wires and sensors to the labelled tray. Keep power within the kit rating.',
      label: 'Starter kit',
    },
    {
      id: 'res-sensor',
      name: 'Sensor & Breadboard Kit',
      category: 'Electronics',
      description: 'Breadboard, jumper wires, LEDs, resistors and common environmental sensors.',
      location: 'Innovation Lab · B-204',
      tags: ['iot', 'sensor', 'prototype', 'circuit', 'electronics', 'breadboard'],
      training: [],
      status: 'available',
      icon: 'zap',
      gradient: 'amber',
      asset: 'CSX-EL-057',
      instructions: 'Count components before returning. Store sensor modules in their labelled compartments.',
      label: 'Component kit',
    },
    {
      id: 'res-multimeter',
      name: 'Digital Multimeter',
      category: 'Testing',
      description: 'Handheld instrument for voltage, resistance and continuity measurements.',
      location: 'Electronics Store · C-110',
      tags: ['testing', 'measurement', 'voltage', 'circuit', 'debugging', 'electronics'],
      training: [],
      status: 'available',
      icon: 'activity',
      gradient: 'blue',
      asset: 'CSX-TM-014',
      instructions: 'Inspect probe insulation before use. Return both probes with the instrument.',
      label: 'Test instrument',
    },
    {
      id: 'res-scope',
      name: 'Digital Oscilloscope',
      category: 'Testing',
      description: 'Bench oscilloscope for signal, timing and communication debugging.',
      location: 'Advanced Electronics Lab · C-212',
      tags: ['testing', 'signal', 'measurement', 'circuit', 'debugging', 'electronics'],
      training: ['lab-safety'],
      status: 'available',
      icon: 'activity',
      gradient: 'teal',
      asset: 'CSX-TM-006',
      instructions: 'Lab safety induction is mandatory. Use approved probes and remain within rated limits.',
      label: 'Restricted instrument',
    },
    {
      id: 'res-camera',
      name: 'DSLR Camera Kit',
      category: 'Media',
      description: 'Camera body, lens, battery, charger and tripod for project documentation.',
      location: 'Media Desk · A-105',
      tags: ['video', 'camera', 'recording', 'documentation', 'photography'],
      training: [],
      status: 'available',
      icon: 'camera',
      gradient: 'rose',
      asset: 'CSX-MD-021',
      instructions: 'Keep the lens cap on when not in use. Return the battery and charger with the kit.',
      label: 'Media kit',
    },
    {
      id: 'res-laptop',
      name: 'Development Laptop',
      category: 'Computing',
      description: 'Configured laptop for software development, embedded tooling and project presentations.',
      location: 'Computing Hub · D-301',
      tags: ['programming', 'development', 'iot', 'coding', 'prototype', 'computing'],
      training: [],
      status: 'available',
      icon: 'laptop',
      gradient: 'indigo',
      asset: 'CSX-IT-018',
      instructions: 'Save work to your own storage and sign out of all accounts before return.',
      label: 'Computing device',
    },
    {
      id: 'res-room',
      name: 'Project Collaboration Room',
      category: 'Spaces',
      description: 'Four-person project room with display, whiteboard and video-conference setup.',
      location: 'Learning Commons · Level 2',
      tags: ['meeting', 'team', 'presentation', 'collaboration', 'project', 'room'],
      training: [],
      status: 'available',
      icon: 'door',
      gradient: 'green',
      asset: 'CSX-SP-011',
      instructions: 'Leave the room ready for the next group and clear the whiteboard.',
      label: 'Bookable space',
    },
    {
      id: 'res-solder',
      name: 'Soldering Workstation',
      category: 'Lab equipment',
      description: 'Supervised soldering station with fume extraction and basic hand tools.',
      location: 'Fabrication Lab · F-108',
      tags: ['electronics', 'soldering', 'circuit', 'prototype', 'fabrication'],
      training: ['soldering-safety'],
      status: 'maintenance',
      icon: 'wrench',
      gradient: 'slate',
      asset: 'CSX-FB-009',
      instructions: 'Training and staff supervision are required. The resource is currently in maintenance.',
      label: 'Supervised workstation',
    },
  ]

  await withTransaction(async (client) => {
    for (const r of catalog) {
      await client.query(
        `INSERT INTO resources(id, name, category, description, location, owner_id, capability_tags, required_training, status, icon, gradient, asset_code, uses, instructions, value_label, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO NOTHING`,
        [
          r.id,
          r.name,
          r.category,
          r.description,
          r.location,
          owner.id,
          JSON.stringify(r.tags),
          JSON.stringify(r.training),
          r.status,
          r.icon,
          r.gradient,
          r.asset,
          0,
          r.instructions,
          r.label,
          nowIso(),
        ]
      )

      await client.query(
        `INSERT INTO audit_events(id, actor_id, actor_name, action, target, detail, resource_id, booking_id, created_at)
         VALUES($1, NULL, 'System', 'Resource registered', $2, 'Initial resource catalogue record created.', $3, NULL, $4)`,
        [makeId('evt'), r.name, r.id, nowIso()]
      )
    }
  })

  console.log(`[CampusShare DB Seed] Seeded ${catalog.length} initial shared resources for owner ${owner.name}.`)
}

export async function runSeed() {
  await ensureSeedUsers()
  await ensureSeedResources()
}
