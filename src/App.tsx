import { useEffect, useMemo, useState, type ReactNode, type FormEvent } from 'react'
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight, BarChart3,
  Bell, CalendarDays, Camera, Check, CheckCircle2, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Cpu, DoorOpen, Download, FileCheck2,
  Filter, GraduationCap, HardDrive, History, Home,
  Laptop, ListChecks, LockKeyhole, LogIn, LogOut, Mail, MapPin, Menu, Package, PackageCheck, Plus, QrCode,
  Search, Shield, ShieldAlert, ShieldCheck, Sparkles, UserCheck, UserPlus, Users,
  Wrench, X, Zap, type LucideIcon,
} from 'lucide-react'

type Role = 'student' | 'owner' | 'admin'
type ResourceStatus = 'available' | 'maintenance' | 'inactive'
type BookingStatus = 'pending' | 'approved' | 'rejected' | 'waitlisted' | 'checked_out' | 'returned' | 'cancelled'
type ConditionValue = 'good' | 'minor' | 'damage'
type Resource = {
  id: string; name: string; category: string; description: string; location: string;
  ownerId: string; ownerName: string; capabilityTags: string[]; requiredTraining: string[];
  status: ResourceStatus; icon: string; gradient: string; assetCode: string; uses: number;
  instructions: string; valueLabel: string;
}
type Booking = {
  id: string; resourceId: string; resourceName: string; userId: string; userName: string;
  startDate: string; startTime: string; endTime: string; purpose: string; status: BookingStatus;
  decisionReason?: string; conditionBefore?: ConditionValue; conditionBeforeNotes?: string;
  conditionAfter?: ConditionValue; conditionAfterNotes?: string; createdAt: string;
  eligibilityPassed?: boolean; eligibilityReason?: string | null;
}
type Incident = { id: string; bookingId: string; resourceName: string; reporter: string; description: string; severity: 'low' | 'medium' | 'high'; status: 'open' | 'in_review' | 'resolved'; createdAt: string; resolution?: string }
type AuditEvent = { id: string; actor: string; action: string; target: string; detail: string; createdAt: string }
type AppNotification = { id: string; kind: string; title: string; body: string; readAt?: string; createdAt: string }
type ExtensionRequest = { id: string; bookingId: string; resourceId: string; resourceName: string; userId: string; userName: string; startDate: string; originalEndTime: string; currentEndTime: string; requestedEndTime: string; reason: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; decisionReason?: string; createdAt: string }
type Slot = { startTime: string; endTime: string; status?: string; reason?: string }
type AvailabilitySnapshot = { resourceId: string; date: string; timezone: string; resourceStatus: ResourceStatus; eligibility: { status: 'eligible' | 'blocked'; reason: string | null }; confirmedSlots: Slot[]; pendingRequests: Slot[]; maintenanceBlocks: Slot[]; checkedAt: string }
type UserProfile = { id: string; name: string; email: string; role: Role; title: string; initials: string; verificationStatus: 'pending' | 'verified' | 'rejected'; trainingCodes: string[]; createdAt?: string }
type DirectoryUser = { id: string; name: string; email: string; role: Role; verificationStatus: 'pending' | 'verified' | 'rejected'; trainingCodes?: string[]; createdAt: string }
type Store = { resources: Resource[]; bookings: Booking[]; incidents: Incident[]; audit: AuditEvent[]; notifications: AppNotification[]; extensions: ExtensionRequest[] }
type NavKey = 'overview' | 'explore' | 'bookings' | 'manage' | 'passport' | 'insights' | 'verification'
type ModalState = { type: 'booking'; resource: Resource } | { type: 'extension'; booking: Booking } | { type: 'block'; resource: Resource } | { type: 'resource' } | { type: 'condition'; booking: Booking; stage: 'before' | 'after' } | { type: 'incident'; booking?: Booking } | { type: 'resourceDetail'; resource: Resource } | null

const daysFromNow = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const formatDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
const timeAgo = (date: string) => { const diff = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000)); if (diff < 1) return 'just now'; if (diff < 60) return `${diff}m ago`; if (diff < 1440) return `${Math.floor(diff / 60)}h ago`; return `${Math.floor(diff / 1440)}d ago` }
const emptyStore = (): Store => ({ resources: [], bookings: [], incidents: [], audit: [], notifications: [], extensions: [] })

async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {})
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' })
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json() : { error: await response.text() }
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`) as Error & { status?: number; code?: string }
    error.status = response.status
    error.code = payload?.code
    throw error
  }
  return payload as T
}

const iconMap: Record<string, LucideIcon> = { cpu: Cpu, zap: Zap, activity: Activity, camera: Camera, laptop: Laptop, door: DoorOpen, wrench: Wrench, package: Package, harddrive: HardDrive }
function ResourceIcon({ resource, size = 26 }: { resource: Resource; size?: number }) { const Icon = iconMap[resource.icon] || Package; return <Icon size={size} strokeWidth={1.7} /> }
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet' }) { return <span className={`badge badge-${tone}`}>{children}</span> }
function StatusBadge({ status }: { status: BookingStatus | ResourceStatus | Incident['status'] }) {
  const labels: Record<string, string> = { pending: 'Pending review', approved: 'Approved', rejected: 'Declined', waitlisted: 'Waitlisted', checked_out: 'Checked out', returned: 'Returned', cancelled: 'Cancelled', available: 'Available', maintenance: 'Maintenance', inactive: 'Inactive', open: 'Open', in_review: 'In review', resolved: 'Resolved' }
  const tone: Record<string, 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet'> = { pending: 'amber', approved: 'green', rejected: 'red', waitlisted: 'violet', checked_out: 'blue', returned: 'neutral', cancelled: 'neutral', available: 'green', maintenance: 'amber', inactive: 'red', open: 'red', in_review: 'amber', resolved: 'green' }
  return <Badge tone={tone[status] || 'neutral'}>{labels[status] || status}</Badge>
}
function Avatar({ initials, tone = '' }: { initials: string; tone?: string }) { return <span className={`avatar ${tone}`}>{initials}</span> }
function Modal({ title, eyebrow, onClose, children, wide = false }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true"><div className="modal-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button></div>{children}</div></div>
}

function App() {
  const [store, setStore] = useState<Store>(() => emptyStore())
  const [authUser, setAuthUser] = useState<UserProfile | null>(null)
  const [booting, setBooting] = useState(true)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [userDirectory, setUserDirectory] = useState<DirectoryUser[]>([])
  const [trainingUserId, setTrainingUserId] = useState('')
  const [trainingCode, setTrainingCode] = useState('lab-safety')
  const [nav, setNav] = useState<NavKey>('overview')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All resources')
  const [goal, setGoal] = useState('I need to build an IoT prototype and test a sensor circuit today.')
  const [smartSearched, setSmartSearched] = useState(false)
  const [smartScores, setSmartScores] = useState<Record<string, number>>({})
  const [smartReasons, setSmartReasons] = useState<Record<string, string[]>>({})
  const [smartMode, setSmartMode] = useState('rule-based')
  const [modal, setModal] = useState<ModalState>(null)
  const [toast, setToast] = useState('')
  const [showNotifications, setShowNotifications] = useState(false)
  const [condition, setCondition] = useState<ConditionValue>('good')
  const [conditionNotes, setConditionNotes] = useState('')
  const [incidentDescription, setIncidentDescription] = useState('')
  const [incidentSeverity, setIncidentSeverity] = useState<'low' | 'medium' | 'high'>('medium')
  const [bookingDate, setBookingDate] = useState(daysFromNow(0))
  const [bookingStart, setBookingStart] = useState('15:00')
  const [bookingEnd, setBookingEnd] = useState('17:00')
  const [bookingPurpose, setBookingPurpose] = useState('IoT prototype and sensor testing')
  const [extensionEndTime, setExtensionEndTime] = useState('18:00')
  const [extensionReason, setExtensionReason] = useState('Additional time required to finish testing and record results.')
  const [blockDate, setBlockDate] = useState(daysFromNow(1))
  const [blockStart, setBlockStart] = useState('09:00')
  const [blockEnd, setBlockEnd] = useState('11:00')
  const [blockReason, setBlockReason] = useState('Scheduled maintenance and safety inspection.')
  const [newResource, setNewResource] = useState({ name: '', category: 'Electronics', location: '', description: '', tags: 'iot, electronics, prototype', training: '' })
  const [incidentBooking, setIncidentBooking] = useState<Booking | undefined>()
  const [mobileMenu, setMobileMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const [slotInfo, setSlotInfo] = useState<AvailabilitySnapshot | null>(null)
  const [slotLoading, setSlotLoading] = useState(false)
  const [slotError, setSlotError] = useState('')
  const selectedResourceId = modal?.type === 'booking' ? modal.resource.id : ''

  function applyWorkspace(data: any) {
    setAuthUser(data.user)
    setStore({ resources: data.resources || [], bookings: data.bookings || [], incidents: data.incidents || [], audit: data.audit || [], notifications: data.notifications || [], extensions: data.extensions || [] })
    setUserDirectory(data.users || [])
  }
  async function refreshWorkspace() {
    const data = await api('/api/workspace')
    applyWorkspace(data)
    return data
  }
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const session = await api<{ user: UserProfile }>('/api/auth/me')
        if (!active) return
        setAuthUser(session.user)
        const workspace = await api('/api/workspace')
        if (active) applyWorkspace(workspace)
      } catch {
        if (active) setAuthUser(null)
      } finally {
        if (active) setBooting(false)
      }
    })()
    return () => { active = false }
  }, [])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3800); return () => window.clearTimeout(timer) }, [toast])
  useEffect(() => {
    if (!selectedResourceId || !bookingDate) { setSlotInfo(null); setSlotError(''); setSlotLoading(false); return }
    let active = true
    setSlotLoading(true); setSlotError('')
    api<AvailabilitySnapshot>(`/api/resources/${encodeURIComponent(selectedResourceId)}/availability?date=${encodeURIComponent(bookingDate)}`)
      .then(result => { if (active) setSlotInfo(result) })
      .catch(error => { if (active) { setSlotInfo(null); setSlotError(error instanceof Error ? error.message : 'Could not verify the schedule.') } })
      .finally(() => { if (active) setSlotLoading(false) })
    return () => { active = false }
  }, [selectedResourceId, bookingDate])

  const currentUser: UserProfile = authUser || { id: '', name: '', email: '', role: 'student', title: 'Student', initials: 'U', verificationStatus: 'pending', trainingCodes: [] }
  const role = currentUser.role
  const navItems: { key: NavKey; label: string; icon: LucideIcon; group: string }[] = [
    { key: 'overview', label: 'Overview', icon: Home, group: 'Workspace' },
    { key: 'explore', label: 'Explore resources', icon: Search, group: 'Workspace' },
    { key: 'bookings', label: 'My bookings', icon: CalendarDays, group: 'Workspace' },
    { key: 'manage', label: 'Owner console', icon: PackageCheck, group: 'Management' },
    { key: 'passport', label: 'Resource passport', icon: FileCheck2, group: 'Management' },
    { key: 'insights', label: 'Insights & analytics', icon: BarChart3, group: 'Management' },
    { key: 'verification', label: 'User verification', icon: Users, group: 'Administration' },
  ]
  const visibleNavItems = navItems.filter(item => {
    if (role === 'student' && ['manage', 'insights', 'verification'].includes(item.key)) return false
    if (role === 'owner' && ['verification'].includes(item.key)) return false
    return true
  })
  const myBookings = useMemo(() => store.bookings.filter(b => b.userId === currentUser.id), [store.bookings, currentUser.id])
  const pendingCount = store.bookings.filter(b => b.status === 'pending').length
  const visibleIncidents = store.incidents.filter(i => role !== 'student' || i.reporter === currentUser.name || store.bookings.some(b => b.id === i.bookingId && b.userId === currentUser.id))
  const visibleAudit = store.audit
  const openIncidents = visibleIncidents.filter(i => i.status !== 'resolved').length
  const categories = ['All resources', ...Array.from(new Set(store.resources.map(r => r.category)))]
  const unreadCount = store.notifications.filter(n => !n.readAt).length

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthError(''); setBusy(true)
    try {
      const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register'
      const body = authMode === 'login' ? { email: authEmail, password: authPassword } : { name: authName, email: authEmail, password: authPassword }
      const result = await api<{ user: UserProfile }>(path, { method: 'POST', body: JSON.stringify(body) })
      setAuthUser(result.user)
      await refreshWorkspace()
      setNav('overview')
      setAuthPassword('')
      setToast(authMode === 'register' ? 'Account created. Institutional verification is required before booking.' : `Welcome back, ${result.user.name.split(' ')[0]}.`)
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Unable to authenticate.') }
    finally { setBusy(false) }
  }
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }) } catch { /* local sign-out below still clears the UI */ }
    setAuthUser(null); setStore(emptyStore()); setUserDirectory([]); setNav('overview'); setShowNotifications(false); setAuthPassword(''); setAuthError(''); setToast('You have signed out.')
  }
  function navigate(key: NavKey) {
    if (role === 'student' && ['manage', 'insights', 'verification'].includes(key)) { setToast('This workspace requires an authorised role.'); return }
    if (role === 'owner' && key === 'verification') { setToast('User verification requires an administrator.'); return }
    setNav(key); setMobileMenu(false); setShowNotifications(false)
    if (key === 'verification') void refreshWorkspace().catch(error => setToast(error.message))
  }
  function isEligible(resource: Resource, userId = currentUser.id) {
    if (userId === currentUser.id) return currentUser.verificationStatus === 'verified' && resource.requiredTraining.every(t => currentUser.trainingCodes.includes(t))
    const booking = store.bookings.find(b => b.userId === userId && b.resourceId === resource.id)
    return Boolean(booking?.eligibilityPassed)
  }
  function matchingScore(resource: Resource) {
    if (smartScores[resource.id] !== undefined) return smartScores[resource.id]
    const text = `${goal} ${search}`.toLowerCase()
    const map: Record<string, string[]> = { iot: ['iot', 'sensor', 'microcontroller', 'prototype', 'electronics', 'circuit'], video: ['video', 'camera', 'recording', 'documentation'], meeting: ['meeting', 'team', 'presentation', 'collaboration'], testing: ['testing', 'measurement', 'signal', 'debugging', 'circuit'] }
    const requested: string[] = []
    if (/iot|sensor|arduino|esp32|microcontroller|prototype|circuit/.test(text)) requested.push(...map.iot)
    if (/video|record|camera|document/.test(text)) requested.push(...map.video)
    if (/meeting|team|presentation/.test(text)) requested.push(...map.meeting)
    if (/test|measure|debug|signal/.test(text)) requested.push(...map.testing)
    if (!requested.length) requested.push(...text.split(/\W+/).filter(w => w.length > 3))
    const matched = new Set(resource.capabilityTags.filter(t => requested.some(q => t.includes(q) || q.includes(t))))
    const raw = Math.round((matched.size / Math.max(3, new Set(requested).size * 0.38)) * 100)
    return Math.max(0, Math.min(99, raw))
  }
  const filteredResources = useMemo(() => {
    const q = search.toLowerCase().trim()
    return [...store.resources].filter(r => (category === 'All resources' || r.category === category) && (!q || `${r.name} ${r.description} ${r.category} ${r.location} ${r.capabilityTags.join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => (smartSearched ? matchingScore(b) - matchingScore(a) : (a.status === 'available' ? -1 : 1)))
  }, [store.resources, category, search, smartSearched, goal, smartScores])

  async function runSmartMatch() {
    if (goal.trim().length < 3) { setToast('Describe what you are trying to build or accomplish.'); return }
    setSmartSearched(true); setSearch(''); setCategory('All resources'); navigate('explore'); setBusy(true)
    try {
      const result = await api<{ results: { resourceId: string; matchScore: number; reasons: string[] }[]; reasoningMode: string }>('/api/smartmatch', { method: 'POST', body: JSON.stringify({ goal }) })
      setSmartScores(Object.fromEntries(result.results.map(item => [item.resourceId, item.matchScore])))
      setSmartReasons(Object.fromEntries(result.results.map(item => [item.resourceId, item.reasons])))
      setSmartMode(result.reasoningMode === 'llm-assisted' ? 'AI-assisted' : 'capability matcher')
      setToast(`SmartMatch ranked ${result.results.length} resources using ${result.reasoningMode === 'llm-assisted' ? 'AI-assisted intent extraction' : 'the capability-matching engine'}.`)
    } catch (error) { setToast(error instanceof Error ? error.message : 'SmartMatch could not run.') }
    finally { setBusy(false) }
  }
  function timeToMinutes(t: string) { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  function openBooking(resource: Resource) {
    if (currentUser.verificationStatus !== 'verified') { setToast('Your profile must be institutionally verified before you can request resources.'); return }
    if (resource.status !== 'available') { setToast('This resource is not operational for new requests.'); return }
    if (!isEligible(resource)) { setToast('Access blocked: complete the required training before requesting this resource.'); return }
    const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1)
    if (d.getHours() >= 22) { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0) }
    const end = new Date(d); end.setHours(end.getHours() + 2)
    const startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    setBookingDate(startDate); setBookingStart(`${String(d.getHours()).padStart(2, '0')}:00`); setBookingEnd(`${String(end.getHours()).padStart(2, '0')}:00`); setBookingPurpose(goal.trim() || 'Project work'); setModal({ type: 'booking', resource })
  }
  async function submitBooking(resource: Resource, asWaitlist: boolean) {
    if (!bookingDate || !bookingStart || !bookingEnd || timeToMinutes(bookingEnd) <= timeToMinutes(bookingStart)) { setToast('Choose a valid date and end time after the start time.'); return }
    if (!isEligible(resource)) { setToast('Eligibility requirements are not satisfied.'); setModal(null); return }
    setBusy(true)
    try {
      await api('/api/bookings', { method: 'POST', body: JSON.stringify({ resourceId: resource.id, startDate: bookingDate, startTime: bookingStart, endTime: bookingEnd, purpose: bookingPurpose.trim() || 'Project work', waitlist: asWaitlist }) })
      await refreshWorkspace()
      setModal(null); setNav('bookings'); setToast(asWaitlist ? 'Waitlist request recorded in the shared database.' : 'Booking request submitted to the resource owner.')
    } catch (error) { setToast(error instanceof Error ? error.message : 'Booking request failed.'); if ((error as any)?.code === 'SLOT_CONFLICT') setToast('That slot has a confirmed booking. Choose “Join waitlist” or select another time.') }
    finally { setBusy(false) }
  }
  async function updateBookingStatus(booking: Booking, status: BookingStatus, reason?: string) {
    setBusy(true)
    try {
      if (status === 'cancelled') await api(`/api/bookings/${encodeURIComponent(booking.id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason || 'Cancelled by the requester.' }) })
      else await api(`/api/bookings/${encodeURIComponent(booking.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status, reason }) })
      await refreshWorkspace()
      setToast(`Booking ${status.replace('_', ' ')} was recorded by the server.`)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not update booking.') }
    finally { setBusy(false) }
  }
  function doCheckIn(booking: Booking) { setCondition('good'); setConditionNotes(''); setModal({ type: 'condition', booking, stage: 'before' }) }
  function doReturn(booking: Booking) { setCondition('good'); setConditionNotes(''); setModal({ type: 'condition', booking, stage: 'after' }) }
  async function saveCondition(booking: Booking, stage: 'before' | 'after') {
    if (stage === 'after' && condition !== 'good' && conditionNotes.trim().length < 4) { setToast('Describe the issue before completing the return.'); return }
    setBusy(true)
    try {
      const endpoint = stage === 'before' ? `/api/bookings/${encodeURIComponent(booking.id)}/check-in` : `/api/bookings/${encodeURIComponent(booking.id)}/return`
      await api(endpoint, { method: 'POST', body: JSON.stringify({ condition, notes: conditionNotes.trim() }) })
      await refreshWorkspace()
      setModal(null); setToast(stage === 'before' ? 'Check-in and initial condition were saved to the database.' : condition === 'good' ? 'Return completed and recorded.' : 'Return recorded; an incident has been opened for authorised review.')
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not save condition record.') }
    finally { setBusy(false) }
  }
  function openExtension(booking: Booking) {
    const [h, m] = booking.endTime.split(':').map(Number)
    const suggested = Math.min(23, h + 1)
    setExtensionEndTime(`${String(suggested).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    setExtensionReason('Additional time required to finish testing and record results.')
    setModal({ type: 'extension', booking })
  }
  async function submitExtension(booking: Booking) {
    if (extensionEndTime <= booking.endTime) { setToast('The requested return time must be later than the current return time.'); return }
    if (extensionReason.trim().length < 4) { setToast('Explain why you need the extension.'); return }
    setBusy(true)
    try {
      await api(`/api/bookings/${encodeURIComponent(booking.id)}/extension`, { method: 'POST', body: JSON.stringify({ requestedEndTime: extensionEndTime, reason: extensionReason.trim() }) })
      await refreshWorkspace(); setModal(null); setToast('Extension request sent to the resource owner for review.')
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not request an extension.') }
    finally { setBusy(false) }
  }
  async function decideExtension(extension: ExtensionRequest, status: 'approved' | 'rejected') {
    let reason = status === 'approved' ? 'Extension approved after checking the resource schedule.' : ''
    if (status === 'rejected') {
      const entered = window.prompt('Why is the extension being rejected? This reason is visible to the requester and saved to the audit trail.')
      if (entered === null) return
      reason = entered.trim()
      if (reason.length < 4) { setToast('Enter a clear reason for rejecting the extension.'); return }
    }
    setBusy(true)
    try {
      await api(`/api/extensions/${encodeURIComponent(extension.id)}/decision`, { method: 'PATCH', body: JSON.stringify({ status, reason }) })
      await refreshWorkspace(); setToast(`Extension ${status} and recorded in the audit history.`)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not process the extension request.') }
    finally { setBusy(false) }
  }

  function openBlock(resource: Resource) {
    setBlockDate(daysFromNow(1)); setBlockStart('09:00'); setBlockEnd('11:00'); setBlockReason('Scheduled maintenance and safety inspection.')
    setModal({ type: 'block', resource })
  }
  async function submitBlock(resource: Resource) {
    if (!blockDate || !blockStart || !blockEnd || blockEnd <= blockStart || blockReason.trim().length < 4) { setToast('Choose a valid future time range and provide a reason.'); return }
    setBusy(true)
    try {
      await api(`/api/resources/${encodeURIComponent(resource.id)}/blocks`, { method: 'POST', body: JSON.stringify({ startDate: blockDate, startTime: blockStart, endTime: blockEnd, reason: blockReason.trim() }) })
      await refreshWorkspace(); setModal(null); setToast('Maintenance / unavailable block recorded. Conflicting bookings will be rejected.')
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not block the selected time.') }
    finally { setBusy(false) }
  }

  async function addResource() {
    if (role === 'student') { setToast('Listing a resource requires an authorised owner account.'); return }
    if (!newResource.name.trim() || !newResource.location.trim()) { setToast('Add a resource name and location.'); return }
    setBusy(true)
    try {
      await api('/api/resources', { method: 'POST', body: JSON.stringify({ name: newResource.name.trim(), category: newResource.category, location: newResource.location.trim(), description: newResource.description.trim() || 'Institution-managed shared resource.', capabilityTags: newResource.tags.split(',').map(x => x.trim().toLowerCase()).filter(Boolean), requiredTraining: newResource.training.trim() ? [newResource.training.trim().toLowerCase().replaceAll(' ', '-')] : [], instructions: 'Follow the owner-provided usage and return instructions.', status: 'available' }) })
      await refreshWorkspace()
      setModal(null); setNewResource({ name: '', category: 'Electronics', location: '', description: '', tags: 'iot, electronics, prototype', training: '' }); setToast('Resource created in the shared inventory.')
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not add resource.') }
    finally { setBusy(false) }
  }
  async function submitIncident(booking?: Booking) {
    if (!incidentDescription.trim()) { setToast('Describe the issue before submitting.'); return }
    const target = booking || store.bookings.find(b => b.userId === currentUser.id && (b.status === 'returned' || b.status === 'checked_out'))
    if (!target) { setToast('Select a booking related to this incident.'); return }
    setBusy(true)
    try {
      await api('/api/incidents', { method: 'POST', body: JSON.stringify({ bookingId: target.id, description: incidentDescription.trim(), severity: incidentSeverity }) })
      await refreshWorkspace()
      setIncidentDescription(''); setIncidentSeverity('medium'); setModal(null); setNav('passport'); setToast('Incident submitted for authorised human review.')
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not submit incident.') }
    finally { setBusy(false) }
  }
  async function resolveIncident(incident: Incident) {
    if (role === 'student') { setToast('Incident resolution requires an authorised reviewer.'); return }
    const resolution = window.prompt('Enter a short resolution note for the audit trail:')
    if (!resolution?.trim()) return
    setBusy(true)
    try {
      await api(`/api/incidents/${encodeURIComponent(incident.id)}/resolve`, { method: 'PATCH', body: JSON.stringify({ resolution: resolution.trim() }) })
      await refreshWorkspace(); setToast('Incident resolved and saved to the audit history.')
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not resolve incident.') }
    finally { setBusy(false) }
  }
  async function verifyUser(user: DirectoryUser, status: 'verified' | 'rejected' | 'pending') {
    setBusy(true)
    try {
      await api(`/api/users/${encodeURIComponent(user.id)}/verification`, { method: 'PATCH', body: JSON.stringify({ status }) })
      await refreshWorkspace(); setToast(`${user.name}'s profile status was updated to ${status}.`)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not update verification.') }
    finally { setBusy(false) }
  }
  async function changeResourceStatus(resource: Resource, status: ResourceStatus) {
    setBusy(true)
    try {
      await api(`/api/resources/${encodeURIComponent(resource.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })
      await refreshWorkspace()
      setToast(`${resource.name} status changed to ${status.replace('_', ' ')}.`)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not update resource status.') }
    finally { setBusy(false) }
  }
  async function changeUserRole(person: DirectoryUser, role: 'student' | 'owner') {
    if (person.verificationStatus !== 'verified') { setToast('Verify this institutional profile before granting resource-owner privileges.'); return }
    setBusy(true)
    try {
      await api(`/api/users/${encodeURIComponent(person.id)}/role`, { method: 'PATCH', body: JSON.stringify({ role }) })
      await refreshWorkspace()
      setToast(`${person.name} is now assigned the ${role === 'owner' ? 'resource owner' : 'student'} role.`)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not update the user role.') }
    finally { setBusy(false) }
  }
  async function updateTraining(person: DirectoryUser, status: 'verified' | 'expired') {
    const code = trainingCode.trim().toLowerCase().replaceAll(' ', '-')
    if (!code || code.length < 2) { setToast('Enter a valid training identifier.'); return }
    setBusy(true)
    try {
      await api(`/api/users/${encodeURIComponent(person.id)}/training`, { method: 'PUT', body: JSON.stringify({ trainingCode: code, status }) })
      await refreshWorkspace()
      setToast(status === 'verified' ? `${code} training verified for ${person.name}.` : `${code} training access revoked for ${person.name}.`)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not update training records.') }
    finally { setBusy(false) }
  }
  async function openNotification(notification: AppNotification) {
    try { await api(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: 'PATCH', body: '{}' }); await refreshWorkspace() } catch { /* notification display remains available */ }
    setShowNotifications(false)
    if (notification.kind.includes('incident')) navigate('passport')
    else if (notification.kind.includes('verification') && role === 'admin') navigate('verification')
    else navigate(role === 'student' ? 'bookings' : 'manage')
  }
  async function exportAudit() {
    try {
      const response = await fetch('/api/audit.csv', { credentials: 'same-origin' })
      if (!response.ok) throw new Error('Audit export failed. Please sign in again.')
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'campushare-audit-log.csv'; a.click(); URL.revokeObjectURL(url); setToast('Authorised audit records exported as CSV.')
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not export audit history.') }
  }

  const resourceFor = (booking: Booking) => store.resources.find(r => r.id === booking.resourceId)
  const statusCounts = { pending: store.bookings.filter(b => b.status === 'pending').length, approved: store.bookings.filter(b => b.status === 'approved').length, checkedOut: store.bookings.filter(b => b.status === 'checked_out').length, incidents: openIncidents }
  const showBookings = role === 'student' ? myBookings : store.bookings
  const topTitle: Record<NavKey, string> = { overview: 'Overview', explore: 'Explore resources', bookings: role === 'student' ? 'My bookings' : 'Booking activity', manage: 'Owner console', passport: 'Resource passport', insights: 'Insights & analytics', verification: 'User verification' }

  if (booting) return <div className="auth-page"><div className="auth-loading"><div className="brand-mark"><PackageCheck size={24} /></div><h2>CampusShare X</h2><p>Connecting to the institutional resource workspace…</p></div></div>
  if (!authUser) return <AuthScreen mode={authMode} setMode={mode => { setAuthMode(mode); setAuthError('') }} name={authName} setName={setAuthName} email={authEmail} setEmail={setAuthEmail} password={authPassword} setPassword={setAuthPassword} error={authError} busy={busy} onSubmit={submitAuth} />

  return <div className="app-shell">
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><PackageCheck size={22} /></div><div className="brand-text"><span>CampusShare</span><small>RESOURCE EXCHANGE</small></div><button className="sidebar-close icon-button" onClick={() => setMobileMenu(false)} aria-label="Close menu"><X size={18} /></button></div>
      <div className="workspace-picker"><div className="workspace-icon"><span>AV</span></div><div className="workspace-info"><strong>Campus workspace</strong><small>Institution workspace</small></div><ChevronDown size={15} /></div>
      <nav className="side-nav" aria-label="Main navigation">
        {(['Workspace', 'Management', 'Administration'] as const).map(group => <div key={group} className="nav-group">{visibleNavItems.some(n => n.group === group) && <div className="nav-caption">{group}</div>}{visibleNavItems.filter(n => n.group === group).map(item => { const Icon = item.icon; return <button key={item.key} className={`nav-link ${nav === item.key ? 'active' : ''}`} onClick={() => navigate(item.key)}><Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.key === 'manage' && role !== 'student' && pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}</button> })}</div>)}
      </nav>
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><CircleHelp size={18} /></div><strong>Need a hand?</strong><p>Learn how safe sharing works across campus.</p><button onClick={() => setToast('Workflow: discover a resource → check eligibility → request a slot → owner review → condition-recorded handover → return and audit.')}>View workflow guide <ArrowRight size={14} /></button></div><div className="sidebar-foot"><span className="online-dot" /> Connected · persistent database</div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="mobile-menu-button icon-button" onClick={() => setMobileMenu(true)} aria-label="Open menu"><Menu size={19} /></button><div className="breadcrumb"><span>Campus workspace</span><ChevronRight size={14} /><strong>{topTitle[nav]}</strong></div></div><div className="topbar-actions"><div className="connection-label"><span className="online-dot" /> LIVE WORKSPACE</div><div className="notification-wrap"><button className={`icon-button notification-button ${showNotifications ? 'selected' : ''}`} onClick={() => setShowNotifications(!showNotifications)} aria-label="Notifications"><Bell size={18} />{unreadCount > 0 && <span className="notification-dot" />}</button>{showNotifications && <div className="notification-popover"><div className="popover-title"><strong>Activity centre</strong><span>{unreadCount} unread</span></div>{store.notifications.slice(0, 8).map(n => <button key={n.id} className="notification-row" onClick={() => void openNotification(n)}><span className={`notif-icon ${n.kind.includes('incident') || n.kind.includes('overdue') ? 'red' : 'amber'}`}>{n.kind.includes('incident') || n.kind.includes('overdue') ? <ShieldAlert size={15} /> : <CalendarDays size={15} />}</span><span><strong>{n.title}</strong><small>{n.body}</small><small>{timeAgo(n.createdAt)}{n.readAt ? ' · Read' : ' · New'}</small></span></button>)}{store.notifications.length === 0 && <div className="empty-note">No notifications yet.</div>}</div>}</div><div className="user-switch"><Avatar initials={currentUser.initials} /><div className="user-switch-info"><strong>{currentUser.name}</strong><small>{currentUser.title}</small></div><span className={`role-chip role-${role}`}>{role === 'admin' ? 'ADMIN' : role === 'owner' ? 'OWNER' : 'STUDENT'}</span><button className="icon-button signout-button" onClick={() => void logout()} title="Sign out" aria-label="Sign out"><LogOut size={17} /></button></div></div></header>

      <div className="page-wrap">
        {nav === 'overview' && <>
          <div className="welcome-row"><div><div className="eyebrow">TODAY, {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}</div><h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {currentUser.name.split(' ')[0]} <span className="wave">✦</span></h1><p className="page-subtitle">Make more of what's already on campus.</p></div><button className="button button-secondary" onClick={() => navigate('explore')}><Search size={16} /> Explore resources</button></div>
          {currentUser.verificationStatus !== 'verified' && <div className="form-warning profile-warning"><ShieldAlert size={18} /><div><strong>Profile verification required</strong><p>Your account is {currentUser.verificationStatus}. You can discover resources, but booking requests remain disabled until an administrator verifies your campus profile.</p></div>{role === 'student' && <span className="badge badge-amber">Pending review</span>}</div>}
          <section className="hero-panel"><div className="hero-content"><div className="hero-chip"><Sparkles size={14} /> SMART RESOURCE DISCOVERY</div><h2>Find the right resource.<br /><span>Make your next idea happen.</span></h2><p>Describe your project and SmartMatch will connect you with relevant campus resources, with access rules and availability clearly explained.</p><div className="hero-search"><Sparkles size={18} /><input value={goal} onChange={e => setGoal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void runSmartMatch() }} aria-label="Describe your project" placeholder="e.g. I need to prototype an IoT sensor..." /><button disabled={busy} onClick={() => void runSmartMatch()}>{busy ? 'Matching…' : 'Find resources'} <ArrowRight size={16} /></button></div><div className="hero-quick-tags"><span>Try:</span><button onClick={() => setGoal('I need to build an IoT prototype and test a sensor circuit today.')}>IoT prototyping</button><button onClick={() => setGoal('I need to record a project demo video.')}>Project video</button><button onClick={() => setGoal('I need a room for a team project meeting.')}>Team meeting</button></div></div><div className="hero-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-center"><PackageCheck size={44} /></div><div className="floating-tile tile-cpu"><Cpu size={22} /><span>IoT kits</span></div><div className="floating-tile tile-shield"><ShieldCheck size={22} /><span>Trusted access</span></div><div className="floating-tile tile-chart"><BarChart3 size={22} /><span>Resource impact</span></div><div className="art-caption"><span className="caption-dot" /> One connected sharing lifecycle</div></div></section>
          <div className="stats-grid"><StatCard icon={Package} label="Listed resources" value={String(store.resources.length).padStart(2, '0')} note="Across campus" tone="violet" /><StatCard icon={CalendarDays} label="Pending requests" value={String(statusCounts.pending).padStart(2, '0')} note={role === 'student' ? 'Awaiting owner review' : 'Require your attention'} tone="amber" /><StatCard icon={PackageCheck} label="Currently checked out" value={String(statusCounts.checkedOut).padStart(2, '0')} note="Active handovers" tone="blue" /><StatCard icon={ShieldCheck} label="Open incidents" value={String(statusCounts.incidents).padStart(2, '0')} note="Human review required" tone="green" /></div>
          <div className="content-grid overview-grid"><section className="panel"><div className="panel-head"><div><h3>Recommended for you</h3><p>Selected for project work and prototyping</p></div><button className="text-button" onClick={() => void runSmartMatch()}>Explore all <ArrowRight size={15} /></button></div><div className="recommendations-list">{[...store.resources].sort((a,b) => matchingScore(b) - matchingScore(a)).slice(0,3).map(r => <ResourceRow key={r.id} resource={r} score={matchingScore(r)} onView={() => setModal({ type: 'resourceDetail', resource: r })} onRequest={() => openBooking(r)} eligible={isEligible(r)} reasons={smartReasons[r.id] || []} />)}</div><div className="panel-footnote"><ShieldCheck size={14} /> Recommendations are not availability confirmations. Dates are checked before request.</div></section><section className="panel"><div className="panel-head"><div><h3>Your next booking</h3><p>Keep your sharing activity on track</p></div><button className="icon-button small" onClick={() => navigate('bookings')} aria-label="View bookings"><ArrowRight size={17} /></button></div>{myBookings.filter(b => ['approved', 'checked_out', 'pending', 'waitlisted'].includes(b.status)).slice(0, 2).length ? myBookings.filter(b => ['approved', 'checked_out', 'pending', 'waitlisted'].includes(b.status)).slice(0, 2).map(b => <div className="upcoming-item" key={b.id}><div className="date-tile"><span>{new Date(`${b.startDate}T12:00:00`).toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()}</span><strong>{new Date(`${b.startDate}T12:00:00`).getDate()}</strong></div><div className="upcoming-info"><strong>{b.resourceName}</strong><span><Clock3 size={13} /> {b.startTime}–{b.endTime} · {shortDate(b.startDate)}</span><StatusBadge status={b.status} /></div><ChevronRight className="muted-arrow" size={16} /></div>) : <div className="empty-state compact"><div className="empty-illustration"><CalendarDays size={25} /></div><strong>No upcoming bookings</strong><p>Explore the catalogue to find your next resource.</p><button className="button button-secondary button-sm" onClick={() => navigate('explore')}>Explore resources</button></div>}<div className="trust-note"><div className="trust-symbol"><ShieldCheck size={17} /></div><div><strong>Every handover counts</strong><p>Condition reports and activity history keep resource sharing transparent.</p><button onClick={() => navigate('passport')}>View resource passport <ArrowRight size={13} /></button></div></div></section></div>
          <div className="bottom-banner"><div className="banner-icon"><QrCode size={22} /></div><div><strong>Make every handover accountable</strong><p>Resource Passport records the before-and-after condition of shared equipment.</p></div><button className="button button-secondary" onClick={() => navigate('passport')}>Explore passports <ArrowRight size={15} /></button></div>
        </>}

        {nav === 'explore' && <>
          <PageHeading eyebrow="DISCOVER · REQUEST · SHARE" title="Explore resources" subtitle="Find the equipment and spaces that help bring your project to life." right={<button className="button button-secondary" onClick={() => { setSearch(''); setCategory('All resources'); setSmartSearched(false); setGoal('I need to build an IoT prototype and test a sensor circuit today.') }}><Filter size={15} /> Reset filters</button>} />
          <section className="smartmatch-card"><div className="smartmatch-icon"><Sparkles size={22} /></div><div className="smartmatch-main"><div className="smartmatch-title"><div><strong>SmartMatch AI</strong><Badge tone="violet">Project-aware search</Badge></div><span>Recommendations are explainable · eligibility enforced separately</span></div>{smartSearched && <div className="smartmatch-result-note"><Sparkles size={14} /><span>Matched using {smartMode}. Scores indicate relevance, not availability or permission.</span></div>}<div className="smartmatch-input"><input value={goal} onChange={e => setGoal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void runSmartMatch() }} placeholder="Describe your project or what you want to do..." /><button className="button button-primary" disabled={busy} onClick={() => void runSmartMatch()}><Sparkles size={15} /> {busy ? 'Matching…' : 'Match resources'}</button></div><div className="smartmatch-hints"><span>Popular goals</span><button onClick={() => { setGoal('I need to build an IoT prototype and test a sensor circuit today.'); }}>IoT prototyping</button><button onClick={() => { setGoal('I need to record a project demo video.'); }}>Project video</button><button onClick={() => { setGoal('I need a room for a team project meeting.'); }}>Team collaboration</button></div></div></section>
          {smartSearched && <div className="match-summary"><div className="match-summary-icon"><Sparkles size={17} /></div><div><strong>Matched to your project goal</strong><p>Ranked by capability relevance. Access restrictions and selected-time availability are checked separately.</p></div><Badge tone="green">Explainable matches</Badge></div>}
          <div className="catalog-toolbar"><div className="catalog-count"><strong>{filteredResources.length} resources</strong><span>in campus catalogue</span></div><div className="catalog-filters"><div className="search-field"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search resources, tags, locations..." /></div><select value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter category">{categories.map(c => <option key={c}>{c}</option>)}</select></div></div>
          <div className="resource-grid">{filteredResources.map(r => <ResourceCard key={r.id} resource={r} score={matchingScore(r)} showScore={smartSearched} eligible={isEligible(r)} onView={() => setModal({ type: 'resourceDetail', resource: r })} onRequest={() => openBooking(r)} />)}</div>
          {filteredResources.length === 0 && <EmptyListing title="No resources found" description="Try a different search or clear the category filter." action={() => { setSearch(''); setCategory('All resources') }} />}
          <div className="catalog-note"><Shield size={16} /><span><strong>Trust by design.</strong> SmartMatch provides recommendations; the booking workflow verifies eligibility and current schedule before accepting a request.</span></div>
        </>}

        {nav === 'bookings' && <>
          <PageHeading eyebrow="YOUR RESOURCE ACTIVITY" title={topTitle.bookings} subtitle={role === 'student' ? 'Track decisions, upcoming handovers and returns in one place.' : 'Review booking requests and resource handovers from the shared database.'} right={<button className="button button-primary" onClick={() => navigate('explore')}><Plus size={16} /> New request</button>} />
          <div className="booking-summary-row"><MiniSummary label="Awaiting review" value={String(showBookings.filter(b => b.status === 'pending').length)} icon={Clock3} tone="amber" /><MiniSummary label="Approved" value={String(showBookings.filter(b => b.status === 'approved').length)} icon={CheckCircle2} tone="green" /><MiniSummary label="Checked out" value={String(showBookings.filter(b => b.status === 'checked_out').length)} icon={PackageCheck} tone="blue" /><MiniSummary label="Completed" value={String(showBookings.filter(b => b.status === 'returned').length)} icon={FileCheck2} tone="violet" /></div>
          <section className="panel booking-panel"><div className="panel-head"><div><h3>Booking activity</h3><p>{role === 'student' ? 'Your requests and active bookings' : 'Requests for resources you manage'}</p></div><div className="inline-legend"><span><i className="legend-dot green" /> Approved</span><span><i className="legend-dot amber" /> Pending</span></div></div>{showBookings.length ? <div className="table-wrap"><table><thead><tr><th>Resource</th>{role !== 'student' && <th>Requester</th>}<th>Date & time</th><th>Purpose</th><th>Status</th><th>Next action</th></tr></thead><tbody>{[...showBookings].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(b => <tr key={b.id}><td><div className="table-resource"><span className="table-resource-icon"><Package size={17} /></span><div><strong>{b.resourceName}</strong><small>{b.id.toUpperCase()}</small></div></div></td>{role !== 'student' && <td><div className="table-person"><Avatar initials={b.userName.split(' ').map(n => n[0]).slice(0, 2).join('')} /><span>{b.userName}</span></div></td>}<td><strong>{shortDate(b.startDate)}</strong><small className="table-subline">{b.startTime}–{b.endTime}</small></td><td className="purpose-cell">{b.purpose}</td><td><StatusBadge status={b.status} /></td><td><BookingActions booking={b} role={role} currentUserId={currentUser.id} onApprove={() => updateBookingStatus(b, 'approved')} onReject={() => updateBookingStatus(b, 'rejected', 'Declined by the resource owner.')} onReview={() => updateBookingStatus(b, 'pending', 'Returned to owner review from waitlist.')} onCheckIn={() => doCheckIn(b)} onReturn={() => doReturn(b)} onCancel={() => updateBookingStatus(b, 'cancelled', 'Cancelled by the requester.')} onExtend={() => openExtension(b)} onIncident={() => { setIncidentBooking(b); setIncidentDescription(''); setModal({ type: 'incident', booking: b }) }} /></td></tr>)}</tbody></table></div> : <EmptyListing title="No bookings yet" description="Once you request a resource, your booking lifecycle will appear here." action={() => navigate('explore')} actionLabel="Explore resources" />}</section>
          <div className="policy-inline"><ShieldCheck size={18} /><div><strong>Approval does not bypass resource policy</strong><p>Eligibility is verified server-side before approval and again before the handover. Conflicting active bookings cannot be approved.</p></div></div>
          {role === 'student' && <section className="panel extension-panel"><div className="panel-head"><div><h3>Extension requests</h3><p>Any change to the return time requires owner approval.</p></div></div>{store.extensions.filter(e => e.userId === currentUser.id).length ? <div className="extension-history-list">{store.extensions.filter(e => e.userId === currentUser.id).map(e => <div className="extension-history-item" key={e.id}><div className="extension-icon"><Clock3 size={17} /></div><div><strong>{e.resourceName}</strong><small>{shortDate(e.startDate)} · {e.currentEndTime} → requested {e.requestedEndTime}</small><small>{e.reason}</small>{e.decisionReason && <small>Decision: {e.decisionReason}</small>}</div><StatusBadge status={e.status === 'approved' ? 'approved' : e.status === 'rejected' ? 'rejected' : e.status === 'cancelled' ? 'cancelled' : 'pending'} /></div>)}</div> : <div className="empty-note">Extension requests for checked-out resources will appear here.</div>}</section>}
        </>}

        {nav === 'manage' && role !== 'student' && <>
          <PageHeading eyebrow="OPERATIONS WORKSPACE" title="Owner console" subtitle="Manage assets, make transparent decisions and keep handovers moving." right={<button className="button button-primary" onClick={() => setModal({ type: 'resource' })}><Plus size={16} /> List a resource</button>} />
          <div className="owner-kpis"><MiniSummary label="My listed resources" value={String(store.resources.filter(r => role === 'admin' || r.ownerId === currentUser.id).length).padStart(2, '0')} icon={Package} tone="violet" /><MiniSummary label="Pending decisions" value={String(store.bookings.filter(b => b.status === 'pending').length).padStart(2, '0')} icon={ListChecks} tone="amber" /><MiniSummary label="Out with users" value={String(store.bookings.filter(b => b.status === 'checked_out').length).padStart(2, '0')} icon={PackageCheck} tone="blue" /><MiniSummary label="Maintenance items" value={String(store.resources.filter(r => r.status === 'maintenance').length).padStart(2, '0')} icon={Wrench} tone="red" /></div>
          <div className="content-grid manage-grid"><section className="panel"><div className="panel-head"><div><h3>Requests requiring attention</h3><p>Oldest requests are listed first. Confirm eligibility and schedule before approval.</p></div><Badge tone={pendingCount > 0 ? 'amber' : 'green'}>{pendingCount} pending</Badge></div><div className="request-stack">{store.bookings.filter(b => b.status === 'pending' || b.status === 'waitlisted').sort((a,b) => a.createdAt.localeCompare(b.createdAt)).map(b => { const r = resourceFor(b); const eligible = r ? isEligible(r, b.userId) : false; return <div className="request-card" key={b.id}><div className="request-user"><Avatar initials={b.userName.split(' ').map(n => n[0]).slice(0, 2).join('')} /><div><strong>{b.userName}</strong><small>{b.purpose}</small></div><StatusBadge status={b.status} /></div><div className="request-details"><span><Package size={14} /> {b.resourceName}</span><span><CalendarDays size={14} /> {shortDate(b.startDate)} · {b.startTime}–{b.endTime}</span></div>{r && r.requiredTraining.length > 0 && <div className={`eligibility-banner ${eligible ? 'pass' : 'block'}`}><ShieldAlert size={15} /><span>{eligible ? 'Training policy passed.' : `Eligibility blocked: ${r.requiredTraining.join(', ')} not present in the verified training records.`}</span></div>}<div className="request-actions">{b.status === 'pending' ? <><button className="button button-primary button-sm" onClick={() => updateBookingStatus(b, 'approved')} disabled={!eligible}><Check size={14} /> Approve</button><button className="button button-secondary button-sm" onClick={() => updateBookingStatus(b, 'waitlisted', 'Placed on the waitlist by the owner.')}>Waitlist</button><button className="button button-ghost-danger button-sm" onClick={() => updateBookingStatus(b, 'rejected', 'Declined by the resource owner.')}>Decline</button></> : <button className="button button-secondary button-sm" onClick={() => updateBookingStatus(b, 'pending', 'Returned to owner review from waitlist.')}>Return to review</button>}</div></div> })}{store.bookings.filter(b => b.status === 'pending' || b.status === 'waitlisted').length === 0 && <div className="empty-state compact"><CheckCircle2 size={28} /><strong>Nothing waiting for review</strong><p>New requests will appear here.</p></div>}</div></section><section className="panel"><div className="panel-head"><div><h3>Resource inventory</h3><p>Manage what's shared across campus</p></div><button className="text-button" onClick={() => navigate('passport')}>View passport <ArrowRight size={14} /></button></div><div className="inventory-list">{store.resources.filter(r => role === 'admin' || r.ownerId === currentUser.id).map(r => <div className="inventory-row" key={r.id}><div className={`inventory-icon gradient-${r.gradient}`}><ResourceIcon resource={r} size={20} /></div><div className="inventory-info"><strong>{r.name}</strong><small>{r.assetCode} · {r.location}</small></div><select className="resource-status-select" value={r.status} disabled={busy} onChange={e => void changeResourceStatus(r, e.target.value as ResourceStatus)} aria-label={`Change status for ${r.name}`}><option value="available">Available</option><option value="maintenance">Maintenance</option><option value="inactive">Inactive</option></select><button className="button button-ghost button-sm" disabled={busy || r.status !== 'available'} onClick={() => openBlock(r)} title="Block a specific future time">Block time</button><button className="icon-button small" onClick={() => setModal({ type: 'resourceDetail', resource: r })} aria-label={`View ${r.name}`}><ChevronRight size={16} /></button></div>)}</div></section></div>
          <section className="panel extension-panel"><div className="panel-head"><div><h3>Booking extension requests</h3><p>Extensions are not active until an authorised owner approves them.</p></div><Badge tone={store.extensions.some(e => e.status === 'pending') ? 'amber' : 'green'}>{store.extensions.filter(e => e.status === 'pending').length} pending</Badge></div>{store.extensions.filter(e => role === 'admin' || e.status === 'pending' || e.userId === currentUser.id).length ? <div className="extension-list">{store.extensions.filter(e => role === 'admin' || e.status === 'pending' || e.userId === currentUser.id).map(e => <div className="extension-row" key={e.id}><div className="extension-icon"><Clock3 size={18} /></div><div className="extension-info"><strong>{e.resourceName}</strong><small>{e.userName} · {shortDate(e.startDate)} · {e.currentEndTime} → {e.requestedEndTime}</small><p>{e.reason}</p>{e.decisionReason && <small>Decision: {e.decisionReason}</small>}</div><StatusBadge status={e.status === 'approved' ? 'approved' : e.status === 'rejected' ? 'rejected' : e.status === 'cancelled' ? 'cancelled' : 'pending'} />{e.status === 'pending' && (role === 'admin' || e.userId !== currentUser.id) && <div className="table-actions"><button className="button button-primary button-sm" disabled={busy} onClick={() => void decideExtension(e,'approved')}>Approve</button><button className="button button-ghost-danger button-sm" disabled={busy} onClick={() => void decideExtension(e,'rejected')}>Reject</button></div>}</div>)}</div> : <div className="empty-note">No extension requests have been submitted.</div>}</section>
          <section className="panel"><div className="panel-head"><div><h3>Recent operational activity</h3><p>Auditable changes across this workspace</p></div><button className="text-button" onClick={() => navigate('passport')}>All activity <ArrowRight size={14} /></button></div><AuditList events={store.audit.slice(0, 5)} /></section>
        </>}

        {nav === 'verification' && role === 'admin' && <>
          <PageHeading eyebrow="ADMINISTRATION" title="User verification" subtitle="Review student account requests before enabling resource access." right={<Badge tone="amber">{userDirectory.filter(u => u.verificationStatus === 'pending').length} pending</Badge>} />
          <div className="verification-note"><ShieldCheck size={19} /><div><strong>Verification is an access control.</strong><p>Only verify profiles when the identity or campus membership evidence has been checked under your institution's process. Verification does not grant training certificates; resource-specific eligibility is checked separately.</p></div></div>
          <section className="panel"><div className="panel-head"><div><h3>Institutional profiles</h3><p>Student self-registration remains restricted until reviewed.</p></div></div>
            {userDirectory.length ? <div className="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Created</th><th>Verification</th><th>Actions</th></tr></thead><tbody>{userDirectory.map(person => <tr key={person.id}><td><div className="table-person"><Avatar initials={person.name.split(' ').map(n => n[0]).slice(0,2).join('')} /><span><strong>{person.name}</strong><small>{person.email}</small></span></div></td><td>{person.role}</td><td>{new Date(person.createdAt).toLocaleDateString('en-IN')}</td><td><StatusBadge status={person.verificationStatus === 'verified' ? 'approved' : person.verificationStatus === 'pending' ? 'pending' : 'rejected'} />{person.trainingCodes && person.trainingCodes.length > 0 && <div className="training-code-list">{person.trainingCodes.map(code => <span key={code}>{code}</span>)}</div>}</td><td><div className="admin-user-actions">{person.role === 'admin' ? <span className="muted-dash">Administrator account</span> : <><div className="table-actions">{person.verificationStatus === 'pending' ? <><button className="button button-primary button-sm" disabled={busy} onClick={() => void verifyUser(person,'verified')}><Check size={14} /> Verify</button><button className="button button-ghost-danger button-sm" disabled={busy} onClick={() => void verifyUser(person,'rejected')}>Reject</button></> : person.verificationStatus === 'verified' ? <button className="button button-secondary button-sm" disabled={busy} onClick={() => void verifyUser(person,'pending')}>Reopen verification</button> : <button className="button button-secondary button-sm" disabled={busy} onClick={() => void verifyUser(person,'pending')}>Review again</button>}</div><button className="button button-secondary button-sm" disabled={busy || person.verificationStatus !== 'verified'} onClick={() => void changeUserRole(person, person.role === 'owner' ? 'student' : 'owner')}>{person.role === 'owner' ? 'Set as student' : 'Make resource owner'}</button></>}</div></td></tr>)}</tbody></table></div> : <EmptyListing title="No user accounts found" description="Registered student profiles will appear here for verification." action={() => void refreshWorkspace()} actionLabel="Refresh" />}
          </section>
          <section className="panel training-admin-panel"><div className="panel-head"><div><h3>Training and qualification records</h3><p>Only an authorised administrator can grant or revoke a verified training record.</p></div><Badge tone="blue">Policy control</Badge></div><div className="training-admin-form"><div className="form-field"><label>Student / resource owner</label><select value={trainingUserId} onChange={e => setTrainingUserId(e.target.value)}><option value="">Select verified account</option>{userDirectory.filter(u => u.role !== 'admin' && u.verificationStatus === 'verified').map(u => <option key={u.id} value={u.id}>{u.name} · {u.role}</option>)}</select></div><div className="form-field"><label>Training identifier</label><input value={trainingCode} onChange={e => setTrainingCode(e.target.value)} placeholder="e.g. lab-safety" list="training-code-suggestions" /><datalist id="training-code-suggestions"><option value="lab-safety" /><option value="soldering-safety" /><option value="laser-safety" /><option value="3d-printer-safety" /><option value="camera-induction" /></datalist></div><div className="training-admin-actions"><button className="button button-primary" disabled={busy || !trainingUserId || !trainingCode.trim()} onClick={() => { const person = userDirectory.find(u => u.id === trainingUserId); if (person) void updateTraining(person, 'verified') }}><GraduationCap size={15} /> Grant / renew training</button><button className="button button-secondary" disabled={busy || !trainingUserId || !trainingCode.trim()} onClick={() => { const person = userDirectory.find(u => u.id === trainingUserId); if (person) void updateTraining(person, 'expired') }}>Revoke training</button></div></div><p className="form-hint">Use the exact training identifier required by the resource policy. For example, <code>lab-safety</code> and <code>soldering-safety</code> are separate permissions.</p></section>
        </>}

        {nav === 'passport' && <>
          <PageHeading eyebrow="TRACEABILITY & ACCOUNTABILITY" title="Resource passport" subtitle="Every shared asset has a history. Every handover is recorded." right={<button className="button button-secondary" onClick={exportAudit}><Download size={15} /> Export audit CSV</button>} />
          <div className="passport-stats"><MiniSummary label="Audit events" value={String(store.audit.length).padStart(2, '0')} icon={History} tone="violet" /><MiniSummary label="Condition reports" value={String(store.bookings.filter(b => b.conditionBefore || b.conditionAfter).length).padStart(2, '0')} icon={FileCheck2} tone="blue" /><MiniSummary label="Open incidents" value={String(openIncidents).padStart(2, '0')} icon={ShieldAlert} tone="red" /></div>
          <section className="panel"><div className="panel-head"><div><h3>Asset passports</h3><p>Identity, policy, condition history and lifecycle events</p></div><div className="search-field compact-search"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find an asset..." /></div></div><div className="passport-grid">{store.resources.filter(r => !search || `${r.name} ${r.assetCode} ${r.location}`.toLowerCase().includes(search.toLowerCase())).map(r => <button className="passport-card" key={r.id} onClick={() => setModal({ type: 'resourceDetail', resource: r })}><div className="passport-card-top"><div className={`inventory-icon gradient-${r.gradient}`}><ResourceIcon resource={r} size={21} /></div><StatusBadge status={r.status} /></div><div className="eyebrow">{r.assetCode}</div><h4>{r.name}</h4><p><MapPin size={13} /> {r.location}</p><div className="passport-card-foot"><span><History size={14} /> {store.audit.filter(e => e.target === r.name).length} recorded events</span><ArrowRight size={15} /></div></button>)}</div></section>
          <div className="content-grid passport-bottom"><section className="panel"><div className="panel-head"><div><h3>Incident register</h3><p>Reports require authorised human review</p></div><Badge tone={openIncidents ? 'red' : 'green'}>{openIncidents} open</Badge></div>{visibleIncidents.length ? <div className="incident-list">{visibleIncidents.map(i => <div className="incident-item" key={i.id}><div className={`incident-icon ${i.severity}`}><AlertCircle size={18} /></div><div className="incident-content"><div className="incident-title"><strong>{i.resourceName}</strong><StatusBadge status={i.status} /></div><p>{i.description}</p><small>Reported by {i.reporter} · {timeAgo(i.createdAt)} · {i.severity} severity</small>{i.resolution && <div className="resolution-note"><CheckCircle2 size={13} /> Resolution: {i.resolution}</div>}</div>{i.status !== 'resolved' && role !== 'student' && <button className="button button-secondary button-sm" onClick={() => resolveIncident(i)}>Resolve</button>}</div>)}</div> : <div className="empty-state compact"><ShieldCheck size={29} /><strong>No incidents reported</strong><p>Any condition issue reported at return will appear here.</p></div>}</section><section className="panel"><div className="panel-head"><div><h3>Audit history</h3><p>Recent access and lifecycle events</p></div><button className="icon-button small" onClick={exportAudit} aria-label="Export audit"><Download size={15} /></button></div><AuditList events={(role === 'student' ? visibleAudit : store.audit).slice(0, 8)} /></section></div>
        </>}

        {nav === 'insights' && role !== 'student' && <>
          <PageHeading eyebrow="INSTITUTIONAL IMPACT" title="Insights & analytics" subtitle="Understand how resources are used and where access can improve." right={<Badge tone="blue">Database-backed metrics</Badge>} />
          <div className="insight-banner"><div className="insight-banner-icon"><BarChart3 size={24} /></div><div><strong>Turn idle assets into measurable opportunity.</strong><p>Metrics are calculated from stored booking and resource records. Replace the initial catalogue with your institution's authorised inventory before relying on operational figures.</p></div></div>
          <div className="stats-grid analytics-stats"><StatCard icon={Package} label="Resources listed" value={String(store.resources.length)} note="Current resource inventory" tone="violet" /><StatCard icon={Activity} label="Average utilisation proxy" value={`${Math.round(store.resources.reduce((s, r) => s + r.uses, 0) / Math.max(store.resources.length, 1))}`} note="Recorded returns per resource" tone="blue" /><StatCard icon={CheckCircle2} label="Completed returns" value={String(store.bookings.filter(b => b.status === 'returned').length)} note="Recorded return transactions" tone="green" /><StatCard icon={Clock3} label="Awaiting decision" value={String(pendingCount)} note="Requests currently pending" tone="amber" /></div>
          <div className="content-grid analytics-grid"><section className="panel"><div className="panel-head"><div><h3>Catalogue by category</h3><p>Resource inventory distribution</p></div></div><div className="category-bars">{Array.from(new Set(store.resources.map(r => r.category))).map(c => { const count = store.resources.filter(r => r.category === c).length; const max = Math.max(...Array.from(new Set(store.resources.map(r => r.category))).map(cat => store.resources.filter(r => r.category === cat).length)); return <div className="bar-row" key={c}><div className="bar-label"><span>{c}</span><strong>{count}</strong></div><div className="bar-track"><div className={`bar-fill ${c === 'Electronics' ? 'fill-violet' : c === 'Testing' ? 'fill-blue' : c === 'Media' ? 'fill-rose' : c === 'Computing' ? 'fill-green' : 'fill-amber'}`} style={{ width: `${(count / max) * 100}%` }} /></div></div> })}</div></section><section className="panel"><div className="panel-head"><div><h3>Lifecycle snapshot</h3><p>Bookings by current status</p></div></div><div className="lifecycle-list">{([{ label: 'Pending review', count: store.bookings.filter(b => b.status === 'pending').length, color: 'amber' }, { label: 'Approved', count: store.bookings.filter(b => b.status === 'approved').length, color: 'green' }, { label: 'Checked out', count: store.bookings.filter(b => b.status === 'checked_out').length, color: 'blue' }, { label: 'Returned', count: store.bookings.filter(b => b.status === 'returned').length, color: 'violet' }, { label: 'Waitlisted', count: store.bookings.filter(b => b.status === 'waitlisted').length, color: 'rose' }] as const).map(item => <div className="lifecycle-row" key={item.label}><span className={`lifecycle-dot ${item.color}`} /><span>{item.label}</span><strong>{item.count}</strong></div>)}</div><div className="analytics-foot"><ShieldCheck size={16} /><span>Use this view to identify bottlenecks and underused resources. Validate conclusions against real usage data before making institutional decisions.</span></div></section></div>
          <section className="panel"><div className="panel-head"><div><h3>Resource demand signals</h3><p>Return counts from recorded transactions</p></div></div><div className="demand-table">{[...store.resources].sort((a, b) => b.uses - a.uses).slice(0, 5).map((r, i) => <div className="demand-row" key={r.id}><span className="rank-number">0{i + 1}</span><div className={`inventory-icon gradient-${r.gradient}`}><ResourceIcon resource={r} size={18} /></div><div className="demand-resource"><strong>{r.name}</strong><small>{r.category} · {r.location}</small></div><div className="demand-meter"><div className="bar-track"><div className="bar-fill fill-violet" style={{ width: `${Math.max(8, r.uses / Math.max(...store.resources.map(x => x.uses)) * 100)}%` }} /></div></div><strong className="uses-number">{r.uses}<small> uses</small></strong></div>)}</div></section>
        </>}
      </div>
      <footer className="app-footer"><div className="footer-brand"><div className="brand-mark mini"><PackageCheck size={15} /></div><span>CampusShare X</span><span className="footer-dot">·</span><span>Trust the handover.</span></div><div><span>Institutional resource workspace</span><span className="footer-dot">·</span><button onClick={() => setToast('Access policy: authentication, role permissions, eligibility, booking transitions and audit records are enforced by the API and database.')}>Security & deployment note</button></div></footer>
    </main>

    {modal?.type === 'booking' && <Modal title="Request this resource" eyebrow="BOOKING REQUEST" onClose={() => setModal(null)}><div className="modal-resource-summary"><div className={`inventory-icon gradient-${modal.resource.gradient}`}><ResourceIcon resource={modal.resource} size={23} /></div><div><strong>{modal.resource.name}</strong><small><MapPin size={12} /> {modal.resource.location}</small></div><StatusBadge status={modal.resource.status} /></div><div className="form-field"><label>Project purpose</label><textarea value={bookingPurpose} onChange={e => setBookingPurpose(e.target.value)} rows={2} placeholder="Explain how you will use the resource" /></div><div className="form-grid"><div className="form-field"><label>Requested date</label><input type="date" min={daysFromNow(0)} value={bookingDate} onChange={e => setBookingDate(e.target.value)} /></div><div className="form-field"><label>Start time</label><input type="time" value={bookingStart} onChange={e => setBookingStart(e.target.value)} /></div><div className="form-field"><label>End time</label><input type="time" value={bookingEnd} onChange={e => setBookingEnd(e.target.value)} /></div></div><div className="availability-panel"><div className="availability-panel-head"><div><strong>Schedule check</strong><small>{bookingDate} · {slotInfo?.timezone || 'Institution local time'}</small></div>{slotLoading ? <Badge tone="blue">Checking…</Badge> : slotInfo ? <Badge tone={slotInfo.resourceStatus === 'available' ? 'green' : 'red'}>{slotInfo.resourceStatus === 'available' ? 'Operational' : slotInfo.resourceStatus}</Badge> : <Badge>Not verified</Badge>}</div>{slotError ? <div className="availability-error"><AlertCircle size={14} /> {slotError}</div> : slotInfo ? <><div className="availability-legend"><span><i className="slot-dot confirmed" /> Confirmed / checked out</span><span><i className="slot-dot pending" /> Pending requests (owner review)</span><span><i className="slot-dot blocked" /> Maintenance blocks</span></div><div className="availability-chip-list">{[...slotInfo.confirmedSlots.map(v => ({...v, kind:'confirmed'})), ...slotInfo.pendingRequests.map(v => ({...v, kind:'pending'})), ...slotInfo.maintenanceBlocks.map(v => ({...v, kind:'blocked'}))].sort((a,b) => a.startTime.localeCompare(b.startTime)).map((v,i) => <span key={`${v.kind}-${v.startTime}-${i}`} className={`availability-chip ${v.kind}`}><strong>{v.startTime}–{v.endTime}</strong><small>{v.kind === 'confirmed' ? 'Reserved' : v.kind === 'pending' ? 'Pending' : v.reason || 'Blocked'}</small></span>)}</div>{slotInfo.confirmedSlots.length + slotInfo.maintenanceBlocks.length === 0 && <div className="availability-clear"><CheckCircle2 size={15} /> No confirmed booking or maintenance block is recorded for this date. The server rechecks conflicts when you submit.</div>}{slotInfo.pendingRequests.length > 0 && <p className="availability-caveat">Pending requests are competing demand, not confirmed reservations. The owner applies the published allocation rules.</p>}{slotInfo.eligibility.status !== 'eligible' && <div className="availability-error"><ShieldAlert size={14} /> {slotInfo.eligibility.reason || 'Eligibility check failed.'}</div>}</> : <p className="availability-caveat">Select a date to check confirmed bookings and recorded maintenance blocks. No slot is promised until the server accepts the request.</p>}</div><div className="form-info"><ShieldCheck size={17} /><span>Eligibility, operational status and schedule conflicts are validated by the server. If a confirmed booking occupies the slot, choose the waitlist option.</span></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button className="button button-secondary" disabled={busy} onClick={() => void submitBooking(modal.resource, true)}>Join waitlist</button><button className="button button-primary" disabled={busy} onClick={() => void submitBooking(modal.resource, false)}>Submit request <ArrowRight size={15} /></button></div></Modal>}

    {modal?.type === 'block' && <Modal title="Block a resource time slot" eyebrow="MAINTENANCE & OPERATIONS" onClose={() => setModal(null)}><div className="condition-resource"><div className="condition-icon"><Wrench size={22} /></div><div><strong>{modal.resource.name}</strong><small>{modal.resource.location}</small></div></div><div className="form-field"><label>Date</label><input type="date" min={daysFromNow(0)} value={blockDate} onChange={e => setBlockDate(e.target.value)} required /></div><div className="form-grid"><div className="form-field"><label>Start time</label><input type="time" value={blockStart} onChange={e => setBlockStart(e.target.value)} required /></div><div className="form-field"><label>End time</label><input type="time" value={blockEnd} onChange={e => setBlockEnd(e.target.value)} required /></div></div><div className="form-field"><label>Reason for block</label><textarea rows={3} value={blockReason} onChange={e => setBlockReason(e.target.value)} minLength={4} required /></div><div className="form-info"><ShieldCheck size={17} /><span>The server rejects time blocks that overlap approved or checked-out bookings. New requests and owner approvals are checked against recorded blocks.</span></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button className="button button-primary" disabled={busy} onClick={() => void submitBlock(modal.resource)}>Save time block</button></div></Modal>}

    {modal?.type === 'extension' && <Modal title="Request a booking extension" eyebrow="RETURN TIME CHANGE" onClose={() => setModal(null)}><div className="condition-resource"><div className="condition-icon"><Clock3 size={22} /></div><div><strong>{modal.booking.resourceName}</strong><small>Current end time: {modal.booking.endTime} · {formatDate(modal.booking.startDate)}</small></div></div><div className="form-field"><label>Requested new return time</label><input type="time" value={extensionEndTime} onChange={e => setExtensionEndTime(e.target.value)} min={modal.booking.endTime} required /></div><div className="form-field"><label>Reason for extension</label><textarea value={extensionReason} onChange={e => setExtensionReason(e.target.value)} rows={3} minLength={4} required placeholder="Explain why extra time is needed." /></div><div className="form-info"><ShieldCheck size={17} /><span>The owner must approve the extension. The server checks booking conflicts and duration again before changing the return time.</span></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button className="button button-primary" disabled={busy} onClick={() => void submitExtension(modal.booking)}>Send extension request <ArrowRight size={15} /></button></div></Modal>}

    {modal?.type === 'condition' && <Modal title={modal.stage === 'before' ? 'Record check-in condition' : 'Confirm resource return'} eyebrow={modal.stage === 'before' ? 'RESOURCE HANDOVER' : 'RESOURCE RETURN'} onClose={() => setModal(null)}><div className="condition-resource"><div className="condition-icon"><FileCheck2 size={22} /></div><div><strong>{modal.booking.resourceName}</strong><small>{modal.booking.userName} · {formatDate(modal.booking.startDate)}</small></div></div><div className="form-field"><label>{modal.stage === 'before' ? 'Initial condition' : 'Condition at return'}</label><div className="condition-options"><button className={condition === 'good' ? 'condition-option selected' : 'condition-option'} onClick={() => setCondition('good')}><CheckCircle2 size={19} /><strong>Good</strong><small>No issue noted</small></button><button className={condition === 'minor' ? 'condition-option selected warning-selected' : 'condition-option'} onClick={() => setCondition('minor')}><AlertCircle size={19} /><strong>Minor issue</strong><small>Needs a note</small></button><button className={condition === 'damage' ? 'condition-option selected danger-selected' : 'condition-option'} onClick={() => setCondition('damage')}><ShieldAlert size={19} /><strong>Damage / missing</strong><small>Manager review</small></button></div></div><div className="form-field"><label>Condition notes {condition !== 'good' && <span className="required-label">Required</span>}</label><textarea value={conditionNotes} onChange={e => setConditionNotes(e.target.value)} rows={3} placeholder={condition === 'good' ? 'Add optional notes about the condition...' : 'Describe what you observed. Avoid assumptions about responsibility.'} /></div>{modal.stage === 'after' && condition !== 'good' && <div className="form-warning"><ShieldAlert size={17} /><span>A reviewable incident will be created. This report does not automatically assign blame or impose a penalty.</span></div>}<div className="modal-actions"><button className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button className="button button-primary" onClick={() => { if (condition !== 'good' && !conditionNotes.trim()) { setToast('Please add a condition note for issues.'); return } saveCondition(modal.booking, modal.stage) }}>{modal.stage === 'before' ? 'Confirm check-in' : 'Confirm return'} <ArrowRight size={15} /></button></div></Modal>}

    {modal?.type === 'resource' && <Modal title="List a resource" eyebrow="RESOURCE INVENTORY" onClose={() => setModal(null)}><p className="modal-intro">Add a shared campus resource with clear location, capabilities and any mandatory training.</p><div className="form-field"><label>Resource name *</label><input value={newResource.name} onChange={e => setNewResource({ ...newResource, name: e.target.value })} placeholder="e.g. ESP32 IoT starter kit" /></div><div className="form-grid"><div className="form-field"><label>Category</label><select value={newResource.category} onChange={e => setNewResource({ ...newResource, category: e.target.value })}>{['Electronics', 'Testing', 'Computing', 'Media', 'Spaces', 'Lab equipment'].map(c => <option key={c}>{c}</option>)}</select></div><div className="form-field"><label>Location *</label><input value={newResource.location} onChange={e => setNewResource({ ...newResource, location: e.target.value })} placeholder="Building / room" /></div></div><div className="form-field"><label>Description</label><textarea value={newResource.description} onChange={e => setNewResource({ ...newResource, description: e.target.value })} rows={2} placeholder="What is this resource used for?" /></div><div className="form-field"><label>Capability tags (comma-separated)</label><input value={newResource.tags} onChange={e => setNewResource({ ...newResource, tags: e.target.value })} placeholder="iot, testing, prototyping" /></div><div className="form-field"><label>Required training ID (optional)</label><input value={newResource.training} onChange={e => setNewResource({ ...newResource, training: e.target.value })} placeholder="e.g. lab-safety" /></div><div className="form-info"><ShieldCheck size={17} /><span>The API records this listing under your authenticated owner profile. Resource rules are rechecked when requests are submitted and approved.</span></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button className="button button-primary" onClick={addResource}>Add resource <Plus size={15} /></button></div></Modal>}

    {modal?.type === 'incident' && <Modal title="Report an incident" eyebrow="RESOURCE SAFETY & ACCOUNTABILITY" onClose={() => setModal(null)}><div className="condition-resource"><div className="condition-icon danger"><ShieldAlert size={22} /></div><div><strong>{modal.booking?.resourceName || incidentBooking?.resourceName || 'Resource incident'}</strong><small>Submitted for authorised human review</small></div></div><div className="form-field"><label>Severity</label><select value={incidentSeverity} onChange={e => setIncidentSeverity(e.target.value as 'low' | 'medium' | 'high')}><option value="low">Low — minor issue</option><option value="medium">Medium — needs investigation</option><option value="high">High — safety or damage concern</option></select></div><div className="form-field"><label>What happened? *</label><textarea rows={4} value={incidentDescription} onChange={e => setIncidentDescription(e.target.value)} placeholder="Describe what you observed, when it happened, and any immediate action taken." /></div><div className="form-info"><ShieldCheck size={17} /><span>Report facts, not assumptions. An authorised manager will review the information before any decision.</span></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setModal(null)}>Cancel</button><button className="button button-primary" onClick={() => submitIncident(modal.booking || incidentBooking)}>Submit incident <ArrowRight size={15} /></button></div></Modal>}

    {modal?.type === 'resourceDetail' && <Modal title={modal.resource.name} eyebrow={`RESOURCE PASSPORT · ${modal.resource.assetCode}`} onClose={() => setModal(null)} wide><div className="detail-hero"><div className={`detail-art gradient-${modal.resource.gradient}`}><ResourceIcon resource={modal.resource} size={48} /></div><div className="detail-main"><div className="detail-badges"><Badge tone="blue">{modal.resource.category}</Badge><StatusBadge status={modal.resource.status} /></div><p>{modal.resource.description}</p><div className="detail-meta"><span><MapPin size={14} /> {modal.resource.location}</span><span><Users size={14} /> Owner: {modal.resource.ownerName}</span><span><History size={14} /> {modal.resource.uses} recorded uses </span></div></div></div><div className="detail-sections"><section><h4>Capabilities</h4><div className="tag-list">{modal.resource.capabilityTags.map(t => <span className="capability-tag" key={t}>{t}</span>)}</div></section><section><h4>Eligibility requirements</h4>{modal.resource.requiredTraining.length ? <div className="requirement-block"><ShieldAlert size={17} /><div><strong>Mandatory training</strong><p>{modal.resource.requiredTraining.join(', ').replaceAll('-', ' ')} must be verified before access.</p></div></div> : <div className="requirement-block success"><ShieldCheck size={17} /><div><strong>No additional training prerequisite</strong><p>Other institution, membership and booking policies still apply.</p></div></div>}</section><section><h4>Usage & return instructions</h4><p className="detail-instructions">{modal.resource.instructions}</p></section><section><h4>Passport activity</h4><AuditList events={store.audit.filter(e => e.target === modal.resource.name).slice(0, 4)} /></section></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setModal(null)}>Close</button><button className="button button-primary" disabled={modal.resource.status !== 'available' || !isEligible(modal.resource)} onClick={() => openBooking(modal.resource)}>Request resource <ArrowRight size={15} /></button></div></Modal>}

    {toast && <div className="toast" role="status"><span className="toast-check"><Check size={15} /></span><span>{toast}</span><button className="icon-button" onClick={() => setToast('')} aria-label="Dismiss notification"><X size={15} /></button></div>}
  </div>
}

type AuthScreenProps = {
  mode: 'login' | 'register'
  setMode: (mode: 'login' | 'register') => void
  name: string
  setName: (value: string) => void
  email: string
  setEmail: (value: string) => void
  password: string
  setPassword: (value: string) => void
  error: string
  busy: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

function AuthScreen({ mode, setMode, name, setName, email, setEmail, password, setPassword, error, busy, onSubmit }: AuthScreenProps) {
  const registering = mode === 'register'
  return <main className="auth-page"><div className="auth-topbar"><div className="brand-mark"><PackageCheck size={23} /></div><div><strong>CampusShare X</strong><small>RESOURCE EXCHANGE</small></div><span className="auth-topbar-note"><ShieldCheck size={15} /> Verified sharing workspace</span></div><div className="auth-layout"><section className="auth-story"><div className="auth-story-chip"><Sparkles size={14} /> TRUST-AWARE RESOURCE SHARING</div><h1>Make more of<br /><span>what already exists.</span></h1><p>Discover equipment and spaces, request access under clear rules, and keep every handover accountable.</p><div className="auth-feature-list"><div><span><Search size={17} /></span><div><strong>Discover intelligently</strong><small>Find resources by project goal and capability.</small></div></div><div><span><ShieldCheck size={17} /></span><div><strong>Share responsibly</strong><small>Eligibility, owner approval and human review.</small></div></div><div><span><History size={17} /></span><div><strong>Keep a traceable record</strong><small>Condition reports, decisions and audit history.</small></div></div></div><div className="auth-story-foot"><span className="online-dot" /> One connected resource lifecycle</div></section><section className="auth-card"><div className="auth-card-icon">{registering ? <UserPlus size={22} /> : <LogIn size={22} />}</div><div className="eyebrow">{registering ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</div><h2>{registering ? 'Join your campus' : 'Sign in to CampusShare'}</h2><p className="auth-card-subtitle">{registering ? 'Register as a student. An administrator must verify your campus profile before you can request resources.' : 'Use your institutional account to access resources and manage your sharing activity.'}</p><form className="auth-form" onSubmit={onSubmit}>{registering && <div className="form-field"><label htmlFor="auth-name">Full name</label><div className="auth-input-wrap"><UserCheck size={16} /><input id="auth-name" required minLength={2} maxLength={80} value={name} onChange={e => setName(e.target.value)} autoComplete="name" placeholder="Your full name" /></div></div>}<div className="form-field"><label htmlFor="auth-email">Email address</label><div className="auth-input-wrap"><Mail size={16} /><input id="auth-email" required type="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" placeholder="you@institution.edu" /></div></div><div className="form-field"><label htmlFor="auth-password">Password</label><div className="auth-input-wrap"><LockKeyhole size={16} /><input id="auth-password" required type="password" minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} autoComplete={registering ? 'new-password' : 'current-password'} placeholder="At least 12 characters" /></div><small className="auth-field-help">Use at least 12 characters.</small></div>{error && <div className="auth-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}<button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : registering ? 'Create student account' : 'Sign in'} <ArrowRight size={16} /></button></form><div className="auth-switch">{registering ? 'Already have an account?' : 'New to your campus resource exchange?'} <button type="button" onClick={() => setMode(registering ? 'login' : 'register')}>{registering ? 'Sign in' : 'Create an account'}</button></div><div className="auth-policy-note"><ShieldCheck size={15} /><span>Your account role and eligibility are enforced by the server. Registration does not automatically grant access to restricted resources.</span></div></section></div><footer className="auth-footer">CampusShare X · Institutional resource exchange · Access decisions remain reviewable by authorised staff.</footer></main>
}

function PageHeading({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle: string; right?: ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="page-subtitle">{subtitle}</p></div>{right && <div className="heading-right">{right}</div>}</div> }
function StatCard({ icon: Icon, label, value, note, tone }: { icon: LucideIcon; label: string; value: string; note: string; tone: string }) { return <div className="stat-card"><div className={`stat-icon tone-${tone}`}><Icon size={19} /></div><div className="stat-content"><span>{label}</span><strong>{value}</strong><small>{note}</small></div><div className="stat-corner"><ArrowUpRight size={15} /></div></div> }
function MiniSummary({ label, value, icon: Icon, tone }: { label: string; value: string; icon: LucideIcon; tone: string }) { return <div className="mini-summary"><div className={`mini-summary-icon tone-${tone}`}><Icon size={18} /></div><div><span>{label}</span><strong>{value}</strong></div></div> }
function ResourceRow({ resource, score, onView, onRequest, eligible, reasons = [] }: { resource: Resource; score: number; onView: () => void; onRequest: () => void; eligible: boolean; reasons?: string[] }) { return <div className="recommendation-row"><div className={`resource-visual gradient-${resource.gradient}`}><ResourceIcon resource={resource} size={25} /></div><div className="recommendation-info"><div className="recommendation-title"><strong>{resource.name}</strong><span className="match-percentage"><Sparkles size={12} /> {score}% match</span></div><p>{resource.description}</p>{reasons.length > 0 && <div className="match-reasons">{reasons.slice(0, 2).map(reason => <span key={reason}><CheckCircle2 size={12} /> {reason}</span>)}</div>}<div className="recommendation-meta"><span><MapPin size={12} /> {resource.location}</span>{resource.requiredTraining.length > 0 && <span className="restriction-meta"><GraduationCap size={13} /> Training required</span>}</div></div><div className="recommendation-actions"><button className="icon-button small" onClick={onView} aria-label={`View ${resource.name}`}><ChevronRight size={17} /></button><button className="button button-secondary button-sm" onClick={onRequest} disabled={!eligible || resource.status !== 'available'}>{!eligible ? 'Restricted' : resource.status !== 'available' ? 'Unavailable' : 'Request'}</button></div></div> }
function ResourceCard({ resource, score, showScore, eligible, onView, onRequest }: { resource: Resource; score: number; showScore: boolean; eligible: boolean; onView: () => void; onRequest: () => void }) { return <article className="resource-card"><div className={`resource-card-art gradient-${resource.gradient}`}><div className="art-pattern" /><div className="resource-icon-large"><ResourceIcon resource={resource} size={38} /></div><div className="resource-art-badges"><Badge>{resource.category}</Badge>{showScore && <Badge tone="violet"><Sparkles size={11} /> {score}% match</Badge>}</div><span className="asset-label">{resource.assetCode}</span></div><div className="resource-card-body"><div className="resource-card-head"><h3>{resource.name}</h3><StatusBadge status={resource.status} /></div><p className="resource-description">{resource.description}</p><div className="resource-location"><MapPin size={14} /><span>{resource.location}</span></div><div className="resource-tags">{resource.capabilityTags.slice(0, 3).map(t => <span key={t}>{t}</span>)}{resource.capabilityTags.length > 3 && <span>+{resource.capabilityTags.length - 3}</span>}</div>{resource.requiredTraining.length > 0 ? <div className="access-requirement restricted"><ShieldAlert size={14} /><span>Training required</span></div> : <div className="access-requirement"><ShieldCheck size={14} /><span>No additional training prerequisite</span></div>}<div className="resource-card-actions"><button className="button button-secondary" onClick={onView}>View details</button><button className="button button-primary" onClick={onRequest} disabled={!eligible || resource.status !== 'available'}>{!eligible ? 'Restricted' : resource.status !== 'available' ? 'Unavailable' : 'Request'} <ArrowRight size={14} /></button></div></div></article> }
function BookingActions({ booking, role, currentUserId, onApprove, onReject, onReview, onCheckIn, onReturn, onCancel, onExtend, onIncident }: { booking: Booking; role: Role; currentUserId: string; onApprove: () => void; onReject: () => void; onReview: () => void; onCheckIn: () => void; onReturn: () => void; onCancel: () => void; onExtend: () => void; onIncident: () => void }) { const isOwner = role !== 'student'; const isMine = booking.userId === currentUserId; if (booking.status === 'pending' && isOwner) return <div className="table-actions"><button className="tiny-action approve" onClick={onApprove} title="Approve"><Check size={14} /></button><button className="tiny-action decline" onClick={onReject} title="Decline"><X size={14} /></button></div>; if (booking.status === 'waitlisted' && isOwner) return <button className="button button-secondary button-sm" onClick={onReview}>Review</button>; if (booking.status === 'approved' && (isMine || isOwner)) return <button className="button button-primary button-sm" onClick={onCheckIn}>Check in</button>; if (booking.status === 'checked_out' && (isMine || isOwner)) return <div className="table-actions"><button className="button button-secondary button-sm" onClick={onReturn}>Return</button>{isMine && <button className="button button-ghost button-sm" onClick={onExtend}>Extend</button>}<button className="tiny-action decline" onClick={onIncident} title="Report an incident"><AlertCircle size={14} /></button></div>; if (['pending', 'approved', 'waitlisted'].includes(booking.status) && isMine) return <button className="button button-ghost-danger button-sm" onClick={onCancel}>Cancel</button>; if (booking.status === 'returned' && isMine) return <button className="button button-ghost button-sm" onClick={onIncident}>Report issue</button>; return <span className="muted-dash">—</span> }
function AuditList({ events }: { events: AuditEvent[] }) { return events.length ? <div className="audit-list">{events.map(e => <div className="audit-item" key={e.id}><div className="audit-marker"><History size={14} /></div><div className="audit-copy"><div><strong>{e.action}</strong><span>{timeAgo(e.createdAt)}</span></div><p>{e.target} · {e.detail}</p><small>By {e.actor}</small></div></div>)}</div> : <div className="empty-note">No audit events for this item yet.</div> }
function EmptyListing({ title, description, action, actionLabel = 'Clear filters' }: { title: string; description: string; action: () => void; actionLabel?: string }) { return <div className="empty-state"><div className="empty-illustration"><Search size={26} /></div><h3>{title}</h3><p>{description}</p><button className="button button-secondary" onClick={action}>{actionLabel}</button></div> }

export default App
