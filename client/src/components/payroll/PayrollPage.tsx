import { useState, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Card, CardHeader, CardBody, Badge, Button, StatCard,
  Avatar, Table, Th, Td, Skeleton, Modal,
} from '@/components/ui'
import { usePayroll, useEmployees } from '@/hooks'
import { useAuth } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDate } from '@/lib/utils'
import { processPayroll, updatePayrollRecord } from '@/lib/api'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import type { PayrollRecord, Employee } from '@/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────
const DEPT_COLORS = ['#6C63FF','#00D4AA','#F5A623','#E86FA0','#3DD68C','#3B82F6','#FF5F5F','#8B85FF','#4FA3E8']

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : `${Math.round(n)}`

function fmt(n: number) { return formatCurrency(n) }

// ─── Process Payroll Modal ────────────────────────────────────────────────────
interface ProcessModalProps {
  employees: Employee[]
  onClose: () => void
}

function ProcessModal({ employees, onClose }: ProcessModalProps) {
  const qc = useQueryClient()
  const today = new Date()
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10)
  const lastOfMonth  = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10)

  const [period_start, setPeriodStart] = useState(firstOfMonth)
  const [period_end,   setPeriodEnd]   = useState(lastOfMonth)
  const [selected, setSelected] = useState<Set<string>>(new Set(employees.map(e => e.id)))
  const [overrides, setOverrides] = useState<Record<string, { bonus: string; benefits: string }>>({})

  const TAX_RATE = 0.35

  function getOverride(id: string) {
    return overrides[id] ?? { bonus: '0', benefits: '0' }
  }
  function setOverride(id: string, field: 'bonus' | 'benefits', val: string) {
    setOverrides(prev => ({ ...prev, [id]: { ...getOverride(id), [field]: val } }))
  }
  function toggleAll() {
    setSelected(selected.size === employees.length ? new Set() : new Set(employees.map(e => e.id)))
  }

  const preview = useMemo(() => {
    return employees
      .filter(e => selected.has(e.id))
      .map(e => {
        const base = Math.round((Number(e.salary) || 0) / 12)
        const bonus    = Number(getOverride(e.id).bonus)    || 0
        const benefits = Number(getOverride(e.id).benefits) || 0
        const gross    = base + bonus + benefits
        const tax      = Math.round(gross * TAX_RATE)
        const net      = gross - tax
        return { emp: e, base, bonus, benefits, gross, tax, net }
      })
  }, [selected, overrides, employees])

  const totalGross = preview.reduce((s, r) => s + r.gross, 0)
  const totalNet   = preview.reduce((s, r) => s + r.net, 0)
  const totalTax   = preview.reduce((s, r) => s + r.tax, 0)

  const mutation = useMutation({
    mutationFn: () => processPayroll(
      [...selected],
      period_start,
      period_end,
      Object.fromEntries(
        [...selected].map(id => [id, {
          bonus:    Number(getOverride(id).bonus)    || 0,
          benefits: Number(getOverride(id).benefits) || 0,
        }])
      )
    ),
    onSuccess: (res) => {
      toast.success(`Processed ${res.processed} payslip${res.processed === 1 ? '' : 's'}`)
      qc.invalidateQueries({ queryKey: ['payroll'] })
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <Modal open onClose={onClose} title="Process Payroll" size="lg">
      <div className="space-y-4">
        {/* Period */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Period Start</label>
            <input type="date" value={period_start} onChange={e => setPeriodStart(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Period End</label>
            <input type="date" value={period_end} onChange={e => setPeriodEnd(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500" />
          </div>
        </div>

        {/* Formula note */}
        <div className="bg-brand-500/10 border border-brand-500/20 rounded-xl px-4 py-2.5 text-xs text-brand-300">
          <span className="font-semibold">Formula:</span> Gross = Base Salary + Bonus + Benefits &nbsp;·&nbsp; Tax = Gross × 35% &nbsp;·&nbsp; Net = Gross − Tax
        </div>

        {/* Employee table with bonus/benefits inputs */}
        <div className="max-h-72 overflow-y-auto rounded-xl border border-white/10">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#13151c] z-10">
              <tr className="border-b border-white/10">
                <th className="px-3 py-2.5 text-left">
                  <input type="checkbox" checked={selected.size === employees.length}
                    onChange={toggleAll}
                    className="rounded border-white/20 bg-white/5 accent-brand-500 cursor-pointer" />
                </th>
                <th className="px-3 py-2.5 text-left text-slate-400 font-medium">Employee</th>
                <th className="px-3 py-2.5 text-right text-slate-400 font-medium">Base/mo</th>
                <th className="px-3 py-2.5 text-right text-slate-400 font-medium">
                  <span className="text-emerald-400">Bonus</span>
                </th>
                <th className="px-3 py-2.5 text-right text-slate-400 font-medium">
                  <span className="text-sky-400">Benefits</span>
                </th>
                <th className="px-3 py-2.5 text-right text-slate-400 font-medium">Gross</th>
                <th className="px-3 py-2.5 text-right text-slate-400 font-medium">Tax (35%)</th>
                <th className="px-3 py-2.5 text-right text-slate-400 font-medium">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {employees.map(emp => {
                const checked = selected.has(emp.id)
                const ov = getOverride(emp.id)
                const base     = Math.round((Number(emp.salary) || 0) / 12)
                const bonus    = Number(ov.bonus)    || 0
                const benefits = Number(ov.benefits) || 0
                const gross    = base + bonus + benefits
                const tax      = Math.round(gross * TAX_RATE)
                const net      = gross - tax
                return (
                  <tr key={emp.id} className={`transition-colors ${checked ? 'hover:bg-white/[0.02]' : 'opacity-40'}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={checked}
                        onChange={() => setSelected(prev => {
                          const next = new Set(prev)
                          next.has(emp.id) ? next.delete(emp.id) : next.add(emp.id)
                          return next
                        })}
                        className="rounded border-white/20 bg-white/5 accent-brand-500 cursor-pointer" />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Avatar name={`${emp.first_name} ${emp.last_name}`} size="xs" />
                        <div>
                          <p className="text-white font-medium">{emp.first_name} {emp.last_name}</p>
                          <p className="text-slate-500 text-[11px]">{emp.job_title}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-300">{fmt(base)}</td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min="0" value={ov.bonus}
                        onChange={e => setOverride(emp.id, 'bonus', e.target.value)}
                        disabled={!checked}
                        className="w-24 bg-white/5 border border-emerald-500/30 rounded-lg px-2 py-1 text-right text-emerald-300 font-mono focus:outline-none focus:border-emerald-400 disabled:opacity-30" />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min="0" value={ov.benefits}
                        onChange={e => setOverride(emp.id, 'benefits', e.target.value)}
                        disabled={!checked}
                        className="w-24 bg-white/5 border border-sky-500/30 rounded-lg px-2 py-1 text-right text-sky-300 font-mono focus:outline-none focus:border-sky-400 disabled:opacity-30" />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-white font-semibold">{fmt(gross)}</td>
                    <td className="px-3 py-2 text-right font-mono text-red-400">-{fmt(tax)}</td>
                    <td className="px-3 py-2 text-right font-mono text-teal-400 font-semibold">{fmt(net)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Summary bar */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Total Gross', val: totalGross, color: 'text-white' },
            { label: 'Total Tax (35%)', val: totalTax, color: 'text-red-400' },
            { label: 'Total Net Pay', val: totalNet, color: 'text-teal-400' },
          ].map(s => (
            <div key={s.label} className="bg-white/5 rounded-xl px-4 py-3 text-center">
              <p className="text-xs text-slate-500">{s.label}</p>
              <p className={`text-lg font-bold font-mono ${s.color} mt-0.5`}>{fmt(s.val)}</p>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            onClick={() => {
              if (!period_start || !period_end) return toast.error('Set pay period dates')
              if (selected.size === 0) return toast.error('Select at least one employee')
              mutation.mutate()
            }}
          >
            Process {selected.size} Payslip{selected.size !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Edit Record Modal ────────────────────────────────────────────────────────
function EditRecordModal({ record, onClose }: { record: PayrollRecord; onClose: () => void }) {
  const qc = useQueryClient()
  const [bonus,    setBonus]    = useState(String(record.bonus    ?? 0))
  const [benefits, setBenefits] = useState(String(record.benefits ?? 0))

  const TAX_RATE = 0.35
  const base  = record.base_salary
  const b     = Number(bonus)    || 0
  const ben   = Number(benefits) || 0
  const gross = base + b + ben
  const tax   = Math.round(gross * TAX_RATE)
  const net   = gross - tax

  const mutation = useMutation({
    mutationFn: () => updatePayrollRecord(record.id, { bonus: b, benefits: ben }),
    onSuccess: () => { toast.success('Payroll record updated'); qc.invalidateQueries({ queryKey: ['payroll'] }); onClose() },
    onError: (e: Error) => toast.error(e.message),
  })

  const emp = record.employee

  return (
    <Modal open onClose={onClose} title="Edit Bonus & Benefits" size="md">
      <div className="space-y-4">
        {emp && (
          <div className="flex items-center gap-3 bg-white/5 rounded-xl p-3">
            <Avatar name={`${emp.first_name} ${emp.last_name}`} size="sm" />
            <div>
              <p className="text-sm font-medium text-white">{emp.first_name} {emp.last_name}</p>
              <p className="text-xs text-slate-400">{emp.job_title} · {emp.department}</p>
            </div>
          </div>
        )}

        <div className="bg-white/5 rounded-xl p-3 text-xs text-slate-400 space-y-1">
          <div className="flex justify-between"><span>Base Salary (monthly)</span><span className="font-mono text-white">{fmt(base)}</span></div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-emerald-400 mb-1.5">Bonus</label>
            <input type="number" min="0" value={bonus} onChange={e => setBonus(e.target.value)}
              className="w-full bg-white/5 border border-emerald-500/30 rounded-xl px-3 py-2.5 text-sm text-emerald-300 font-mono focus:outline-none focus:border-emerald-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-sky-400 mb-1.5">Benefits</label>
            <input type="number" min="0" value={benefits} onChange={e => setBenefits(e.target.value)}
              className="w-full bg-white/5 border border-sky-500/30 rounded-xl px-3 py-2.5 text-sm text-sky-300 font-mono focus:outline-none focus:border-sky-400" />
          </div>
        </div>

        {/* Live preview */}
        <div className="bg-brand-500/8 border border-brand-500/20 rounded-xl p-4 space-y-2 text-sm">
          <p className="text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">Live Preview</p>
          {[
            { label: 'Base Salary',  val: fmt(base),  color: 'text-slate-300' },
            { label: 'Bonus',        val: `+${fmt(b)}`, color: 'text-emerald-400' },
            { label: 'Benefits',     val: `+${fmt(ben)}`, color: 'text-sky-400' },
            { label: 'Gross Pay',    val: fmt(gross), color: 'text-white font-semibold' },
            { label: 'Tax (35%)',    val: `-${fmt(tax)}`, color: 'text-red-400' },
            { label: 'Net Pay',      val: fmt(net),   color: 'text-teal-400 font-bold text-base' },
          ].map(row => (
            <div key={row.label} className="flex justify-between items-center">
              <span className="text-xs text-slate-400">{row.label}</span>
              <span className={`font-mono text-xs ${row.color}`}>{row.val}</span>
            </div>
          ))}
          <div className="border-t border-white/10 pt-2 mt-1 flex justify-between items-center">
            <span className="text-xs text-slate-500">Effective tax rate</span>
            <span className="text-xs font-mono text-slate-400">35%</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mutation.isPending} onClick={() => mutation.mutate()}>Save Changes</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Main HR Payroll Page ─────────────────────────────────────────────────────
export function PayrollPage() {
  const role = useAuth((s) => s.user?.role)
  const canProcess = can(role, 'payroll.process')
  const { data: records, isLoading } = usePayroll()
  const { data: employees = [] } = useEmployees()

  if (role === 'employee') return <MyPayroll records={records} isLoading={isLoading} />

  const [showProcess, setShowProcess] = useState(false)
  const [editRecord,  setEditRecord]  = useState<PayrollRecord | null>(null)

  const recs = records ?? []
  const totalGross      = recs.reduce((s, r) => s + (r.gross_pay ?? r.base_salary + r.bonus), 0)
  const totalNet        = recs.reduce((s, r) => s + r.net_pay, 0)
  const totalBonus      = recs.reduce((s, r) => s + (r.bonus ?? 0), 0)
  const totalBenefits   = recs.reduce((s, r) => s + (r.benefits ?? 0), 0)
  const totalDeductions = recs.reduce((s, r) => s + r.deductions, 0)
  const totalSalaries   = recs.reduce((s, r) => s + r.base_salary, 0)

  // Dept breakdown on gross
  const deptTotals: Record<string, number> = {}
  for (const r of recs) {
    const d = r.employee?.department ?? 'Unknown'
    deptTotals[d] = (deptTotals[d] || 0) + (r.gross_pay ?? r.base_salary)
  }
  const deptPayroll = Object.entries(deptTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([dept, amount], i) => ({ dept, amount, pct: totalGross ? Math.round((amount / totalGross) * 100) : 0, color: DEPT_COLORS[i % DEPT_COLORS.length] }))

  // Monthly gross trend
  const monthTotals: Record<string, number> = {}
  for (const r of recs) {
    const key = r.period_end ? new Date(r.period_end).toLocaleString('en-US', { month: 'short', year: '2-digit' }) : '—'
    monthTotals[key] = (monthTotals[key] || 0) + (r.gross_pay ?? r.base_salary)
  }
  const monthly = Object.entries(monthTotals).map(([month, amount]) => ({ month, amount }))

  function exportCsv() {
    if (!recs.length) { toast.error('No records to export'); return }
    const header = ['Employee', 'Department', 'Base Salary', 'Bonus', 'Benefits', 'Gross Pay', 'Tax (35%)', 'Net Pay', 'Status', 'Period']
    const rows = recs.map(r => [
      `${r.employee?.first_name ?? ''} ${r.employee?.last_name ?? ''}`.trim(),
      r.employee?.department ?? '',
      r.base_salary, r.bonus ?? 0, r.benefits ?? 0,
      r.gross_pay ?? r.base_salary, r.deductions, r.net_pay, r.status,
      `${r.period_start} – ${r.period_end}`,
    ])
    const csv = [header, ...rows].map(line => line.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    a.download = 'payroll-export.csv'
    a.click()
    toast.success('Payroll exported')
  }

  return (
    <div className="space-y-6">
      {/* Top Stats */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Gross Payroll" value={compact(totalGross)} change={`${recs.length} payslip${recs.length !== 1 ? 's' : ''}`} changeType="neutral" icon="💰" accent="bg-brand-500" />
        <StatCard label="Total Net Pay" value={compact(totalNet)} change="After 35% tax" icon="✅" accent="bg-teal-500" />
        <StatCard label="Total Tax Deducted" value={compact(totalDeductions)} change="35% of gross" changeType="down" icon="🛡" accent="bg-red-500" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Base Salaries" value={compact(totalSalaries)} change="Monthly salaries" icon="👤" accent="bg-slate-500" />
        <StatCard label="Total Bonuses" value={compact(totalBonus)} change="This run" changeType={totalBonus > 0 ? 'up' : 'neutral'} icon="🎯" accent="bg-amber-500" />
        <StatCard label="Total Benefits" value={compact(totalBenefits)} change="This run" changeType={totalBenefits > 0 ? 'up' : 'neutral'} icon="🏥" accent="bg-sky-500" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-2 gap-5">
        {/* Top compensations */}
        <Card>
          <CardHeader>
            <h3 className="font-display font-semibold text-white text-sm">Top Gross Compensations</h3>
            <Badge status="processed" className="bg-brand-500/15 text-brand-400 border-brand-500/20">Latest run</Badge>
          </CardHeader>
          {isLoading
            ? <CardBody><div className="space-y-3">{Array.from({length:5}).map((_,i)=><Skeleton key={i} className="h-14"/>)}</div></CardBody>
            : <div className="divide-y divide-white/4">
                {[...recs].sort((a,b) => (b.gross_pay??b.base_salary)-(a.gross_pay??a.base_salary)).slice(0,6).map((rec,i) => {
                  const emp = rec.employee; if(!emp) return null
                  const gross = rec.gross_pay ?? rec.base_salary
                  return (
                    <div key={rec.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-white/2 transition-colors">
                      <span className="text-sm text-slate-600 w-4 font-mono">{i+1}</span>
                      <Avatar name={`${emp.first_name} ${emp.last_name}`} size="sm"/>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{emp.first_name} {emp.last_name}</p>
                        <p className="text-xs text-slate-500">{emp.job_title} · {emp.department}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-white font-mono">{fmt(gross)}</p>
                        <div className="flex gap-2 justify-end mt-0.5">
                          {(rec.bonus??0)>0    && <span className="text-[11px] text-emerald-400">+{fmt(rec.bonus??0)} bonus</span>}
                          {(rec.benefits??0)>0 && <span className="text-[11px] text-sky-400">+{fmt(rec.benefits??0)} benefits</span>}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
          }
        </Card>

        {/* Dept breakdown */}
        <Card>
          <CardHeader><h3 className="font-display font-semibold text-white text-sm">Gross Payroll by Department</h3></CardHeader>
          <CardBody className="space-y-4">
            {deptPayroll.length === 0
              ? <p className="text-sm text-slate-500 text-center py-6">No payroll data yet.</p>
              : deptPayroll.map(d => (
                <div key={d.dept}>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-slate-400">{d.dept}</span>
                    <span className="text-white font-medium">{compact(d.amount)} · {d.pct}%</span>
                  </div>
                  <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width:`${d.pct}%`, background: d.color }}/>
                  </div>
                </div>
              ))
            }
          </CardBody>
        </Card>
      </div>

      {/* Monthly gross trend */}
      <Card>
        <CardHeader>
          <h3 className="font-display font-semibold text-white text-sm">Gross Payroll by Period</h3>
          <span className="text-xs text-slate-500">Total gross pay per pay period</span>
        </CardHeader>
        <CardBody>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={monthly} margin={{ top: 4, right: 0, left: -10, bottom: 0 }}>
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 11 }} axisLine={false} tickLine={false}/>
              <YAxis tick={{ fill: '#475569', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => compact(Number(v))} width={56}/>
              <Tooltip contentStyle={{ background: '#1a1c23', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, fontSize: 12 }}
                formatter={(v: number) => [fmt(v), 'Gross payroll']}/>
              <Bar dataKey="amount" radius={[4,4,0,0]}>
                {monthly.map((_, i) => <Cell key={i} fill={DEPT_COLORS[i % DEPT_COLORS.length]} opacity={0.8}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardBody>
      </Card>

      {/* Full records table */}
      <Card>
        <CardHeader>
          <h3 className="font-display font-semibold text-white text-sm">Payroll Records</h3>
          <div className="flex items-center gap-2">
            {canProcess && (
              <>
                <Button size="sm" variant="ghost" onClick={exportCsv}>
                  <svg className="w-3.5 h-3.5 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Export
                </Button>
                <Button size="sm" variant="primary" onClick={() => setShowProcess(true)}>
                  + Process Payroll
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        {isLoading
          ? <CardBody><div className="space-y-3">{Array.from({length:5}).map((_,i)=><Skeleton key={i} className="h-12"/>)}</div></CardBody>
          : <Table>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Period</Th>
                  <Th>Base Salary</Th>
                  <Th><span className="text-emerald-400">Bonus</span></Th>
                  <Th><span className="text-sky-400">Benefits</span></Th>
                  <Th>Gross Pay</Th>
                  <Th><span className="text-red-400">Tax (35%)</span></Th>
                  <Th><span className="text-teal-400">Net Pay</span></Th>
                  <Th>Status</Th>
                  {canProcess && <Th/>}
                </tr>
              </thead>
              <tbody>
                {recs.map(rec => {
                  const emp = rec.employee; if(!emp) return null
                  const gross = rec.gross_pay ?? (rec.base_salary + (rec.bonus??0) + (rec.benefits??0))
                  return (
                    <tr key={rec.id} className="hover:bg-white/2 transition-colors group">
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={`${emp.first_name} ${emp.last_name}`} size="sm"/>
                          <div>
                            <p className="text-sm font-medium text-white">{emp.first_name} {emp.last_name}</p>
                            <p className="text-xs text-slate-500">{emp.department}</p>
                          </div>
                        </div>
                      </Td>
                      <Td className="text-xs text-slate-400 whitespace-nowrap">
                        {rec.period_start ? `${formatDate(rec.period_start,'short')} – ${formatDate(rec.period_end,'short')}` : '—'}
                      </Td>
                      <Td className="font-mono text-xs">{fmt(rec.base_salary)}</Td>
                      <Td className="font-mono text-xs text-emerald-400">{(rec.bonus??0)>0 ? `+${fmt(rec.bonus??0)}` : '—'}</Td>
                      <Td className="font-mono text-xs text-sky-400">{(rec.benefits??0)>0 ? `+${fmt(rec.benefits??0)}` : '—'}</Td>
                      <Td className="font-mono text-xs font-semibold text-white">{fmt(gross)}</Td>
                      <Td className="font-mono text-xs text-red-400">-{fmt(rec.deductions)}</Td>
                      <Td className="font-mono text-xs font-bold text-teal-400">{fmt(rec.net_pay)}</Td>
                      <Td><Badge status={rec.status}/></Td>
                      {canProcess && (
                        <Td>
                          <button
                            onClick={() => setEditRecord(rec)}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all"
                            title="Edit bonus & benefits"
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                          </button>
                        </Td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </Table>
        }
      </Card>

      {showProcess && <ProcessModal employees={employees.filter(e => e.status === 'active')} onClose={() => setShowProcess(false)}/>}
      {editRecord  && <EditRecordModal record={editRecord} onClose={() => setEditRecord(null)}/>}
    </div>
  )
}

// ─── Employee Payroll View ────────────────────────────────────────────────────
function MyPayroll({ records, isLoading }: { records?: PayrollRecord[]; isLoading: boolean }) {
  const { data: employees } = useEmployees()
  const me = employees?.[0]
  const sorted = [...(records ?? [])].sort((a,b) => new Date(b.period_end).getTime() - new Date(a.period_end).getTime())
  const latest = sorted[0]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-white">My Payroll</h2>
        <p className="text-sm text-slate-500 mt-0.5">Your salary details and payslip history</p>
      </div>

      {/* My profile card */}
      <Card>
        <CardHeader><h3 className="font-display font-semibold text-white text-sm">My Details</h3></CardHeader>
        {me ? (
          <Table>
            <thead><tr><Th>Employee</Th><Th>Department</Th><Th>Role</Th><Th>Status</Th><Th>Start Date</Th><Th>Annual Salary</Th><Th>Monthly Base</Th></tr></thead>
            <tbody>
              <tr>
                <Td><div className="flex items-center gap-2.5"><Avatar name={`${me.first_name} ${me.last_name}`} size="sm"/><span className="text-sm text-white font-medium">{me.first_name} {me.last_name}</span></div></Td>
                <Td className="text-sm text-slate-300">{me.department||'—'}</Td>
                <Td className="text-sm text-slate-300">{me.job_title||'—'}</Td>
                <Td><Badge status={me.status}/></Td>
                <Td className="text-sm text-slate-300">{me.start_date ? formatDate(me.start_date,'short') : '—'}</Td>
                <Td className="font-mono text-xs font-semibold text-white">{me.salary ? fmt(me.salary) : '—'}</Td>
                <Td className="font-mono text-xs text-brand-400">{me.salary ? fmt(Math.round(me.salary/12)) : '—'}</Td>
              </tr>
            </tbody>
          </Table>
        ) : (
          <CardBody><p className="text-sm text-slate-500 text-center py-6">Your employee profile isn't linked yet.</p></CardBody>
        )}
      </Card>

      {/* Latest payslip stats */}
      {latest && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white/[0.04] border border-white/8 rounded-2xl p-4">
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Gross Pay</p>
            <p className="text-2xl font-bold font-mono text-white mt-1">{fmt(latest.gross_pay ?? latest.base_salary)}</p>
            <p className="text-xs text-slate-500 mt-1">Base + Bonus + Benefits</p>
          </div>
          <div className="bg-red-500/8 border border-red-500/15 rounded-2xl p-4">
            <p className="text-xs text-red-400/70 font-medium uppercase tracking-wider">Tax Deducted (35%)</p>
            <p className="text-2xl font-bold font-mono text-red-400 mt-1">-{fmt(latest.deductions)}</p>
            <p className="text-xs text-red-400/50 mt-1">Income tax withheld</p>
          </div>
          <div className="bg-teal-500/10 border border-teal-500/20 rounded-2xl p-4">
            <p className="text-xs text-teal-400/70 font-medium uppercase tracking-wider">Net Pay</p>
            <p className="text-2xl font-bold font-mono text-teal-400 mt-1">{fmt(latest.net_pay)}</p>
            <p className="text-xs text-teal-400/50 mt-1">Take-home amount</p>
          </div>
        </div>
      )}

      {/* Payslip breakdown for latest */}
      {latest && (
        <Card>
          <CardHeader><h3 className="font-display font-semibold text-white text-sm">Latest Payslip Breakdown</h3>
            <span className="text-xs text-slate-500">{formatDate(latest.period_start,'short')} – {formatDate(latest.period_end,'short')}</span>
          </CardHeader>
          <CardBody>
            <div className="space-y-2 max-w-sm">
              {[
                { label: 'Base Salary',   val: fmt(latest.base_salary),           color: 'text-slate-200',  sign: '' },
                { label: 'Bonus',         val: fmt(latest.bonus??0),               color: 'text-emerald-400', sign: '+', hide: !(latest.bonus??0) },
                { label: 'Benefits',      val: fmt(latest.benefits??0),            color: 'text-sky-400',     sign: '+', hide: !(latest.benefits??0) },
                { label: 'Gross Pay',     val: fmt(latest.gross_pay??latest.base_salary), color: 'text-white font-bold', sign: '=', border: true },
                { label: 'Tax (35%)',     val: fmt(latest.deductions),             color: 'text-red-400',     sign: '−' },
                { label: 'Net Pay',       val: fmt(latest.net_pay),                color: 'text-teal-400 font-bold text-lg', sign: '=', border: true },
              ].filter(r => !r.hide).map(row => (
                <div key={row.label} className={`flex items-center justify-between py-1.5 ${row.border ? 'border-t border-white/10 mt-2 pt-3' : ''}`}>
                  <div className="flex items-center gap-3">
                    <span className="w-4 text-center text-slate-600 font-mono text-sm">{row.sign}</span>
                    <span className="text-sm text-slate-400">{row.label}</span>
                  </div>
                  <span className={`font-mono text-sm ${row.color}`}>{row.val}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Full history */}
      <Card>
        <CardHeader>
          <h3 className="font-display font-semibold text-white text-sm">Payslip History</h3>
          <Badge status="processed">{sorted.length} record{sorted.length!==1?'s':''}</Badge>
        </CardHeader>
        {isLoading
          ? <CardBody><div className="space-y-3">{Array.from({length:3}).map((_,i)=><Skeleton key={i} className="h-12"/>)}</div></CardBody>
          : sorted.length === 0
          ? <CardBody><p className="text-sm text-slate-500 text-center py-8">No payslips issued yet.</p></CardBody>
          : <Table>
              <thead><tr>
                <Th>Period</Th>
                <Th>Base</Th>
                <Th><span className="text-emerald-400">Bonus</span></Th>
                <Th><span className="text-sky-400">Benefits</span></Th>
                <Th>Gross</Th>
                <Th><span className="text-red-400">Tax</span></Th>
                <Th><span className="text-teal-400">Net Pay</span></Th>
                <Th>Status</Th>
              </tr></thead>
              <tbody>
                {sorted.map(rec => (
                  <tr key={rec.id} className="hover:bg-white/2 transition-colors">
                    <Td className="text-sm text-white whitespace-nowrap">{formatDate(rec.period_start,'short')} – {formatDate(rec.period_end,'short')}</Td>
                    <Td className="font-mono text-xs">{fmt(rec.base_salary)}</Td>
                    <Td className="font-mono text-xs text-emerald-400">{(rec.bonus??0)>0 ? `+${fmt(rec.bonus??0)}` : '—'}</Td>
                    <Td className="font-mono text-xs text-sky-400">{(rec.benefits??0)>0 ? `+${fmt(rec.benefits??0)}` : '—'}</Td>
                    <Td className="font-mono text-xs font-semibold text-white">{fmt(rec.gross_pay??rec.base_salary)}</Td>
                    <Td className="font-mono text-xs text-red-400">-{fmt(rec.deductions)}</Td>
                    <Td className="font-mono text-xs font-bold text-teal-400">{fmt(rec.net_pay)}</Td>
                    <Td><Badge status={rec.status}/></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
        }
      </Card>
    </div>
  )
}
