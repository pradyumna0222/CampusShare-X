import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campushare-x-pg-test-'))
process.env.NODE_ENV = 'test'
process.env.PGLITE_DATA_DIR = path.join(tempDir, 'pgdata')
process.env.APP_TIMEZONE = 'Asia/Kolkata'
process.env.BOOKING_TIMEZONE_OFFSET_MINUTES = '330'
process.env.INITIAL_STUDENT_EMAIL = 'student@campusshare.local'
process.env.INITIAL_STUDENT_PASSWORD = 'CampusStudent!2026'
process.env.INITIAL_STUDENT2_EMAIL = 'student2@campusshare.local'
process.env.INITIAL_STUDENT2_PASSWORD = 'CampusStudent2!2026'
process.env.INITIAL_OWNER_EMAIL = 'owner@campusshare.local'
process.env.INITIAL_OWNER_PASSWORD = 'CampusOwner!2026'
process.env.INITIAL_ADMIN_EMAIL = 'admin@campusshare.local'
process.env.INITIAL_ADMIN_PASSWORD = 'CampusAdmin!2026'
delete process.env.OPENAI_API_KEY

const { app, closeDb, runMigrations, runSeed, query } = await import('../server/index.js')
const student = request.agent(app)
const secondStudent = request.agent(app)
const owner = request.agent(app)
const admin = request.agent(app)

function campusDatePlus(days) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const val = (key) => parts.find((x) => x.type === key)?.value
  const current = `${val('year')}-${val('month')}-${val('day')}`
  const d = new Date(`${current}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

async function signIn(agent, email, password) {
  const res = await agent.post('/api/auth/login').send({ email, password }).expect(200)
  assert.ok(res.body.user?.id)
  return res.body.user
}

before(async () => {
  await runMigrations()
  await runSeed()
})

test('CampusShare X PostgreSQL: Health check and unauthorized access restrictions', async () => {
  const health = await request(app).get('/api/health').expect(200)
  assert.equal(health.body.status, 'ok')
  assert.equal(health.body.database, 'connected')
  await request(app).get('/api/workspace').expect(401)
})

test('CampusShare X PostgreSQL: Authentication, RBAC, and seeded accounts', async () => {
  const s1 = await signIn(student, 'student@campusshare.local', 'CampusStudent!2026')
  const s2 = await signIn(secondStudent, 'student2@campusshare.local', 'CampusStudent2!2026')
  const ow = await signIn(owner, 'owner@campusshare.local', 'CampusOwner!2026')
  const ad = await signIn(admin, 'admin@campusshare.local', 'CampusAdmin!2026')

  assert.equal(s1.role, 'student')
  assert.equal(s2.role, 'student')
  assert.equal(ow.role, 'owner')
  assert.equal(ad.role, 'admin')

  // Student cannot access admin-only directory
  await student.get('/api/users').expect(403)
  // Admin can access users directory
  const usersRes = await admin.get('/api/users').expect(200)
  assert.ok(usersRes.body.users.length >= 3)
})

test('CampusShare X PostgreSQL: Eligibility verification blocks uncertified training', async () => {
  const date = campusDatePlus(2)
  // Oscilloscope requires lab-safety training which student doesn't have yet
  const res = await student
    .post('/api/bookings')
    .send({ resourceId: 'res-scope', startDate: date, startTime: '10:00', endTime: '11:00', purpose: 'IoT circuit testing' })
    .expect(403)
  assert.equal(res.body.code, 'ELIGIBILITY_BLOCKED')
})

test('CampusShare X PostgreSQL: Booking workflow, owner decision, waitlist, and simultaneous conflict prevention', async () => {
  const date = campusDatePlus(3)

  // Two students submit requests for the same resource & time slot concurrently
  const [firstRes, secondRes] = await Promise.all([
    student.post('/api/bookings').send({ resourceId: 'res-esp32', startDate: date, startTime: '10:00', endTime: '12:00', purpose: 'IoT prototype testing' }),
    secondStudent.post('/api/bookings').send({ resourceId: 'res-esp32', startDate: date, startTime: '10:00', endTime: '12:00', purpose: 'Coursework project testing' }),
  ])

  assert.equal(firstRes.status, 201)
  assert.equal(secondRes.status, 201)
  assert.equal(firstRes.body.booking.status, 'pending')
  assert.equal(secondRes.body.booking.status, 'pending')

  // Owner approves first request; the competing request is moved to the transparent waitlist
  await owner
    .patch(`/api/bookings/${firstRes.body.booking.id}/status`)
    .send({ status: 'approved', reason: 'First eligible request under standard booking policy.' })
    .expect(200)

  const ownerWorkspace = await owner.get('/api/workspace').expect(200)
  const waitlisted = ownerWorkspace.body.bookings.find((b) => b.id === secondRes.body.booking.id)
  assert.equal(waitlisted.status, 'waitlisted')

  // Attempting to book the approved slot without waitlist flag fails with 409
  const thirdRes = await secondStudent
    .post('/api/bookings')
    .send({ resourceId: 'res-esp32', startDate: date, startTime: '10:30', endTime: '11:30', purpose: 'Overlapping request' })
    .expect(409)
  assert.equal(thirdRes.body.code, 'SLOT_CONFLICT')
})

test('CampusShare X PostgreSQL: FairShare limits (maximum 3 active reservations)', async () => {
  // Second student currently has 1 waitlisted booking on date+3
  const d4 = campusDatePlus(4)
  const d5 = campusDatePlus(5)
  const d6 = campusDatePlus(6)

  await secondStudent.post('/api/bookings').send({ resourceId: 'res-sensor', startDate: d4, startTime: '10:00', endTime: '11:00', purpose: 'Sensor test' }).expect(201)
  await secondStudent.post('/api/bookings').send({ resourceId: 'res-multimeter', startDate: d5, startTime: '10:00', endTime: '11:00', purpose: 'Voltage test' }).expect(201)

  // 4th active booking must be blocked by FairShare policy
  const blocked = await secondStudent
    .post('/api/bookings')
    .send({ resourceId: 'res-camera', startDate: d6, startTime: '10:00', endTime: '11:00', purpose: 'Project demo recording' })
    .expect(429)
  assert.equal(blocked.body.code, 'FAIR_USE_LIMIT')
})

test('CampusShare X PostgreSQL: Check-in, extension request & decision, return & condition report', async () => {
  const date = campusDatePlus(7)
  const booking = await student
    .post('/api/bookings')
    .send({ resourceId: 'res-camera', startDate: date, startTime: '14:00', endTime: '15:00', purpose: 'Project documentation photography' })
    .expect(201)

  await owner.patch(`/api/bookings/${booking.body.booking.id}/status`).send({ status: 'approved', reason: 'Media kit approved.' }).expect(200)

  // Check-in
  await student.post(`/api/bookings/${booking.body.booking.id}/check-in`).send({ condition: 'good', notes: 'Camera and tripod in pristine order.' }).expect(200)

  // Request Extension
  const extension = await student
    .post(`/api/bookings/${booking.body.booking.id}/extension`)
    .send({ requestedEndTime: '16:00', reason: 'Need additional time for indoor b-roll capture.' })
    .expect(201)
  assert.equal(extension.body.status, 'pending')

  // Owner approves extension
  await owner.patch(`/api/extensions/${extension.body.id}/decision`).send({ status: 'approved', reason: 'No subsequent slot booked.' }).expect(200)

  const studentWs = await student.get('/api/workspace').expect(200)
  const updatedBooking = studentWs.body.bookings.find((b) => b.id === booking.body.booking.id)
  assert.equal(updatedBooking.endTime, '16:00')

  // Return with minor damage noted
  await student
    .post(`/api/bookings/${booking.body.booking.id}/return`)
    .send({ condition: 'minor', notes: 'Lens cap lanyard clip snapped during transit.' })
    .expect(200)

  // Verify incident was opened
  const ownerWs = await owner.get('/api/workspace').expect(200)
  const incident = ownerWs.body.incidents.find((i) => i.bookingId === booking.body.booking.id)
  assert.ok(incident)
  assert.equal(incident.status, 'open')

  // Owner resolves incident
  await owner.patch(`/api/incidents/${incident.id}/resolve`).send({ resolution: 'Replacement lens cap fitted from spares supply.' }).expect(200)

  const resolvedWs = await owner.get('/api/workspace').expect(200)
  assert.equal(resolvedWs.body.incidents.find((i) => i.id === incident.id).status, 'resolved')
})

test('CampusShare X PostgreSQL: Resource maintenance blocks', async () => {
  const date = campusDatePlus(8)
  // Owner schedules maintenance block
  const block = await owner
    .post('/api/resources/res-esp32/blocks')
    .send({ startDate: date, startTime: '13:00', endTime: '15:00', reason: 'Firmware flashing and pin headers replacement' })
    .expect(201)

  assert.equal(block.body.reason, 'Firmware flashing and pin headers replacement')

  // Booking overlapping maintenance block is rejected
  const res = await student
    .post('/api/bookings')
    .send({ resourceId: 'res-esp32', startDate: date, startTime: '14:00', endTime: '16:00', purpose: 'Overlapping maintenance test' })
    .expect(409)
  assert.equal(res.body.code, 'RESOURCE_BLOCKED')
})

test('CampusShare X PostgreSQL: Admin profile verification and training granting', async () => {
  // New registration
  const newAgent = request.agent(app)
  const regRes = await newAgent
    .post('/api/auth/register')
    .send({ name: 'Kavya Pillai', email: 'kavya@test.edu', password: 'KavyaSecurePassword2026!' })
    .expect(201)
  assert.equal(regRes.body.user.verificationStatus, 'pending')

  // Pending user cannot book
  await newAgent
    .post('/api/bookings')
    .send({ resourceId: 'res-esp32', startDate: campusDatePlus(9), startTime: '10:00', endTime: '11:00', purpose: 'New student test' })
    .expect(403)

  // Admin verifies user
  await admin.patch(`/api/users/${regRes.body.user.id}/verification`).send({ status: 'verified' }).expect(200)

  // Admin verifies lab-safety training
  await admin.put(`/api/users/${regRes.body.user.id}/training`).send({ trainingCode: 'lab-safety', status: 'verified' }).expect(200)

  // Now user can book the restricted oscilloscope
  await newAgent
    .post('/api/bookings')
    .send({ resourceId: 'res-scope', startDate: campusDatePlus(9), startTime: '10:00', endTime: '11:00', purpose: 'Oscilloscope experiment' })
    .expect(201)
})

test('CampusShare X PostgreSQL: Audit log trail and CSV export', async () => {
  const auditRes = await owner.get('/api/audit.csv').expect(200).expect('Content-Type', /text\/csv/)
  assert.ok(auditRes.text.includes('"Timestamp","Actor","Action","Target","Details"'))
  assert.ok(auditRes.text.includes('Resource returned'))
})

test('CampusShare X PostgreSQL: Persistent data across pool reconnection', async () => {
  // Close database pool and reopen to simulate application restart
  await closeDb()

  const freshRes = await query('SELECT count(*)::int as user_count FROM users')
  assert.ok(freshRes.rows[0].user_count >= 4, 'Users must persist across database restarts')

  const bookingsRes = await query('SELECT count(*)::int as booking_count FROM bookings')
  assert.ok(bookingsRes.rows[0].booking_count >= 1, 'Bookings must persist across database restarts')
})

after(async () => {
  try {
    await closeDb()
  } catch {}
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {}
})
