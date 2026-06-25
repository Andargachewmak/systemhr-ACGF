import { useRef, useState } from 'react'
import { Card, CardHeader, CardBody, Badge, Button, Avatar, Table, Th, Td, Skeleton, Modal, Input, Select } from '@/components/ui'
import { useLeaveRequests, useUpdateLeaveStatus, useEmployees, useDashboard } from '@/hooks'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchAttendance, markAttendance, createLeaveRequest,
  fetchAnnualLeaveBalance, downloadLeaveAttachment,
  type AnnualLeaveBalance,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { cn, formatDate, calcWorkingDays } from '@/lib/utils'
import toast from 'react-hot-toast'
import type { Employee } from '@/types'

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function buildCalendar(year: number, month: number, leaveDays: Set<number>, todayNum: number | null) {
  const days: Array<{ day: number; type: string }> = []
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  for (let i = 0; i < firstDay; i++) days.push({ day: 0, type: 'empty' })
  for (let d = 1; d <= daysInMonth; d++) {
    days.push({ day: d, type: d === todayNum ? 'today' : leaveDays.has(d) ? 'leave' : 'normal' })
  }
  return days
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── Annual Leave Balance Widget ─────────────────────────────────────────────
function AnnualLeaveWidget({ employeeId }: { employeeId: string }) {
  const { data: balance, isLoading } = useQuery<AnnualLeaveBalance>({
    queryKey: ['annual-leave-balance', employeeId],
    queryFn: () => fetchAnnualLeaveBalance(employeeId),
    enabled: !!employeeId,
  })

  if (isLoading) return <Skeleton className="h-24 rounded-2xl" />
  if (!balance) return null

  const pct = balance.allocated > 0 ? Math.round(((balance.allocated - balance.used) / balance.allocated) * 100) : 0

  return (
    <div className={cn(
      'rounded-2xl border p-4 space-y-3',
      balance.expired
        ? 'bg-red-500/8 border-red-500/20'
        : balance.remaining === 0
        ? 'bg-amber-500/8 border-amber-500/20'
        : 'bg-teal-500/8 border-teal-500/20'
    )}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Annual Leave Balance</p>
          <p className="text-xs text-slate-600 mt-0.5">
            Year {balance.year_cycle} of service
            {balance.expired && <span className="ml-2 text-red-400 font-medium">· Expired after 3 years</span>}
          </p>
        </div>
        {balance.expired ? (
          <span className="text-xs bg-red-500/20 text-red-400 border border-red-500/30 px-2.5 py-1 rounded-full font-medium">Expired</span>
        ) : (
          <span className={cn(
            'text-2xl font-bold font-mono',
            balance.remaining === 0 ? 'text-amber-400' : 'text-teal-400'
          )}>
            {balance.remaining}
            <span className="text-sm font-normal text-slate-500 ml-1">/ {balance.allocated} days</span>
          </span>
        )}
      </div>
      {!balance.expired && (
        <>
          <div className="h-2 bg-white/5 rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-700', balance.remaining === 0 ? 'bg-amber-400' : 'bg-teal-400')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span>{balance.used} day{balance.used !== 1 ? 's' : ''} used</span>
            <span>{balance.remaining} day{balance.remaining !== 1 ? 's' : ''} remaining</span>
          </div>
        </>
      )}
      {balance.expired && (
        <p className="text-xs text-red-400/70">Annual leave entitlement expires after 3 years of service.</p>
      )}
      {!balance.expired && (
        <div className="text-xs text-slate-500 grid grid-cols-3 gap-1 pt-1 border-t border-white/5">
          <span className={cn('text-center py-1 rounded', balance.year_cycle === 1 ? 'bg-white/8 text-slate-300' : '')}>Yr 1 → 14 days</span>
          <span className={cn('text-center py-1 rounded', balance.year_cycle === 2 ? 'bg-white/8 text-slate-300' : '')}>Yr 2 → 15 days</span>
          <span className={cn('text-center py-1 rounded', balance.year_cycle === 3 ? 'bg-white/8 text-slate-300' : '')}>Yr 3 → 16 days</span>
        </div>
      )}
    </div>
  )
}

// ─── New Leave Request Modal ──────────────────────────────────────────────────
const LEAVE_TYPE_OPTIONS = [
  { value: 'annual',     label: 'Annual Leave' },
  { value: 'sick',       label: 'Sick Leave' },
  { value: 'maternity',  label: 'Maternity Leave (120 days)' },
  { value: 'paternity',  label: 'Paternity Leave (5 days)' },
  { value: 'bereavement',label: 'Bereavement Leave' },
  { value: 'wedding',    label: 'Wedding Leave (7 days)' },
  { value: 'personal',   label: 'Personal Leave' },
  { value: 'unpaid',     label: 'Unpaid Leave' },
] as const


const LEAVE_TYPE_LABEL: Record<string, string> = {
  annual: 'Annual', sick: 'Sick', maternity: 'Maternity', paternity: 'Paternity',
  bereavement: 'Bereavement', wedding: 'Wedding', personal: 'Personal', unpaid: 'Unpaid',
}

function NewLeaveModal({ open, onClose, employees }: { open: boolean; onClose: () => void; employees: Employee[] }) {
  const user    = useAuth((s) => s.user)
  const isEmp   = user?.role === 'employee'
  const qc      = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [employeeId, setEmployeeId] = useState(isEmp ? (user?.employee_id ?? '') : '')
  const [leaveType, setLeaveType]   = useState<string>('annual')
  const [start, setStart]           = useState('')
  const [end,   setEnd]             = useState('')
  const [reason, setReason]         = useState('')
  const [file,  setFile]            = useState<File | null>(null)
  const [loading, setLoading]       = useState(false)
  const [bereaveRelation, setBereaveRelation] = useState<string>('parent')

  const days = start && end && new Date(end) >= new Date(start) ? calcWorkingDays(start, end) : 0

  // Fetch annual balance for selected employee when Annual is chosen
  const balanceEmpId = leaveType === 'annual' ? (employeeId || (isEmp ? user?.employee_id : '')) : ''
  const { data: annualBalance } = useQuery<AnnualLeaveBalance>({
    queryKey: ['annual-leave-balance', balanceEmpId],
    queryFn: () => fetchAnnualLeaveBalance(balanceEmpId!),
    enabled: !!balanceEmpId,
  })

  function reset() {
    setEmployeeId(isEmp ? (user?.employee_id ?? '') : '')
    setLeaveType('annual'); setStart(''); setEnd(''); setReason(''); setFile(null); setBereaveRelation('parent')
  }

  async function submit() {
    const targetId = isEmp ? (user?.employee_id ?? '') : employeeId
    if (!isEmp && !targetId) { toast.error('Select an employee'); return }
    if (!start || !end) { toast.error('Start and end dates are required'); return }
    if (days <= 0) { toast.error('End date must be on or after start date'); return }

    if (leaveType === 'annual' && annualBalance) {
      if (annualBalance.expired) { toast.error('Annual leave has expired for this employee (3+ years of service)'); return }
      if (days > annualBalance.remaining) {
        toast.error(`Insufficient balance — ${annualBalance.remaining} day(s) remaining, ${days} requested`); return
      }
    }

    if (leaveType === 'sick' && !file) {
      toast.error('Sick leave requires a medical certificate or attachment'); return
    }

    setLoading(true)
    try {
      let attachment_data: string | undefined
      let attachment_name: string | undefined
      let attachment_mime: string | undefined

      if (file) {
        attachment_data = await new Promise<string>((res, rej) => {
          const r = new FileReader()
          r.onload = () => res((r.result as string).split(',')[1])
          r.onerror = () => rej(new Error('File read failed'))
          r.readAsDataURL(file)
        })
        attachment_name = file.name
        attachment_mime = file.type || 'application/octet-stream'
      }

      await createLeaveRequest({
        employee_id: targetId,
        leave_type: leaveType as any,
        start_date: start,
        end_date: end,
        days,
        reason: reason || undefined,
        status: 'pending',
        attachment_data,
        attachment_name,
        attachment_mime,
        bereavement_relation: leaveType === 'bereavement' ? bereaveRelation : undefined,
      })
      qc.invalidateQueries({ queryKey: ['leave'] })
      qc.invalidateQueries({ queryKey: ['annual-leave-balance'] })
      toast.success('Leave request submitted')
      reset(); onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="New Leave Request" size="md">
      <div className="space-y-4">
        {!isEmp && (
          <Select
            label="Employee"
            value={employeeId}
            onChange={setEmployeeId}
            options={[{ value: '', label: 'Select employee…' }, ...employees.map(e => ({ value: e.id, label: `${e.first_name} ${e.last_name}` }))]}
          />
        )}

        <Select
          label="Leave Type"
          value={leaveType}
          onChange={setLeaveType}
          options={LEAVE_TYPE_OPTIONS.map(t => ({ value: t.value, label: t.label }))}
        />

        {/* Annual balance indicator inline */}
        {leaveType === 'annual' && annualBalance && (
          <div className={cn(
            'rounded-xl border px-4 py-3 text-sm',
            annualBalance.expired ? 'bg-red-500/10 border-red-500/25 text-red-300'
            : annualBalance.remaining === 0 ? 'bg-amber-500/10 border-amber-500/25 text-amber-300'
            : 'bg-teal-500/10 border-teal-500/25 text-teal-300'
          )}>
            {annualBalance.expired
              ? '⛔  Annual leave expired — 3+ years of service'
              : `📅  Balance: ${annualBalance.remaining} of ${annualBalance.allocated} days remaining`
            }
            {!annualBalance.expired && days > 0 && (
              <span className={cn('ml-2 font-semibold', days > annualBalance.remaining ? 'text-red-400' : '')}>
                (requesting {days} day{days !== 1 ? 's' : ''})
              </span>
            )}
          </div>
        )}

        {leaveType === 'bereavement' && (
          <Select
            label="Relation *"
            value={bereaveRelation}
            onChange={setBereaveRelation}
            options={[
              { value: 'parent',      label: 'Parent (7 days)' },
              { value: 'sibling',     label: 'Sibling (5 days)' },
              { value: 'grandparent', label: 'Grandparent (3 days)' },
            ]}
          />
        )}

        <div className="grid grid-cols-2 gap-4">
          <Input label="Start Date" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <Input label="End Date"   type="date" value={end}   onChange={(e) => setEnd(e.target.value)} />
        </div>

        {days > 0 && (
          <div className="bg-white/5 rounded-xl px-4 py-2 text-xs text-slate-400">
            Working days: <span className="text-white font-semibold">{days}</span>
          </div>
        )}

        <Input
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={leaveType === 'sick' ? 'Brief description of illness…' : 'Optional'}
        />

        {/* Attachment */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">
            Attachment
            {leaveType === 'sick' && <span className="ml-1 text-red-400">* required for sick leave</span>}
          </label>
          <div
            className={cn(
              'border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-colors',
              file ? 'border-teal-500/50 bg-teal-500/5' : 'border-white/10 hover:border-white/25 bg-white/[0.02]'
            )}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" className="hidden"
              onChange={e => e.target.files?.[0] && setFile(e.target.files[0])} />
            {file ? (
              <div className="flex items-center justify-center gap-3">
                <span className="text-lg">📎</span>
                <div className="text-left">
                  <p className="text-sm font-medium text-white">{file.name}</p>
                  <p className="text-xs text-slate-400">{formatBytes(file.size)}</p>
                </div>
                <button
                  className="ml-auto text-slate-500 hover:text-red-400 p-1"
                  onClick={e => { e.stopPropagation(); setFile(null) }}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6 6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            ) : (
              <>
                <p className="text-sm text-slate-500">
                  <span className="text-brand-400">Click to upload</span> — medical certificate, doctor's note, etc.
                </p>
                <p className="text-xs text-slate-600 mt-0.5">PDF, image, or Word document</p>
              </>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => { reset(); onClose() }}>Cancel</Button>
          <Button variant="primary" loading={loading} onClick={submit}>Submit Request</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Daily Attendance Sub-component ──────────────────────────────────────────
function DailyAttendance() {
  const qc      = useQueryClient()
  const role    = useAuth((s) => s.user?.role)
  const canMark = can(role, 'attendance.mark')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))

  const { data: employees, isLoading: empLoading } = useEmployees()
  const { data: records,   isLoading: recLoading } = useQuery({
    queryKey: ['attendance', date],
    queryFn: () => fetchAttendance(date),
  })
  const mark = useMutation({
    mutationFn: markAttendance,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance', date] }),
    onError: (e: Error) => toast.error(e.message),
  })

  const statusOf = (id: string) => records?.find(r => r.employee_id === id)?.status
  const list     = employees ?? []
  const present  = list.filter(e => statusOf(e.id) === 'present').length
  const absent   = list.filter(e => statusOf(e.id) === 'absent').length
  const unmarked = list.length - present - absent

  return (
    <Card>
      <CardHeader>
        <div>
          <h3 className="font-display font-semibold text-white text-sm">Daily Attendance</h3>
          <p className="text-xs text-slate-500 mt-0.5">{canMark ? 'Mark present or absent' : 'Attendance for selected day'}</p>
        </div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="bg-surface-2 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-brand-500/40 [color-scheme:dark]" />
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[['Present', present, 'text-emerald-400'], ['Absent', absent, 'text-red-400'], ['Unmarked', unmarked, 'text-slate-400']].map(([l, v, c]) => (
            <div key={l as string} className="bg-surface-2 rounded-xl p-3 text-center">
              <p className={`font-display text-2xl font-semibold ${c}`}>{v}</p>
              <p className="text-xs text-slate-500 mt-0.5">{l}</p>
            </div>
          ))}
        </div>
        {empLoading || recLoading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : (
          <Table>
            <thead><tr><Th>Employee</Th><Th>Department</Th><Th>Status</Th>{canMark && <Th>Mark</Th>}</tr></thead>
            <tbody>
              {list.map(emp => {
                const st = statusOf(emp.id)
                return (
                  <tr key={emp.id} className="hover:bg-white/2 transition-colors">
                    <Td>
                      <div className="flex items-center gap-3">
                        <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0',
                          st === 'present' ? 'bg-emerald-400' : st === 'absent' ? 'bg-red-400' : 'bg-slate-600')} />
                        <Avatar name={`${emp.first_name} ${emp.last_name}`} src={emp.avatar_url} size="sm" />
                        <span className="text-sm font-medium text-white">{emp.first_name} {emp.last_name}</span>
                      </div>
                    </Td>
                    <Td>{emp.department}</Td>
                    <Td>
                      <span className={cn('inline-flex px-2.5 py-1 rounded-lg text-xs font-medium border',
                        st === 'present' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20'
                        : st === 'absent' ? 'bg-red-500/15 text-red-400 border-red-500/20'
                        : 'bg-slate-500/15 text-slate-400 border-slate-500/20')}>
                        {st === 'present' ? 'Present' : st === 'absent' ? 'Absent' : 'Not marked'}
                      </span>
                    </Td>
                    {canMark && (
                      <Td>
                        <div className="flex items-center gap-2">
                          {(['present', 'absent'] as const).map(s => (
                            <button key={s}
                              onClick={() => mark.mutate({ employee_id: emp.id, date, status: s })}
                              className={cn('px-3 py-1.5 rounded-lg text-xs font-medium border transition-all capitalize',
                                st === s
                                  ? s === 'present' ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-red-500 text-white border-red-500'
                                  : s === 'present' ? 'bg-surface-2 text-emerald-400 border-emerald-500/30 hover:border-emerald-500/60'
                                    : 'bg-surface-2 text-red-400 border-red-500/30 hover:border-red-500/60'
                              )}
                            >{s}</button>
                          ))}
                        </div>
                      </Td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  )
}

// ─── Main AttendancePage ──────────────────────────────────────────────────────
export function AttendancePage() {
  const user       = useAuth((s) => s.user)
  const role       = user?.role
  const canApprove = can(role, 'leave.approve')
  const isEmp      = role === 'employee'
  const tabs       = isEmp ? ['requests'] as const : ['overview', 'daily', 'requests'] as const
  const [tab, setTab]       = useState<string>(isEmp ? 'requests' : 'overview')
  const [reqOpen, setReqOpen] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)

  const { data: leaveRequests, isLoading: leaveLoading } = useLeaveRequests()
  const { data: employees = [] } = useEmployees()
  const updateLeave = useUpdateLeaveStatus()
  const { data: dash }   = useDashboard({ enabled: !isEmp })
  const qc = useQueryClient()

  const now     = new Date()
  const calYear = now.getFullYear()
  const calMonth = now.getMonth()
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
  const leaveDays = new Set<number>()
  for (const r of leaveRequests ?? []) {
    if (r.status !== 'approved') continue
    const s = new Date(r.start_date), e = new Date(r.end_date)
    if (isNaN(s.getTime()) || isNaN(e.getTime())) continue
    for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      if (d.getFullYear() === calYear && d.getMonth() === calMonth) leaveDays.add(d.getDate())
    }
  }
  const calendar = buildCalendar(calYear, calMonth, leaveDays, now.getDate())

  async function handleLeaveAction(id: string, status: 'approved' | 'denied') {
    try {
      await updateLeave.mutateAsync({ id, status })
      qc.invalidateQueries({ queryKey: ['annual-leave-balance'] })
      toast.success(`Leave request ${status}`)
    } catch { toast.error('Action failed') }
  }

  async function handleDownload(id: string, name: string) {
    setDownloading(id)
    try { await downloadLeaveAttachment(id, name); toast.success('Download started') }
    catch { toast.error('No attachment or download failed') }
    finally { setDownloading(null) }
  }

  const pendingCount = leaveRequests?.filter(r => r.status === 'pending').length ?? 0

  return (
    <div className="space-y-6">
      {/* Tabs */}
      {tabs.length > 1 && (
        <div className="flex gap-1 bg-surface-2 rounded-xl p-1 w-fit">
          {tabs.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('px-4 py-2 rounded-lg text-sm transition-all capitalize', tab === t
                ? 'bg-surface-1 text-white font-medium shadow'
                : 'text-slate-500 hover:text-slate-300')}>
              {t === 'requests' ? `Leave Requests${pendingCount ? ` (${pendingCount})` : ''}`
               : t === 'daily' ? 'Daily Attendance' : 'Overview'}
            </button>
          ))}
        </div>
      )}

      {/* ── Overview Tab ── */}
      {tab === 'overview' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-5">
            {/* Calendar */}
            <Card>
              <CardHeader>
                <div>
                  <h3 className="font-display font-semibold text-white text-sm">{monthLabel}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Approved leave this month</p>
                </div>
                <div className="flex gap-3">
                  {[{ color: 'bg-teal-500/30 border border-teal-500/50', label: 'Leave' },
                    { color: 'bg-brand-500 border border-brand-500', label: 'Today' }].map(({ color, label }) => (
                    <span key={label} className="flex items-center gap-1.5 text-xs text-slate-500">
                      <span className={cn('w-3 h-3 rounded', color)} />{label}
                    </span>
                  ))}
                </div>
              </CardHeader>
              <CardBody>
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {DAYS.map(d => <div key={d} className="text-center text-xs text-slate-600 font-medium py-1">{d}</div>)}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {calendar.map((cell, i) => (
                    <div key={i} className={cn('aspect-square flex items-center justify-center rounded-lg text-xs font-medium',
                      cell.type === 'empty' ? '' :
                      cell.type === 'today' ? 'bg-brand-500 text-white' :
                      cell.type === 'leave' ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30' :
                      'text-slate-400 hover:bg-white/5')}>
                      {cell.day || ''}
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>

            {/* Stats */}
            <div className="space-y-3">
              {[
                { label: 'On Leave Today', value: dash?.on_leave ?? 0, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
                { label: 'Pending Requests', value: dash?.pending_leave ?? 0, color: 'text-brand-400', bg: 'bg-brand-500/10 border-brand-500/20' },
                { label: 'Approved This Month', value: dash?.approved_leave ?? 0, color: 'text-teal-400', bg: 'bg-teal-500/10 border-teal-500/20' },
              ].map(s => (
                <div key={s.label} className={cn('rounded-2xl border p-4 flex items-center gap-4', s.bg)}>
                  <p className={cn('text-3xl font-bold font-mono', s.color)}>{s.value}</p>
                  <p className="text-sm text-slate-400">{s.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* All employee annual leave balances (HR view) */}
          {!isEmp && (
            <Card>
              <CardHeader>
                <h3 className="font-display font-semibold text-white text-sm">Annual Leave Balances</h3>
                <span className="text-xs text-slate-500">Yr 1 = 14 days · Yr 2 = 15 days · Yr 3 = 16 days · Expires after 3 yrs</span>
              </CardHeader>
              <Table>
                <thead>
                  <tr><Th>Employee</Th><Th>Start Date</Th><Th>Service Year</Th><Th>Allocated</Th><Th>Used</Th><Th>Remaining</Th><Th>Status</Th></tr>
                </thead>
                <tbody>
                  {employees.map(emp => (
                    <EmpBalanceRow key={emp.id} emp={emp} />
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
      )}

      {/* ── Daily Tab ── */}
      {tab === 'daily' && <DailyAttendance />}

      {/* ── Requests Tab ── */}
      {tab === 'requests' && (
        <div className="space-y-4">
          {/* Employee self-service: show own annual balance */}
          {isEmp && user?.employee_id && (
            <AnnualLeaveWidget employeeId={user.employee_id} />
          )}

          <Card>
            <CardHeader>
              <h3 className="font-display font-semibold text-white text-sm">Leave Requests</h3>
              <Button size="sm" variant="primary" onClick={() => setReqOpen(true)}>+ New Request</Button>
            </CardHeader>
            {leaveLoading
              ? <CardBody><div className="space-y-3">{Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-12"/>)}</div></CardBody>
              : !leaveRequests?.length
              ? <CardBody><p className="text-sm text-slate-500 text-center py-10">No leave requests found.</p></CardBody>
              : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Employee</Th>
                      <Th>Type</Th>
                      <Th>Period</Th>
                      <Th>Days</Th>
                      <Th>Attachment</Th>
                      <Th>Status</Th>
                      <Th>Submitted</Th>
                      {canApprove && <Th>Action</Th>}
                    </tr>
                  </thead>
                  <tbody>
                    {leaveRequests.map(req => (
                      <tr key={req.id} className="hover:bg-white/2 transition-colors">
                        <Td>
                          {req.employee ? (
                            <div className="flex items-center gap-2.5">
                              <Avatar name={`${req.employee.first_name} ${req.employee.last_name}`} size="sm" />
                              <div>
                                <p className="text-sm font-medium text-white">{req.employee.first_name} {req.employee.last_name}</p>
                                <p className="text-xs text-slate-500">{req.employee.department}</p>
                              </div>
                            </div>
                          ) : <span className="text-slate-500 text-sm">—</span>}
                        </Td>
                        <Td>
                          <span className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border',
                            req.leave_type === 'annual' ? 'bg-brand-500/15 text-brand-400 border-brand-500/25' :
                            req.leave_type === 'sick'   ? 'bg-red-500/15 text-red-400 border-red-500/25' :
                            'bg-slate-500/15 text-slate-400 border-slate-500/25')}>
                            {LEAVE_TYPE_LABEL[req.leave_type] || req.leave_type}
                          </span>
                        </Td>
                        <Td className="text-xs text-slate-300 whitespace-nowrap">
                          {formatDate(req.start_date, 'short')} – {formatDate(req.end_date, 'short')}
                        </Td>
                        <Td className="font-mono text-xs text-white">{req.days}</Td>
                        <Td>
                          {req.attachment_name ? (
                            <button
                              onClick={() => handleDownload(req.id, req.attachment_name!)}
                              disabled={downloading === req.id}
                              className="flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 transition-colors disabled:opacity-50"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                              </svg>
                              {downloading === req.id ? 'Downloading…' : req.attachment_name.length > 20 ? req.attachment_name.slice(0, 20) + '…' : req.attachment_name}
                            </button>
                          ) : (
                            <span className={cn('text-xs', req.leave_type === 'sick' ? 'text-amber-400/70' : 'text-slate-600')}>
                              {req.leave_type === 'sick' ? '⚠ Missing' : '—'}
                            </span>
                          )}
                        </Td>
                        <Td><Badge status={req.status} /></Td>
                        <Td className="text-xs text-slate-500">{formatDate(req.created_at, 'short')}</Td>
                        {canApprove && (
                          <Td>
                            {req.status === 'pending' ? (
                              <div className="flex gap-1.5">
                                <Button size="sm" variant="success" loading={updateLeave.isPending}
                                  onClick={() => handleLeaveAction(req.id, 'approved')}>Approve</Button>
                                <Button size="sm" variant="danger"  loading={updateLeave.isPending}
                                  onClick={() => handleLeaveAction(req.id, 'denied')}>Deny</Button>
                              </div>
                            ) : <span className="text-xs text-slate-600">—</span>}
                          </Td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )
            }
          </Card>
        </div>
      )}

      <NewLeaveModal open={reqOpen} onClose={() => setReqOpen(false)} employees={employees} />
    </div>
  )
}

// ─── Per-employee balance row for the HR overview table ──────────────────────
function EmpBalanceRow({ emp }: { emp: Employee }) {
  const { data: balance } = useQuery<AnnualLeaveBalance>({
    queryKey: ['annual-leave-balance', emp.id],
    queryFn: () => fetchAnnualLeaveBalance(emp.id),
    staleTime: 60_000,
  })

  const yearsText = !emp.start_date ? '—' : (() => {
    const ms = Date.now() - new Date(emp.start_date).getTime()
    const y  = Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25))
    const m  = Math.floor((ms % (1000 * 60 * 60 * 24 * 365.25)) / (1000 * 60 * 60 * 24 * 30.44))
    return y > 0 ? `${y}y ${m}m` : `${m} months`
  })()

  return (
    <tr className="hover:bg-white/2 transition-colors">
      <Td>
        <div className="flex items-center gap-2.5">
          <Avatar name={`${emp.first_name} ${emp.last_name}`} size="sm" />
          <div>
            <p className="text-sm font-medium text-white">{emp.first_name} {emp.last_name}</p>
            <p className="text-xs text-slate-500">{emp.job_title}</p>
          </div>
        </div>
      </Td>
      <Td className="text-xs text-slate-400">{emp.start_date ? formatDate(emp.start_date, 'short') : '—'}</Td>
      <Td className="text-xs text-slate-300">{yearsText}</Td>
      <Td className="font-mono text-xs text-white">{balance ? balance.allocated : '…'}</Td>
      <Td className="font-mono text-xs text-red-400">{balance ? balance.used : '…'}</Td>
      <Td>
        {balance ? (
          <span className={cn('font-mono text-xs font-bold',
            balance.expired ? 'text-slate-500' :
            balance.remaining === 0 ? 'text-amber-400' : 'text-teal-400')}>
            {balance.expired ? 'Expired' : balance.remaining}
          </span>
        ) : '…'}
      </Td>
      <Td>
        {balance?.expired ? (
          <Badge status="rejected">Expired</Badge>
        ) : balance?.remaining === 0 ? (
          <Badge status="denied">Exhausted</Badge>
        ) : balance ? (
          <Badge status="approved">Active</Badge>
        ) : null}
      </Td>
    </tr>
  )
}
