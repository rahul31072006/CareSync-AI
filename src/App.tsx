import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity, Bell, CalendarDays, Check, ClipboardCheck,
  Clock3, FileUp, HandHeart, HeartPulse, Home, LogOut, Mic, Pill, Pencil, Plus, Send,
  RefreshCw, Settings2, ShieldCheck, Sparkles, Stethoscope, Trash2, Users, Waves, X,
} from 'lucide-react'
import { ApiError, getToken, jsonBody, request, requestBlob, setToken } from './api'
import type {
  Appointment, AuditItem, CareTask, Dose, Handover, Member, Medication, Notification,
  MedicineInformation, Patient, Prescription, PrescriptionMedicineResult, ReminderSettings, Routine, RoutineTemplate,
} from './types'

type Page = 'home' | 'medications' | 'routines' | 'appointments' | 'prescriptions' | 'team' | 'activity' | 'notifications' | 'settings'
type Bundle = {
  meds: Medication[]; doses: Dose[]; appointments: Appointment[]; routines: Routine[]; routineTemplates: RoutineTemplate[]
  members: Member[]; notes: { id: number; body: string; created_at: string }[]; handovers: Handover[]
  prescriptions: Prescription[]; audit: AuditItem[]; notifications: Notification[]; settings: ReminderSettings; tasks: CareTask[]
  adherence: { date: string; total: number; taken: number; skipped: number; not_taken: number; unconfirmed: number }[]
}
const emptyBundle: Bundle = {
  meds: [], doses: [], appointments: [], routines: [], routineTemplates: [], members: [], notes: [], handovers: [],
  prescriptions: [], audit: [], notifications: [], settings: { initial_minutes: 5, followup_minutes: 30, escalation_minutes: 45, notify_caretakers: true, notify_family: true }, adherence: [], tasks: [],
}
const navigation: { id: Page; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Overview', icon: Home }, { id: 'medications', label: 'Medications', icon: Pill },
  { id: 'routines', label: 'Daily routines', icon: ClipboardCheck }, { id: 'appointments', label: 'Appointments', icon: CalendarDays },
  { id: 'prescriptions', label: 'Prescriptions', icon: FileUp }, { id: 'team', label: 'Care team', icon: Users },
  { id: 'activity', label: 'Care timeline', icon: Activity }, { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'settings', label: 'Settings', icon: Settings2 },
]
const title: Record<Page, string> = {
  home: 'Good care, in one place', medications: 'Medication plan', routines: 'Daily routines', appointments: 'Appointments',
  prescriptions: 'Prescription review', team: 'Care team', activity: 'Care timeline', notifications: 'Notifications', settings: 'Care settings',
}
const dateText = (value: string, opts?: Intl.DateTimeFormatOptions) => new Date(value).toLocaleString(undefined, opts || { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const timeText = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const today = () => new Date().toISOString().slice(0, 10)
const patientPath = (pid: number, suffix: string) => `/patients/${pid}/${suffix}`

function Brand() {
  return <div className="brand"><div className="brand-mark"><HeartPulse size={23} strokeWidth={2.4} /></div><span>CareSync <span style={{ color: '#16786f' }}>AI</span></span></div>
}
function Button({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`btn ${className}`} {...props}>{children}</button>
}
function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>
}
function Panel({ title: panelTitle, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel"><div className="panel-head"><div><h2>{panelTitle}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>{children}</section>
}
function Status({ value }: { value: string }) {
  const style = value === 'taken' || value === 'done' || value === 'verified' ? 'success' : ['unconfirmed', 'pending_review', 'needs_confirmation', 'lookup_unavailable', 'not_analyzed'].includes(value) ? 'warning' : ['not_taken', 'rejected', 'unable_to_identify'].includes(value) ? 'alert' : ''
  const labels: Record<string, string> = { pending_review: 'Not verified', needs_confirmation: 'Needs confirmation', unable_to_identify: 'Unable to identify', lookup_unavailable: 'Lookup unavailable', not_analyzed: 'Not analyzed' }
  const label = labels[value] || value.replaceAll('_', ' ')
  return <span className={`pill ${style}`}>{label}</span>
}
function getError(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.' }

export default function App() {
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()))
  const [patients, setPatients] = useState<Patient[]>([])
  const [patientId, setPatientId] = useState<number | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [bundle, setBundle] = useState<Bundle>(emptyBundle)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register')

  function notify(text: string, error = false) {
    setToast({ text, error })
    window.setTimeout(() => setToast(null), 4200)
  }
  async function loadPatients(selectFirst = false) {
    const result = await request<Patient[]>('/patients')
    setPatients(result)
    if ((selectFirst || patientId === null) && result.length) setPatientId(result[0].id)
  }
  async function loadBundle(pid: number) {
    try {
      const [meds, doses, appointments, routines, routineTemplates, members, notes, handovers, prescriptions, audit, notifications, settings, adherence, tasks] = await Promise.all([
        request<Medication[]>(patientPath(pid, 'medications')),
        request<Dose[]>(patientPath(pid, `doses?day=${today()}`)),
        request<Appointment[]>(patientPath(pid, 'appointments')),
        request<Routine[]>(patientPath(pid, `routines?day=${today()}`)),
        request<RoutineTemplate[]>(patientPath(pid, 'routines/templates')),
        request<Member[]>(patientPath(pid, 'members')),
        request<Bundle['notes']>(patientPath(pid, 'notes')),
        request<Handover[]>(patientPath(pid, 'handovers')),
        request<Prescription[]>(patientPath(pid, 'prescriptions')),
        request<AuditItem[]>(patientPath(pid, 'audit')),
        request<Notification[]>('/notifications'),
        request<ReminderSettings>(patientPath(pid, 'reminder-settings')),
        request<Bundle['adherence']>(patientPath(pid, 'adherence?days=7')),
        request<CareTask[]>(patientPath(pid, 'tasks')),
      ])
      setBundle({ meds, doses, appointments, routines, routineTemplates, members, notes, handovers, prescriptions, audit, notifications, settings, adherence, tasks })
    } catch (error) { notify(getError(error), true) }
  }
  useEffect(() => {
    if (!authenticated) return
    loadPatients().catch(error => {
      notify(getError(error), true)
      if (error instanceof ApiError && error.status === 401) {
        setAuthenticated(false)
        setPatients([])
        setPatientId(null)
      }
    })
  }, [authenticated])
  useEffect(() => { if (authenticated && patientId !== null) loadBundle(patientId) }, [authenticated, patientId])
  const currentPatient = patients.find(item => item.id === patientId)
  const refresh = async () => { if (patientId !== null) await loadBundle(patientId) }
  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true)
    try { await work(); await refresh(); notify(success) }
    catch (error) { notify(getError(error), true) }
    finally { setBusy(false) }
  }
  function logout() { setToken(null); setAuthenticated(false); setPatients([]); setPatientId(null); setBundle(emptyBundle); setPage('home'); setAuthMode('register') }

  if (!authenticated) return <AuthScreen mode={authMode} setMode={setAuthMode} onAuthenticated={() => setAuthenticated(true)} notify={notify} />
  if (!patients.length) return <Onboarding onCreated={async () => { await loadPatients(true); notify('Your care profile is ready.') }} onAccept={async code => { await request(`/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' }); await loadPatients(true); notify('You joined the care team.') }} notify={notify} onLogout={logout} />
  const view = <PageView page={page} patient={currentPatient} data={bundle} busy={busy} notify={notify} act={act} refresh={refresh} onNavigate={setPage} />
  const nav = (mobile = false) => navigation.slice(0, mobile ? 5 : navigation.length).map(item => {
    const Icon = item.icon
    return <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined}>
      <Icon size={19} /><span>{item.label}</span>
    </button>
  })
  return <div className="app-shell">
    <aside className="sidebar"><Brand />
      <div className="profile-switch"><label htmlFor="profile-select">Care profile</label><select id="profile-select" value={patientId ?? ''} onChange={event => setPatientId(Number(event.target.value))}>
        {patients.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}
      </select></div>
      <nav className="nav-list" aria-label="Main navigation">{nav()}</nav>
      <div className="sidebar-bottom"><div className="user-chip"><div className="avatar">{currentPatient?.name.slice(0, 1).toUpperCase() || 'C'}</div><span>{currentPatient?.name || 'Care profile'}</span></div>
        <Button className="ghost" onClick={logout}><LogOut size={16} /> Sign out</Button>
      </div>
    </aside>
    <div className="mobile-brand"><Brand /><button className="btn icon ghost" title="Sign out" aria-label="Sign out" onClick={logout}><LogOut size={17} /></button></div>
    <main className="main-area"><div className="content">
      <header className="topbar"><div className="page-title"><h1>{title[page]}</h1><p>{currentPatient?.name ? `${currentPatient.name}'s shared care profile` : 'Your shared care profile'}</p></div>
        <div className="top-actions"><span className="date-label" style={{ color: 'var(--muted)', fontSize: 13 }}>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
          <Button className="ghost icon" title="Refresh shared care data" aria-label="Refresh shared care data" onClick={() => void refresh()}><RefreshCw size={17} /></Button>
          <Button className="secondary" onClick={() => setPage('notifications')} aria-label="Open notifications"><Bell size={17} /> <span>{bundle.notifications.length ? bundle.notifications.length : 'Inbox'}</span></Button>
        </div></header>
      {view}
    </div></main>
    <nav className="mobile-nav" aria-label="Mobile navigation">{nav(true)}</nav>
    {toast && <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>{toast.text}</div>}
  </div>
}

function AuthScreen({ mode, setMode, onAuthenticated, notify }: { mode: 'login' | 'register'; setMode: (mode: 'login' | 'register') => void; onAuthenticated: () => void; notify: (text: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setAuthError('')
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') || '').trim()
    const password = String(form.get('password') || '')
    try {
      if (mode === 'register') {
        await request('/auth/register', { method: 'POST', body: jsonBody({ email, password }) })
      }
      const body = new URLSearchParams({ username: email, password })
      const result = await request<{ access_token: string }>('/auth/login', { method: 'POST', body })
      setToken(result.access_token); onAuthenticated()
    } catch (error) {
      const message = error instanceof ApiError && error.status === 401 && mode === 'login'
        ? 'Email or password is incorrect. If this is your first visit, create an account first.'
        : error instanceof ApiError && error.status === 409 && mode === 'register'
          ? 'This email already has an account. Choose Sign in instead.'
          : getError(error)
      setAuthError(message); notify(message, true)
    }
    finally { setBusy(false) }
  }
  return <div className="auth-screen"><section className="auth-story"><Brand /><div className="story-copy"><span className="eyebrow">Care, connected</span><h1>Better days start with everyone on the same page.</h1><p>A calmer way to coordinate medicines, appointments and the small daily routines that help life feel like your own.</p></div>
    <div className="story-stats"><div><strong>One shared plan</strong>Care, kept in sync</div><div><strong>Patient-led</strong>Control stays with you</div><div><strong>Clear, not clinical</strong>Made for everyday use</div></div></section>
    <div className="auth-panel-wrap"><section className="auth-panel"><h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p>{mode === 'login' ? 'Sign in to your CareSync workspace.' : 'Register first. Next, enter patient profile details or join a care team with an invitation.'}</p>
      {authError && <div className="notice" role="alert" style={{ borderColor: '#c65e4d', color: '#8f3e35', background: '#fff0ed' }}>{authError}</div>}
      <form className="form-grid" onSubmit={submit}>
        <Field label="Email address"><input required name="email" type="email" autoComplete="email" /></Field>
        <Field label="Password"><input required name="password" type="password" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
        <Button type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</Button>
      </form><div style={{ marginTop: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{mode === 'login' ? 'New to CareSync?' : 'Already have an account?'}
        <button className="text-button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></div>
    </section></div></div>
}

function Onboarding({ onCreated, onAccept, notify, onLogout }: { onCreated: () => Promise<void>; onAccept: (code: string) => Promise<void>; notify: (text: string, error?: boolean) => void; onLogout: () => void }) {
  const [busy, setBusy] = useState(false)
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true)
    try { const name = String(new FormData(event.currentTarget).get('name')); await request('/patients?name=' + encodeURIComponent(name), { method: 'POST' }); await onCreated() }
    catch (error) { notify(getError(error), true) } finally { setBusy(false) }
  }
  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true)
    try { await onAccept(String(new FormData(event.currentTarget).get('code')).trim()) }
    catch (error) { notify(getError(error), true) } finally { setBusy(false) }
  }
  return <div className="auth-screen"><section className="auth-story"><Brand /><div className="story-copy"><span className="eyebrow">A good place to begin</span><h1>Care starts with a little clarity.</h1><p>Create a profile you control, or join someone who has shared an invitation with you.</p></div></section>
    <div className="auth-panel-wrap"><div style={{ width: 'min(100%, 440px)', display: 'grid', gap: 14 }}>
      <Panel title="Create your patient profile" subtitle="You will control this profile and choose who can access it."><form className="form-grid" onSubmit={create}><Field label="Patient's full name"><input name="name" required maxLength={100} autoComplete="name" placeholder="Enter the patient's name" /></Field><Button disabled={busy}><Plus size={16} /> Continue to profile</Button></form></Panel>
      <Panel title="Join someone's care team" subtitle="First register your own account, then enter the patient's secure invitation code. Your permissions depend on their invitation."><form className="form-grid" onSubmit={join}><Field label="Invitation code"><input name="code" required autoComplete="one-time-code" /></Field><Button className="secondary" disabled={busy}><Users size={16} /> Join care team</Button></form></Panel>
      <button className="text-button" onClick={onLogout}>Sign out</button>
    </div></div></div>
}

function PageView({ page, patient, data, busy, notify, act, refresh, onNavigate }: {
  page: Page; patient?: Patient; data: Bundle; busy: boolean; notify: (text: string, error?: boolean) => void
  act: (work: () => Promise<unknown>, success: string) => Promise<void>; refresh: () => Promise<void>
  onNavigate: (page: Page) => void
}) {
  if (!patient) return <div className="empty">Choose a care profile to continue.</div>
  if (page === 'home') return <Dashboard data={data} patient={patient} act={act} onNavigate={onNavigate} />
  if (page === 'medications') return <MedicationPage pid={patient.id} data={data} busy={busy} act={act} />
  if (page === 'routines') return <RoutinePage pid={patient.id} data={data} busy={busy} act={act} />
  if (page === 'appointments') return <AppointmentPage pid={patient.id} data={data} busy={busy} act={act} />
  if (page === 'prescriptions') return <PrescriptionPage pid={patient.id} data={data} busy={busy} act={act} notify={notify} />
  if (page === 'team') return <TeamPage pid={patient.id} patient={patient} data={data} busy={busy} act={act} refresh={refresh} notify={notify} />
  if (page === 'activity') return <ActivityPage data={data} />
  if (page === 'notifications') return <NotificationsPage data={data} />
  return <SettingsPage pid={patient.id} settings={data.settings} busy={busy} act={act} />
}

function Dashboard({ data, patient, act, onNavigate }: { data: Bundle; patient: Patient; act: (work: () => Promise<unknown>, success: string) => Promise<void>; onNavigate: (page: Page) => void }) {
  const activeMeds = data.meds.filter(item => item.start_date <= today() && (!item.end_date || item.end_date >= today()))
  const upcoming = data.appointments.filter(item => item.status === 'scheduled' && new Date(item.starts_at).getTime() >= Date.now()).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 3)
  const taken = data.doses.filter(item => item.status === 'taken').length
  const total = data.doses.length
  const nextDose = data.doses.find(item => item.status === 'unconfirmed' && new Date(item.scheduled_for).getTime() >= Date.now())
  const pendingRoutines = data.routines.filter(item => item.status === 'unconfirmed').length
  return <>
    <div className="metric-grid"><Metric label="Active medicines" value={String(activeMeds.length)} note="In the current medication plan" icon={<Pill size={19} />} />
      <Metric label="Today's doses" value={total ? `${taken} / ${total}` : 'None scheduled'} note="Taken confirmations / scheduled" icon={<ClipboardCheck size={19} />} />
      <Metric label="Next dose" value={nextDose ? timeText(nextDose.scheduled_for) : 'All clear'} note={nextDose?.name || 'No upcoming medicine'} icon={<Clock3 size={19} />} />
      <Metric label="Next appointment" value={upcoming[0] ? dateText(upcoming[0].starts_at, { month: 'short', day: 'numeric' }) : 'None planned'} note={upcoming[0]?.doctor || 'Add an appointment'} icon={<CalendarDays size={19} />} /></div>
    <div className="two-col"><div>
      <Panel title="Today's medication schedule" subtitle="Unconfirmed doses stay unconfirmed until someone records them." action={<span className="pill">{new Date().toLocaleDateString(undefined, { weekday: 'long' })}</span>}>
        {data.doses.length ? <div className="list">{data.doses.slice(0, 5).map(dose => <DoseRow key={`${dose.medication_id}-${dose.scheduled_for}`} pid={patient.id} dose={dose} act={act} />)}</div> : <div className="empty"><strong>No medicines in today's schedule</strong>Add a medication to see reminders here.</div>}
      </Panel>
      <Panel title="Current medication plan" subtitle="Prescription review stays separate until a patient or clinician adds a medicine to this plan." action={<Button className="secondary" onClick={() => onNavigate('medications')}>Open medication plan</Button>}>
        {activeMeds.length ? <div className="list">{activeMeds.slice(0, 5).map(medicine => <div className="list-row" key={medicine.id}><div className="row-main"><div className="row-icon"><Pill size={17} /></div><div><div className="row-title">{medicine.name} · {medicine.dosage}</div><div className="row-sub">{medicine.frequency} · {medicine.times.join(', ')}{medicine.end_date ? ` · through ${medicine.end_date}` : ''}</div></div></div></div>)}</div> : <div className="empty"><strong>No active medicines in this profile</strong>Only medicines explicitly added to the plan appear here.</div>}
      </Panel>
      <div style={{ marginTop: 15 }}><VoiceAssistant pid={patient.id} data={data} act={act} /></div>
    </div><div>
      <Panel title="Upcoming appointments" subtitle="Scheduled visits saved to this shared profile." action={<Button className="secondary" onClick={() => onNavigate('appointments')}>View appointments</Button>}>
        {upcoming.length ? <div className="list">{upcoming.map(item => <div className="list-row" key={item.id}><div className="row-main"><div className="row-icon"><Stethoscope size={18} /></div><div><div className="row-title">{item.doctor} · {item.specialty || 'Care visit'}</div><div className="row-sub">{dateText(item.starts_at)} · {item.hospital || item.purpose}</div></div></div></div>)}</div> : <div className="empty"><strong>No upcoming appointments</strong>New appointments will appear here.</div>}
      </Panel>
      <Panel title="Prescription review" subtitle="Upload and analysis status. A match never adds medicine to the active plan." action={<Button className="secondary" onClick={() => onNavigate('prescriptions')}>Review prescriptions</Button>}>
        {data.prescriptions.length ? <div className="list">{data.prescriptions.slice(0, 3).map(item => {
          const verified = item.analysis.filter(result => result.match_status === 'verified').length
          const needsReview = item.analysis.filter(result => result.match_status === 'needs_confirmation').length
          const unidentified = item.analysis.filter(result => result.match_status === 'unable_to_identify').length
          const summary = item.analysis_status !== 'complete' ? 'Not analyzed yet' : item.analysis.length ? `${verified} verified · ${needsReview} need review · ${unidentified} unable to identify` : 'No medicine lines extracted'
          return <div className="list-row" key={item.id}><div className="row-main"><div className="row-icon"><FileUp size={17} /></div><div><div className="row-title">{item.filename}</div><div className="row-sub">{summary}</div></div></div><Status value="pending_review" /></div>
        })}</div> : <div className="empty"><strong>No prescription uploads</strong>Uploads and verified medicine matches will be summarized here.</div>}
      </Panel>
      <Panel title="Today's routines" subtitle="Wellness habits are separate from medicine adherence." action={<Button className="secondary" onClick={() => onNavigate('routines')}>View routines</Button>}>
        {data.routines.length ? <div className="row-sub">{data.routines.length - pendingRoutines} of {data.routines.length} routines completed · {pendingRoutines} unconfirmed</div> : <div className="empty">No routines scheduled today.</div>}
      </Panel>
      <Panel title="This week" subtitle="Medication adherence, not wellness routines."><AdherenceChart adherence={data.adherence} /></Panel>
      <Panel title="Shared care" subtitle={`${patient.name}'s profile · patient-controlled access`}>
        <div className="row-main"><div className="row-icon"><ShieldCheck size={18} /></div><div><div className="row-title">Your care team is connected</div><div className="row-sub">{data.members.length} members · permissions set by the patient</div></div></div>
      </Panel>
      {patient.role === 'family' && <Panel title="Family overview" subtitle="Unresolved care items and recent updates."><div className="list-row"><div><div className="row-title">{data.doses.filter(item => item.status === 'unconfirmed').length} unconfirmed doses today</div><div className="row-sub">Unconfirmed does not mean missed.</div></div><Status value="unconfirmed" /></div><div className="row-sub">{data.audit[0] ? `Latest: ${data.audit[0].action.replaceAll('_', ' ')} · ${dateText(data.audit[0].at)}` : 'No recent activity.'}</div><div className="row-sub" style={{ marginTop: 9 }}>{data.tasks.filter(task => task.status === 'pending').length} open care responsibilities</div></Panel>}
      {patient.role === 'caretaker' && <Panel title="My assigned tasks" subtitle="Responsibilities assigned to your account.">{data.tasks.filter(task => task.is_assigned_to_me).length ? <div className="list">{data.tasks.filter(task => task.is_assigned_to_me).slice(0, 5).map(task => <CareTaskRow key={task.id} pid={patient.id} task={task} canComplete act={act} />)}</div> : <div className="empty">No tasks assigned to you.</div>}</Panel>}
    </div></div>
  </>
}
function Metric({ label, value, note, icon }: { label: string; value: string; note: string; icon: ReactNode }) {
  return <div className="metric"><div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--teal)' }}><span className="metric-label">{label}</span>{icon}</div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>
}
function DoseRow({ pid, dose, act }: { pid: number; dose: Dose; act: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  return <div className="list-row"><div className="row-main"><div className="row-icon"><Pill size={18} /></div><div><div className="row-title">{dose.name} <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {dose.dosage}</span></div><div className="row-sub">{timeText(dose.scheduled_for)} {dose.recorded_at ? `· recorded ${timeText(dose.recorded_at)}` : ''}</div></div></div>
    <div className="row-actions"><Status value={dose.status} />{dose.status === 'unconfirmed' && <><Button onClick={() => void act(() => request(`/patients/${pid}/doses/confirm`, { method: 'POST', body: jsonBody({ medication_id: dose.medication_id, scheduled_for: dose.scheduled_for, status: 'taken' }) }), 'Dose recorded as taken')}><Check size={15} /> Taken</Button><Button className="ghost" onClick={() => void act(() => request(`/patients/${pid}/doses/confirm`, { method: 'POST', body: jsonBody({ medication_id: dose.medication_id, scheduled_for: dose.scheduled_for, status: 'skipped' }) }), 'Dose recorded as skipped')}>Skip</Button><Button className="ghost" onClick={() => void act(() => request(`/patients/${pid}/doses/confirm`, { method: 'POST', body: jsonBody({ medication_id: dose.medication_id, scheduled_for: dose.scheduled_for, status: 'not_taken' }) }), 'Dose recorded as not taken')}>Not taken</Button></>}</div>
  </div>
}
function AdherenceChart({ adherence }: { adherence: Bundle['adherence'] }) {
  const days = useMemo(() => [...adherence].reverse().map(item => ({
    day: new Date(`${item.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' }),
    ratio: item.total ? item.taken / item.total : 0,
  })), [adherence])
  return <div className="chart" aria-label="Seven day medication adherence"><div style={{ display: 'contents' }}>{days.map((item, index) => <div className="chart-day" key={`${item.day}-${index}`}><div className="chart-track"><div className="chart-fill" style={{ height: `${Math.max(3, item.ratio * 100)}%` }} /></div><span>{item.day}</span></div>)}</div></div>
}

function MedicationPage({ pid, data, busy, act }: { pid: number; data: Bundle; busy: boolean; act: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Medication | null>(null)
  function medicinePayload(form: HTMLFormElement) {
    const f = new FormData(form)
    return { name: f.get('name'), dosage: f.get('dosage'), frequency: f.get('frequency'), instructions: f.get('instructions'), start_date: f.get('start_date'), end_date: f.get('end_date') || null, times: String(f.get('times')).split(',').map(value => value.trim()).filter(Boolean) }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const f = new FormData(form)
    await act(() => request(`/patients/${pid}/medications`, { method: 'POST', body: jsonBody(medicinePayload(form)) }), 'Medication added'); setShowForm(false); form.reset(); void f
  }
  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const medicine = editing
    if (!medicine) return
    await act(() => request(`/patients/${pid}/medications/${medicine.id}`, { method: 'PUT', body: jsonBody(medicinePayload(form)) }), 'Medication updated'); setEditing(null)
  }
  return <><div className="section-head"><div><h2>Medicines</h2><p>Only enter the details provided by the prescribing clinician.</p></div><Button onClick={() => setShowForm(!showForm)}><Plus size={17} /> Add medicine</Button></div>
    {showForm && <form className="inline-form" onSubmit={save}><Field label="Medicine name"><input name="name" required /></Field><Field label="Prescribed dosage"><input name="dosage" required placeholder="As written on the prescription" /></Field><Field label="Frequency"><input name="frequency" required placeholder="As prescribed" /></Field><Field label="Scheduled times"><input name="times" required placeholder="08:00, 20:00" /></Field><Field label="Start date"><input name="start_date" type="date" required defaultValue={today()} /></Field><Field label="End date (optional)"><input name="end_date" type="date" /></Field><Field className="span-2" label="Instructions"><input name="instructions" placeholder="Instructions from the clinician" /></Field><div className="form-actions"><Button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancel</Button><Button disabled={busy}>Save medication</Button></div></form>}
    {editing && <form className="inline-form" onSubmit={update}><Field label="Medicine name"><input name="name" required defaultValue={editing.name} /></Field><Field label="Prescribed dosage"><input name="dosage" required defaultValue={editing.dosage} /></Field><Field label="Frequency"><input name="frequency" required defaultValue={editing.frequency} /></Field><Field label="Scheduled times"><input name="times" required defaultValue={editing.times.join(', ')} /></Field><Field label="Start date"><input name="start_date" type="date" required defaultValue={editing.start_date} /></Field><Field label="End date (optional)"><input name="end_date" type="date" defaultValue={editing.end_date || ''} /></Field><Field className="span-2" label="Instructions"><input name="instructions" defaultValue={editing.instructions} /></Field><div className="form-actions"><Button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy}>Save changes</Button></div></form>}
    <div className="notice" style={{ marginBottom: 15 }}>CareSync records the plan you enter. It does not prescribe, infer missing details, or change a dosage.</div>
    {data.meds.length ? <div className="panel list">{data.meds.map(item => <div className="list-row" key={item.id}><div className="row-main"><div className="row-icon"><Pill size={18} /></div><div><div className="row-title">{item.name} · {item.dosage}</div><div className="row-sub">{item.frequency} · {item.times.join(', ')}{item.instructions ? ` · ${item.instructions}` : ''}</div></div></div><div className="row-actions"><Button className="ghost icon" title="Edit medicine" aria-label={`Edit ${item.name}`} onClick={() => { setShowForm(false); setEditing(item) }}><Pencil size={16} /></Button><Button className="danger icon" title="Remove medicine" aria-label={`Remove ${item.name}`} onClick={() => void act(() => request(`/patients/${pid}/medications/${item.id}`, { method: 'DELETE' }), 'Medication removed')}><Trash2 size={16} /></Button></div></div>)}</div> : <div className="empty"><strong>Your medication plan is ready when you are</strong>Add one medicine using the exact prescribed details.</div>}
    <div style={{ marginTop: 16 }}><Panel title="Today's dose confirmations" subtitle="Each confirmation records the actor and time.">{data.doses.length ? <div className="list">{data.doses.map(dose => <DoseRow key={`${dose.medication_id}-${dose.scheduled_for}`} pid={pid} dose={dose} act={act} />)}</div> : <div className="empty">No doses scheduled today.</div>}</Panel></div>
  </>
}

function RoutinePage({ pid, data, busy, act }: { pid: number; data: Bundle; busy: boolean; act: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [showForm, setShowForm] = useState(false)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const currentForm = event.currentTarget; const form = new FormData(currentForm)
    await act(() => request(`/patients/${pid}/routines`, { method: 'POST', body: jsonBody({ name: form.get('name'), instructions: form.get('instructions'), times: String(form.get('times')).split(',').map(value => value.trim()).filter(Boolean) }) }), 'Routine added'); event.currentTarget.reset(); setShowForm(false)
  }
  return <><div className="section-head"><div><h2>Doctor-approved routines</h2><p>Wellness habits are tracked separately from medicine adherence.</p></div><Button onClick={() => setShowForm(!showForm)}><Plus size={17} /> Add routine</Button></div>
    {showForm && <form className="inline-form" onSubmit={save}><Field label="Routine"><input name="name" required placeholder="Walking, hydration, personal care…" /></Field><Field label="Reminder times"><input name="times" placeholder="09:00, 15:00" /></Field><Field label="Notes" className="span-2"><input name="instructions" /></Field><div className="form-actions"><Button disabled={busy}>Save routine</Button></div></form>}
    {data.routines.length ? <div className="panel list">{data.routines.map(item => <div className="list-row" key={`${item.id}-${item.scheduled_for}`}><div className="row-main"><div className="row-icon"><Waves size={18} /></div><div><div className="row-title">{item.name}</div><div className="row-sub">{timeText(item.scheduled_for)} · {item.instructions || 'Personal care routine'}</div></div></div><div className="row-actions"><Status value={item.status} />{item.status === 'unconfirmed' && <Button onClick={() => void act(() => request(`/patients/${pid}/routines/check-in`, { method: 'POST', body: jsonBody({ routine_id: item.id, scheduled_for: item.scheduled_for, status: 'done' }) }), 'Routine recorded')}><Check size={15} /> Done</Button>}</div></div>)}</div> : <div className="empty"><strong>Build a rhythm that feels right</strong>Add routines recommended by the care team. These never affect medication reports.</div>}
  </>
}

function AppointmentPage({ pid, data, busy, act }: { pid: number; data: Bundle; busy: boolean; act: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Appointment | null>(null)
  function appointmentPayload(form: HTMLFormElement) {
    const values = new FormData(form)
    return { doctor: values.get('doctor'), specialty: values.get('specialty'), hospital: values.get('hospital'), starts_at: new Date(String(values.get('starts_at'))).toISOString(), purpose: values.get('purpose'), notes: values.get('notes'), reminder_minutes: Number(values.get('reminder_minutes')) }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const f = new FormData(form)
    await act(() => request(`/patients/${pid}/appointments`, { method: 'POST', body: jsonBody(appointmentPayload(form)) }), 'Appointment saved'); setShowForm(false); form.reset(); void f
  }
  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const appointment = editing
    if (!appointment) return
    await act(() => request(`/patients/${pid}/appointments/${appointment.id}`, { method: 'PUT', body: jsonBody(appointmentPayload(form)) }), 'Appointment updated'); setEditing(null)
  }
  const items = [...data.appointments].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  return <><div className="section-head"><div><h2>Care visits</h2><p>Appointments and reminder delivery are shared with the care team.</p></div><Button onClick={() => setShowForm(!showForm)}><Plus size={17} /> Add appointment</Button></div>
    {showForm && <form className="inline-form" onSubmit={save}><Field label="Doctor"><input name="doctor" required /></Field><Field label="Specialty"><input name="specialty" /></Field><Field label="Hospital or clinic"><input name="hospital" /></Field><Field label="Date and time"><input name="starts_at" type="datetime-local" required /></Field><Field label="Purpose"><input name="purpose" required /></Field><Field label="Reminder (minutes before)"><input name="reminder_minutes" type="number" min="0" max="10080" defaultValue="60" /></Field><Field label="Notes" className="span-2"><input name="notes" /></Field><div className="form-actions"><Button disabled={busy}>Save appointment</Button></div></form>}
    {editing && <form className="inline-form" onSubmit={update}><Field label="Doctor"><input name="doctor" required defaultValue={editing.doctor} /></Field><Field label="Specialty"><input name="specialty" defaultValue={editing.specialty} /></Field><Field label="Hospital or clinic"><input name="hospital" defaultValue={editing.hospital} /></Field><Field label="Date and time"><input name="starts_at" type="datetime-local" required defaultValue={editing.starts_at.slice(0, 16)} /></Field><Field label="Purpose"><input name="purpose" required defaultValue={editing.purpose} /></Field><Field label="Reminder (minutes before)"><input name="reminder_minutes" type="number" min="0" max="10080" defaultValue={editing.reminder_minutes} /></Field><Field label="Notes" className="span-2"><input name="notes" defaultValue={editing.notes} /></Field><div className="form-actions"><Button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy}>Save changes</Button></div></form>}
    {items.length ? <div className="panel list">{items.map(item => <div className="list-row" key={item.id}><div className="row-main"><div className="row-icon"><CalendarDays size={18} /></div><div><div className="row-title">{item.doctor} · {item.specialty || 'Appointment'}</div><div className="row-sub">{dateText(item.starts_at)} · {item.hospital || item.purpose}</div><div className="row-sub">{item.purpose}{item.notes ? ` · ${item.notes}` : ''}</div></div></div><div className="row-actions"><Status value={item.status} />{item.status === 'scheduled' && <><Button className="ghost icon" title="Edit appointment" aria-label={`Edit appointment with ${item.doctor}`} onClick={() => { setShowForm(false); setEditing(item) }}><Pencil size={15} /></Button><Button className="danger" onClick={() => void act(() => request(`/patients/${pid}/appointments/${item.id}`, { method: 'DELETE' }), 'Appointment cancelled')}><X size={15} /> Cancel</Button></>}</div></div>)}</div> : <div className="empty">No appointments yet.</div>}
  </>
}

function PrescriptionPage({ pid, data, busy, act, notify }: { pid: number; data: Bundle; busy: boolean; act: (work: () => Promise<unknown>, success: string) => Promise<void>; notify: (text: string, error?: boolean) => void }) {
  const [preview, setPreview] = useState<{ id: number; filename: string; url: string } | null>(null)
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const file = new FormData(form).get('file') as File
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { notify('Choose a file smaller than 10 MB.', true); return }
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) { notify('Choose a JPG, JPEG, PNG, or PDF file.', true); return }
    const body = new FormData(); body.append('file', file)
    await act(() => request(`/patients/${pid}/prescriptions`, { method: 'POST', body }), 'Prescription uploaded. Analyze it when ready.'); form.reset()
  }
  async function analyze(id: number) {
    await act(() => request(`/patients/${pid}/prescriptions/${id}/analyze`, { method: 'POST' }), 'Prescription analysis finished. Review each medicine match below.')
  }
  async function decide(id: number, index: number, action: 'confirm' | 'reject', rxcui?: string) {
    await act(() => request(`/patients/${pid}/prescriptions/${id}/matches/${index}`, { method: 'POST', body: jsonBody({ action, rxcui }) }), action === 'confirm' ? 'RxNorm match confirmed. This does not add it to the medication plan.' : 'Medicine suggestion rejected.')
  }
  async function lookup(event: FormEvent<HTMLFormElement>, id: number) {
    event.preventDefault(); const form = event.currentTarget; const medicineName = String(new FormData(form).get('medicine_name') || '').trim()
    if (!medicineName) return
    await act(() => request(`/patients/${pid}/prescriptions/${id}/lookup`, { method: 'POST', body: jsonBody({ medicine_name: medicineName }) }), 'Medicine name checked against RxNorm.')
    form.reset()
  }
  async function viewOriginal(id: number) {
    const item = data.prescriptions.find(prescription => prescription.id === id)
    if (!item) return
    try {
      const url = await requestBlob(`/patients/${pid}/prescriptions/${id}/file`)
      if (preview) URL.revokeObjectURL(preview.url)
      setPreview({ id, filename: item.filename, url })
    } catch (error) { notify(getError(error), true) }
  }
  async function clear(id: number, filename: string) {
    if (!window.confirm(`Permanently delete ${filename} and its analysis?`)) return
    await act(() => request(`/patients/${pid}/prescriptions/${id}`, { method: 'DELETE' }), 'Prescription and analysis deleted')
    if (preview?.id === id) { URL.revokeObjectURL(preview.url); setPreview(null) }
  }
  return <><div className="section-head"><div><h2>Prescription review</h2><p>Analyze each upload and review medicine matches against RxNorm and official FDA label data.</p></div></div>
    <form className="file-drop" onSubmit={upload}><FileUp size={26} color="var(--teal)" /><strong>Choose a prescription file</strong><span>JPG, JPEG, PNG or PDF · maximum 10 MB</span><input name="file" type="file" accept="image/jpeg,image/png,application/pdf" required /><Button disabled={busy}>Upload prescription</Button></form>
    <div className="notice" style={{ margin: '14px 0' }}>OCR text and medicine suggestions are not prescriptions. Unclear writing must be checked with a qualified pharmacist. Analysis never changes your active medication plan or recommends dosage changes.</div>
    <div className="prescription-results">{data.prescriptions.map(item => <section className="panel prescription-panel" key={item.id}>
      <div className="panel-head"><div><h2>{item.filename}</h2><p>Uploaded {dateText(item.uploaded_at)} · prescription is not verified</p></div><Status value={item.status} /></div>
      <div className="prescription-toolbar"><Button type="button" className="secondary" disabled={busy} onClick={() => void viewOriginal(item.id)}>View original</Button><Button type="button" disabled={busy} onClick={() => void analyze(item.id)}><Sparkles size={16} />{item.analysis_status === 'complete' ? 'Retry analysis' : 'Analyze prescription'}</Button><Button type="button" className="danger" disabled={busy} onClick={() => void clear(item.id, item.filename)}><Trash2 size={16} /> Clear</Button></div>
      {preview?.id === item.id && <div className="prescription-preview"><div className="prescription-toolbar"><strong>Original file: {preview.filename}</strong><Button type="button" className="ghost" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null) }}>Close preview</Button></div>{item.filename.toLowerCase().endsWith('.pdf') ? <iframe title={`Original ${item.filename}`} src={preview.url} /> : <img src={preview.url} alt={`Original prescription ${item.filename}`} />}</div>}
      {item.analysis_status !== 'not_analyzed' && <p className="row-sub" style={{ margin: '8px 0' }}>Analysis: {item.analysis_status}{item.ocr_confidence !== null ? ` · OCR engine confidence ${item.ocr_confidence}% (not medicine-match confidence)` : ''}</p>}
      {item.analysis_status === 'complete' && <>
        {item.extracted_text ? <details className="extracted-text"><summary>View extracted text</summary><pre>{item.extracted_text}</pre></details> : <div className="notice" style={{ marginTop: 12 }}>No readable text was extracted. Try a sharper, well-lit scan, retry OCR, or enter a medicine name below for a database lookup.</div>}
        {item.analysis.length > 0 ? <div className="prescription-results">{item.analysis.map((result, index) => <PrescriptionMedicineCard key={`${index}-${result.medicine_name}`} result={result} index={index} busy={busy} onDecision={(action, rxcui) => decide(item.id, index, action, rxcui)} />)}</div> : item.extracted_text && <div className="empty"><strong>No medicine lines identified</strong>Check the extracted text. You can manually search a medicine name below; missing instructions will stay blank.</div>}
        <form className="manual-lookup" onSubmit={event => void lookup(event, item.id)}><Field label="Search a corrected medicine name in RxNorm"><input name="medicine_name" required maxLength={120} placeholder="Enter the name exactly as printed" /></Field><Button type="submit" className="secondary" disabled={busy}>Search medicine database</Button></form>
      </>}
    </section>)}{!data.prescriptions.length && <div className="empty"><strong>No prescriptions uploaded</strong>Upload a JPG, JPEG, PNG, or PDF to begin review.</div>}</div>
  </>
}

function PrescriptionMedicineCard({ result, index, busy, onDecision }: { result: PrescriptionMedicineResult; index: number; busy: boolean; onDecision: (action: 'confirm' | 'reject', rxcui?: string) => void }) {
  const medicine = result.medicine
  return <article className="medicine-result"><div className="medicine-result-head"><div><span className="row-sub">Medicine {index + 1}</span><h3>{result.medicine_name || 'Medicine name not readable'}</h3></div><Status value={result.match_status} /></div>
    <dl className="extracted-facts"><div><dt>Dosage</dt><dd>{result.dosage || 'Not clearly readable'}</dd></div><div><dt>Frequency</dt><dd>{result.frequency || 'Not clearly readable'}</dd></div><div><dt>Duration</dt><dd>{result.duration || 'Not clearly readable'}</dd></div></dl>
    {result.source_line && <details className="extracted-text"><summary>{result.source_line === 'Manually entered for lookup' ? 'Manual lookup term' : 'OCR source line'}</summary><pre>{result.source_line}</pre></details>}
    {result.match_status === 'needs_confirmation' && <div className="suggestion-list"><p>{result.message}</p>{result.matches.map(match => <div className="suggestion-row" key={match.rxcui}><div><strong>{match.name}</strong><div className="row-sub">RxNorm identifier {match.rxcui}{match.score !== undefined && match.score !== null ? ` · RxNorm match score ${match.score}` : ''}</div></div><div className="row-actions"><Button type="button" className="secondary" disabled={busy} onClick={() => onDecision('confirm', match.rxcui)}>Confirm match</Button><Button type="button" className="ghost" disabled={busy} onClick={() => onDecision('reject', match.rxcui)}>Reject</Button></div></div>)}</div>}
    {result.match_status === 'unable_to_identify' && <div className="medicine-warning">Unable to verify this medicine. Please consult a qualified pharmacist.</div>}
    {result.match_status === 'lookup_unavailable' && <div className="notice">{result.message}</div>}
    {medicine && <MedicineInformationView medicine={medicine} />}
    {result.message && result.match_status === 'verified' && <p className="medicine-disclaimer">{result.message} A database name match does not confirm that the prescription is correct for this patient.</p>}
  </article>
}
function MedicineInformationView({ medicine }: { medicine: MedicineInformation }) {
  return <div className="medicine-information"><div className="medicine-identity"><div><span className="row-sub">Generic name</span><strong>{medicine.generic_name || 'Not provided by RxNorm'}</strong></div><div><span className="row-sub">Brand name</span><strong>{medicine.brand_name || 'Not listed in retrieved label'}</strong></div><div><span className="row-sub">Category</span><strong>{medicine.category || 'Not listed in retrieved FDA label'}</strong></div></div>
    <MedicineFact title="What is this medicine?" value={medicine.what_is_it} /><MedicineFact title="What is it used for?" value={medicine.uses} /><MedicineFact title="How does it work?" value={medicine.mechanism} /><MedicineFact title="Side effects / adverse reactions in label" value={medicine.side_effects} />
    <div className="medicine-fact"><h4>Important precautions from label</h4>{Object.entries(medicine.precautions).map(([label, value]) => value && <p key={label}><strong>{label.replaceAll('_', ' ')}: </strong>{value}</p>)}{!Object.values(medicine.precautions).some(Boolean) && <p>Not listed in retrieved FDA label.</p>}</div>
    <div className="medicine-sources"><strong>Trusted information sources</strong>{medicine.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.name}</a>)}{!medicine.label_available && <span className="row-sub">A matching FDA label was not available; only the RxNorm identity is verified.</span>}</div>
  </div>
}
function MedicineFact({ title, value }: { title: string; value: string }) {
  return <div className="medicine-fact"><h4>{title}</h4><p>{value || 'Not listed in the retrieved FDA label.'}</p></div>
}

function TeamPage({ pid, patient, data, busy, act, refresh, notify }: { pid: number; patient: Patient; data: Bundle; busy: boolean; act: (work: () => Promise<unknown>, success: string) => Promise<void>; refresh: () => Promise<void>; notify: (text: string, error?: boolean) => void }) {
  const [invite, setInvite] = useState('')
  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget)
    try { const result = await request<{ code: string; expires_at: string }>(`/patients/${pid}/invites?role=${f.get('role')}&hours=48`, { method: 'POST' }); setInvite(result.code); await refresh(); notify(`Invitation created; expires ${dateText(result.expires_at)}.`) }
    catch (error) { notify(getError(error), true) }
  }
  async function revokeInvite() {
    if (!invite) return
    await act(() => request(`/patients/${pid}/invites/${encodeURIComponent(invite)}`, { method: 'DELETE' }), 'Invitation revoked')
    setInvite('')
  }
  async function removeMember(member: Member) {
    await act(() => request(`/patients/${pid}/members/${member.user_id}`, { method: 'DELETE' }), 'Care-team access removed')
  }
  async function updateMember(member: Member, key: keyof Member, value: boolean) {
    const query = new URLSearchParams({ [key]: String(value) })
    await act(() => request(`/patients/${pid}/members/${member.user_id}?${query}`, { method: 'PATCH' }), 'Member permissions updated')
  }
  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const body = String(new FormData(form).get('body'))
    await act(() => request(`/patients/${pid}/notes`, { method: 'POST', body: jsonBody({ body }) }), 'Note shared with the care team'); form.reset()
  }
  async function addHandover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const f = new FormData(form)
    await act(() => request(`/patients/${pid}/handovers`, { method: 'POST', body: jsonBody({ from_label: f.get('from_label'), to_label: f.get('to_label'), summary: f.get('summary'), pending_tasks: f.get('pending_tasks') }) }), 'Handover saved'); form.reset()
  }
  async function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget)
    const rawDue = String(f.get('due_at') || '')
    await act(() => request(`/patients/${pid}/tasks`, { method: 'POST', body: jsonBody({ assignee_id: Number(f.get('assignee_id')), title: f.get('title'), due_at: rawDue ? new Date(rawDue).toISOString() : null }) }), 'Care responsibility assigned'); event.currentTarget.reset()
  }
  return <><div className="section-head"><div><h2>People supporting {patient.name}</h2><p>Sharing is controlled by the patient profile owner.</p></div></div>
    {patient.role === 'patient' && <Panel title="Invite someone" subtitle="The code is single-use, expires in 48 hours, and starts with limited permissions."><form onSubmit={createInvite} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><select className="input" name="role" aria-label="Invite role" style={{ maxWidth: 200 }}><option value="family">Family member</option><option value="caretaker">Caretaker</option></select><Button disabled={busy}><Plus size={16} /> Create invitation</Button></form>{invite && <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}><code className="pill" style={{ fontSize: 15 }}>{invite}</code><Button className="secondary" onClick={() => { void navigator.clipboard?.writeText(invite); notify('Invitation code copied.') }}>Copy code</Button><Button className="danger" onClick={() => void revokeInvite()}><X size={15} /> Revoke</Button></div>}</Panel>}
    <Panel title="Access and permissions" subtitle="Members start with no medication-edit or confirmation permissions.">
      <div className="list">{data.members.map(member => <div className="list-row" key={member.user_id} style={{ alignItems: 'start' }}>
        <div className="row-main"><div className="avatar">{member.name.slice(0, 1).toUpperCase()}</div><div>
          <div className="row-title">{member.name} <span className="pill">{member.role}</span></div><div className="row-sub">{member.email}</div>
          {patient.role === 'patient' && member.role !== 'patient' && <div className="permission-list" style={{ marginTop: 12 }}>{([
            ['can_confirm_doses', 'Confirm doses'], ['can_edit_meds', 'Edit medication plan'], ['can_manage_appointments', 'Manage appointments'], ['can_manage_routines', 'Manage routines'], ['can_write_notes', 'Write care notes'],
          ] as [keyof Member, string][]).map(([key, label]) => <label className="permission" key={key}><input type="checkbox" checked={Boolean(member[key])} onChange={event => void updateMember(member, key, event.target.checked)} />{label}</label>)}</div>}
        </div></div>
        {patient.role === 'patient' && member.role !== 'patient' && <div className="row-actions"><Button className="danger icon" title="Remove member access" aria-label={`Remove ${member.name} from care team`} onClick={() => void removeMember(member)}><Trash2 size={16} /></Button></div>}
      </div>)}</div>
    </Panel>
    <div className="two-col"><div><Panel title="Daily care note" subtitle="Share an observation with authorized members."><form className="form-grid" onSubmit={addNote}><Field label="Note"><textarea name="body" required maxLength={3000} placeholder="A short update for the next person supporting care" /></Field><Button disabled={busy}><Send size={15} /> Share note</Button></form>{data.notes.slice(0, 4).map(note => <div className="list-row" key={note.id}><div><div className="row-title">{note.body}</div><div className="row-sub">{dateText(note.created_at)}</div></div></div>)}</Panel></div>
      <div><Panel title="Shift handover" subtitle="Leave clear context for the next caregiver."><form className="form-grid" onSubmit={addHandover}><Field label="From"><input name="from_label" required /></Field><Field label="To"><input name="to_label" required /></Field><Field label="Summary"><textarea name="summary" required maxLength={3000} /></Field><Field label="Pending tasks"><textarea name="pending_tasks" maxLength={2000} /></Field><Button disabled={busy}><HandHeart size={16} /> Save handover</Button></form>{data.handovers.slice(0, 3).map(item => <div className="list-row" key={item.id}><div><div className="row-title">{item.from_label} → {item.to_label}</div><div className="row-sub">{item.summary}</div></div></div>)}</Panel></div></div>
    {patient.role === 'patient' && <div style={{ marginTop: 15 }}><Panel title="Assign a care responsibility" subtitle="Choose a current team member and track completion."><form className="inline-form" onSubmit={addTask}><Field label="Assigned member"><select name="assignee_id" required defaultValue=""><option value="" disabled>Select a member</option>{data.members.filter(member => member.role !== 'patient').map(member => <option key={member.user_id} value={member.user_id}>{member.name} · {member.role}</option>)}</select></Field><Field label="Due date and time"><input name="due_at" type="datetime-local" /></Field><Field label="Task" className="span-2"><input name="title" required maxLength={200} placeholder="e.g. Call the clinic to confirm the visit" /></Field><div className="form-actions"><Button disabled={busy}><Plus size={16} /> Assign task</Button></div></form></Panel></div>}
    <div style={{ marginTop: 15 }}><Panel title="Care responsibilities" subtitle="Assigned tasks remain visible to the shared care team.">{data.tasks.length ? <div className="list">{data.tasks.map(task => <CareTaskRow key={task.id} pid={pid} task={task} canComplete={patient.role === 'patient' || task.is_assigned_to_me} act={act} />)}</div> : <div className="empty">No care responsibilities have been assigned.</div>}</Panel></div>
  </>
}

function CareTaskRow({ pid, task, canComplete, act }: { pid: number; task: CareTask; canComplete: boolean; act: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  return <div className="list-row"><div className="row-main"><div className="row-icon"><HandHeart size={18} /></div><div><div className="row-title">{task.title}</div><div className="row-sub">{task.assignee_name}{task.due_at ? ` · due ${dateText(task.due_at)}` : ''}</div></div></div><div className="row-actions"><Status value={task.status} />{canComplete && <Button className="secondary" onClick={() => void act(() => request(`/patients/${pid}/tasks/${task.id}`, { method: 'PATCH', body: jsonBody({ status: task.status === 'completed' ? 'pending' : 'completed' }) }), task.status === 'completed' ? 'Task reopened' : 'Task completed')}>{task.status === 'completed' ? 'Reopen' : 'Complete'}</Button>}</div></div>
}

function ActivityPage({ data }: { data: Bundle }) {
  return <><div className="section-head"><div><h2>Recent activity</h2><p>Actions recorded on this shared profile.</p></div></div><Panel title="Audit history" subtitle="Actor IDs are shown for traceability.">{data.audit.length ? <div className="list">{data.audit.map((item, index) => <div className="list-row" key={`${item.at}-${index}`}><div className="row-main"><div className="row-icon"><Activity size={18} /></div><div><div className="row-title">{item.action.replaceAll('_', ' ')}</div><div className="row-sub">Member {item.actor_id} · {dateText(item.at)}</div></div></div></div>)}</div> : <div className="empty">No recorded activity yet.</div>}</Panel></>
}
function NotificationsPage({ data }: { data: Bundle }) {
  return <><div className="section-head"><div><h2>Delivery log</h2><p>Email status reflects actual SMTP delivery attempts. In-app records are saved either way.</p></div></div><Panel title="Recent notifications">{data.notifications.length ? <div className="list">{data.notifications.map((item, index) => <div className="list-row" key={`${item.at}-${index}`}><div className="row-main"><div className="row-icon"><Bell size={18} /></div><div><div className="row-title">{item.message}</div><div className="row-sub">{dateText(item.at)}</div></div></div><Status value={item.status} /></div>)}</div> : <div className="empty">No notifications have been created.</div>}</Panel></>
}
function SettingsPage({ pid, settings, busy, act }: { pid: number; settings: ReminderSettings; busy: boolean; act: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget)
    const payload = { initial_minutes: Number(f.get('initial_minutes')), followup_minutes: Number(f.get('followup_minutes')), escalation_minutes: Number(f.get('escalation_minutes')), notify_caretakers: f.get('notify_caretakers') === 'on', notify_family: f.get('notify_family') === 'on' }
    await act(() => request(`/patients/${pid}/reminder-settings`, { method: 'PATCH', body: jsonBody(payload) }), 'Reminder policy saved')
  }
  return <><div className="section-head"><div><h2>Reminder and escalation</h2><p>Only the patient can change how the care team is notified.</p></div></div><Panel title="Dose follow-up policy" subtitle="Unconfirmed never means missed. CareSync records confirmations only.">
    <form className="form-grid" onSubmit={save}><div className="inline-form" style={{ margin: 0 }}><Field label="Initial reminder (minutes before)"><input name="initial_minutes" type="number" min="0" max="1440" defaultValue={settings.initial_minutes} /></Field><Field label="Patient follow-up (minutes after)"><input name="followup_minutes" type="number" min="0" max="1440" defaultValue={settings.followup_minutes} /></Field><Field label="Escalate after (minutes)"><input name="escalation_minutes" type="number" min="0" max="1440" defaultValue={settings.escalation_minutes} /></Field><label className="permission"><input name="notify_caretakers" type="checkbox" defaultChecked={settings.notify_caretakers} /> Notify authorized caretakers</label><label className="permission"><input name="notify_family" type="checkbox" defaultChecked={settings.notify_family} /> Notify authorized family after caretaker escalation</label></div><Button disabled={busy}>Save policy</Button></form>
  </Panel><Panel title="Email delivery" subtitle="Add SMTP credentials to the server environment to send real email. Without them, the in-app log shows not_sent_smtp_not_configured."><div className="row-main"><div className="row-icon"><Send size={18} /></div><div><div className="row-title">Delivery is configured on the backend</div><div className="row-sub">Credentials are never sent to or stored in the browser.</div></div></div></Panel></>
}

function VoiceAssistant({ pid, data, act }: { pid: number; data: Bundle; act: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState("Ask about today's medicines, upcoming appointments, or your routines.")
  const [language, setLanguage] = useState<'en-US' | 'ta-IN'>('en-US')
  const [candidate, setCandidate] = useState<Dose | null>(null)
  const [listening, setListening] = useState(false)
  function respond(text: string) {
    const normalized = text.toLowerCase()
    const tamil = language === 'ta-IN'
    let response: string
    if (/medicine|medication|dose|tablet|மருந்து|மருந்துகள்|மாத்திரை/.test(normalized)) {
      const next = data.doses.filter(item => item.status === 'unconfirmed').slice(0, 4)
      response = next.length
        ? `${tamil ? 'இன்றைய மருந்து அட்டவணை' : "Today's medicine schedule"}: ${next.map(item => `${item.name}, ${item.dosage}, ${timeText(item.scheduled_for)}`).join('; ')}.`
        : tamil ? 'இன்றைக்கு உறுதிப்படுத்தப்படாத மருந்துகள் இல்லை.' : 'There are no unconfirmed medicine doses in today’s schedule.'
      const dose = data.doses.find(item => item.status === 'unconfirmed' && normalized.includes(item.name.toLowerCase()))
      if (dose && /took|taken|confirm|finished|எடுத்தேன்|சாப்பிட்டேன்|உறுதிப்படுத்து/.test(normalized)) { setCandidate(dose); response += tamil ? ` ${dose.name} பற்றி கேட்டீர்கள். பதிவு செய்ய கீழே உள்ள உறுதிப்படுத்தல் பொத்தானைத் தேர்ந்தெடுக்கவும்.` : ` I heard you mention ${dose.name}. Please use the confirmation button to record it; speech alone does not confirm a dose.` }
    } else if (/appointment|doctor|clinic|சந்திப்பு|மருத்துவர்|மருத்துவமனை/.test(normalized)) {
      const next = data.appointments.find(item => item.status === 'scheduled' && new Date(item.starts_at).getTime() >= Date.now())
      response = next
        ? tamil ? `உங்கள் அடுத்த சந்திப்பு ${dateText(next.starts_at)} அன்று ${next.doctor} உடன்${next.hospital ? `, ${next.hospital}` : ''}.` : `Your next appointment is with ${next.doctor} on ${dateText(next.starts_at)} at ${next.hospital || 'the location in your appointment details'}.`
        : tamil ? 'வரவிருக்கும் சந்திப்புகள் பதிவு செய்யப்படவில்லை.' : 'There are no upcoming appointments saved.'
    } else if (/routine|walk|water|hydration|வழக்கம்|நடை|தண்ணீர்|நீரேற்றம்/.test(normalized)) {
      const pending = data.routines.filter(item => item.status === 'unconfirmed')
      response = pending.length
        ? `${tamil ? 'உறுதிப்படுத்த வேண்டிய வழக்கங்கள்' : 'Your pending routines'}: ${pending.map(item => `${item.name} at ${timeText(item.scheduled_for)}`).join(' and ')}.`
        : tamil ? 'உறுதிப்படுத்தப்படாத தினசரி வழக்கங்கள் இல்லை.' : 'There are no unconfirmed routines right now.'
    } else response = tamil ? 'இன்றைய மருந்துகள், சந்திப்புகள் அல்லது தினசரி வழக்கங்கள் பற்றி கேளுங்கள்.' : 'I can help with today’s medicines, appointments, and routines.'
    setAnswer(response)
    if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(response)) }
  }
  function startListening() {
    type SpeechEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
    type Recognition = { lang: string; onresult: ((event: SpeechEvent) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void }
    const speech = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
    const RecognitionApi = speech.SpeechRecognition || speech.webkitSpeechRecognition
    if (!RecognitionApi) { setAnswer('Speech recognition is not available in this browser. Type your question below instead.'); return }
    const recognition = new RecognitionApi(); recognition.lang = language; recognition.onresult = event => { const spoken = event.results[0]?.[0]?.transcript || ''; setQuery(spoken); respond(spoken) }; recognition.onerror = () => setAnswer('I could not hear that clearly. You can type your question instead.'); recognition.onend = () => setListening(false); setListening(true); recognition.start()
  }
  return <Panel title="Care voice assistant" subtitle="English and Tamil · your browser may ask for microphone permission."><div className="voice-box"><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}><div className="row-main"><div className="row-icon"><Sparkles size={18} /></div><span className="row-title">Ask about today</span></div><select aria-label="Assistant language" className="input" style={{ width: 130 }} value={language} onChange={event => setLanguage(event.target.value as 'en-US' | 'ta-IN')}><option value="en-US">English</option><option value="ta-IN">தமிழ்</option></select></div>
      <div className="voice-answer" aria-live="polite">{answer}</div><form onSubmit={event => { event.preventDefault(); respond(query) }} style={{ display: 'flex', gap: 8 }}><input className="input" value={query} onChange={event => setQuery(event.target.value)} aria-label="Ask a care question" placeholder="Ask a question…" /><Button type="submit" className="icon" aria-label="Send question"><Send size={16} /></Button><Button type="button" className="secondary icon" aria-label={listening ? 'Listening' : 'Start voice input'} onClick={startListening}><Mic size={17} /></Button></form>
      {candidate && <div className="notice">Voice request detected for {candidate.name} at {timeText(candidate.scheduled_for)}. Select below to explicitly confirm “taken”.<div style={{ marginTop: 9 }}><Button onClick={() => { const dose = candidate; setCandidate(null); void act(() => request(`/patients/${pid}/doses/confirm`, { method: 'POST', body: jsonBody({ medication_id: dose.medication_id, scheduled_for: dose.scheduled_for, status: 'taken' }) }), 'Dose confirmation recorded') }}><Check size={15} /> Confirm taken</Button></div></div>}
      {!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in (window as Window & { webkitSpeechRecognition?: unknown })) && <span className="row-sub">Voice input is unavailable here; text questions still work.</span>}
    </div></Panel>
}
