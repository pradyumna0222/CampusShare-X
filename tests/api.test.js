import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campushare-x-test-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = tempDir
process.env.DATABASE_FILE = path.join(tempDir, 'test.sqlite')
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

const { app, db } = await import('../server/index.js')
const student = request.agent(app)
const secondStudent = request.agent(app)
const owner = request.agent(app)
const admin = request.agent(app)

function campusDatePlus(days) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const val = key => parts.find(x => x.type === key)?.value
  const current = `${val('year')}-${val('month')}-${val('day')}`
  const d = new Date(`${current}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
}
async function signIn(agent, email, password) {
  const res = await agent.post('/api/auth/login').send({ email, password }).expect(200)
  assert.ok(res.body.user?.id)
  return res.body.user
}

// This single integration test exercises the real HTTP handlers against a temporary SQLite database.
test('CampusShare X end-to-end journey, policy enforcement, fairness and audit', async () => {
  const health = await request(app).get('/api/health').expect(200)
  assert.equal(health.body.status, 'ok')
  await request(app).get('/api/workspace').expect(401)

  const s1 = await signIn(student, 'student@campusshare.local', 'CampusStudent!2026')
  const s2 = await signIn(secondStudent, 'student2@campusshare.local', 'CampusStudent2!2026')
  await signIn(owner, 'owner@campusshare.local', 'CampusOwner!2026')
  const adminUser = await signIn(admin, 'admin@campusshare.local', 'CampusAdmin!2026')

  const initial = await student.get('/api/workspace').expect(200)
  assert.ok(initial.body.resources.some(r => r.id === 'res-esp32'))
  assert.ok(initial.body.resources.some(r => r.id === 'res-scope'))

  // A resource can be relevant to a project and still be blocked by eligibility.
  const date = campusDatePlus(2)
  await student.post('/api/bookings').send({ resourceId: 'res-scope', startDate: date, startTime: '10:00', endTime: '11:00', purpose: 'IoT circuit testing' }).expect(403)

  // Competing requests can be recorded; owner approval causes the overlapping request to enter the waitlist.
  const first = await student.post('/api/bookings').send({ resourceId: 'res-esp32', startDate: date, startTime: '10:00', endTime: '12:00', purpose: 'IoT prototype and sensor testing' }).expect(201)
  const second = await secondStudent.post('/api/bookings').send({ resourceId: 'res-esp32', startDate: date, startTime: '10:00', endTime: '12:00', purpose: 'IoT coursework prototype' }).expect(201)
  assert.equal(first.body.booking.status, 'pending')
  assert.equal(second.body.booking.status, 'pending')
  await owner.patch(`/api/bookings/${first.body.booking.id}/status`).send({ status: 'approved', reason: 'First eligible request within the published request-order policy.' }).expect(200)

  const ownerWorkspace = await owner.get('/api/workspace').expect(200)
  const waitlisted = ownerWorkspace.body.bookings.find(b => b.id === second.body.booking.id)
  assert.equal(waitlisted.status, 'waitlisted')

  await student.post(`/api/bookings/${first.body.booking.id}/check-in`).send({ condition: 'good', notes: 'Complete kit checked at handover.' }).expect(200)
  const extension = await student.post(`/api/bookings/${first.body.booking.id}/extension`).send({ requestedEndTime: '13:00', reason: 'Need additional time for sensor integration tests.' }).expect(201)
  assert.equal(extension.body.status, 'pending')
  await owner.patch(`/api/extensions/${extension.body.id}/decision`).send({ status: 'approved', reason: 'No competing booking is recorded in the extended interval.' }).expect(200)
  const afterExtension = await student.get('/api/workspace').expect(200)
  assert.equal(afterExtension.body.bookings.find(b => b.id === first.body.booking.id).endTime, '13:00')
  assert.equal(afterExtension.body.extensions.find(e => e.id === extension.body.id).status, 'approved')

  await student.post(`/api/bookings/${first.body.booking.id}/return`).send({ condition: 'minor', notes: 'One jumper wire is missing; needs owner inspection.' }).expect(200)
  const withIncident = await owner.get('/api/workspace').expect(200)
  const incident = withIncident.body.incidents.find(i => i.bookingId === first.body.booking.id)
  assert.ok(incident)
  assert.equal(incident.status, 'open')
  await owner.patch(`/api/incidents/${incident.id}/resolve`).send({ resolution: 'Inspected the kit; replacement wire added and inventory count updated.' }).expect(200)
  const resolved = await owner.get('/api/workspace').expect(200)
  assert.equal(resolved.body.incidents.find(i => i.id === incident.id).status, 'resolved')
  assert.ok(resolved.body.audit.some(e => e.action === 'Resource returned'))
  assert.ok(resolved.body.audit.some(e => e.action === 'Extension approved'))
  await owner.get('/api/audit.csv').expect(200).expect('Content-Type', /text\/csv/)

  // A verified administrator may update training; eligibility is re-evaluated against that record.
  await admin.put(`/api/users/${s1.id}/training`).send({ trainingCode: 'lab-safety', status: 'verified' }).expect(200)
  const scopeRequest = await student.post('/api/bookings').send({ resourceId: 'res-scope', startDate: campusDatePlus(3), startTime: '10:00', endTime: '11:00', purpose: 'Oscilloscope practice for an IoT project' }).expect(201)
  assert.equal(scopeRequest.body.booking.status, 'pending')

  // A user cannot manage another owner's resource.
  const outsider = await secondStudent.patch('/api/resources/res-esp32/status').send({ status: 'maintenance' })
  assert.ok([403, 404].includes(outsider.status))

  // New registrations require institutional review before booking.
  const newStudent = request.agent(app)
  await newStudent.post('/api/auth/register').send({ name: 'Test New Student', email: 'new.student@test.invalid', password: 'NewStudentSecure!2026' }).expect(201)
  const pendingProfile = await newStudent.get('/api/workspace').expect(200)
  assert.equal(pendingProfile.body.user.verificationStatus, 'pending')
  await newStudent.post('/api/bookings').send({ resourceId: 'res-esp32', startDate: campusDatePlus(4), startTime: '10:00', endTime: '11:00', purpose: 'Project testing' }).expect(403)
  const users = await admin.get('/api/users').expect(200)
  const created = users.body.users.find(u => u.email === 'new.student@test.invalid')
  assert.ok(created)
  await admin.patch(`/api/users/${created.id}/verification`).send({ status: 'verified' }).expect(200)
  const verifiedProfile = await newStudent.get('/api/workspace').expect(200)
  assert.equal(verifiedProfile.body.user.verificationStatus, 'verified')
})

after(() => {
  try { db.close() } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true })
})
