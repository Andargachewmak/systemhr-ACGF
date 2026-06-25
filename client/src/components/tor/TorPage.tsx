import { useState, useEffect } from 'react'
import { fetchTorTrainings, createTorTraining, type TorTraining } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { DEPARTMENTS } from '@/lib/org'
import { EmployeePicker } from '@/components/ui/EmployeePicker'

export default function TorPage() {
  const user = useAuth(s => s.user)
  const isHR = user?.role === 'admin' || user?.role === 'hr_director'
  const [items, setItems] = useState<TorTraining[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState<TorTraining | null>(null)
  const [scope, setScope] = useState<'employee' | 'department'>('employee')
  const [form, setForm] = useState({
    employee_id: '', department: '', title: '', objective: '',
    duration: '', venue: '', trainer: '', start_date: '', end_date: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const load = () => {
    setLoading(true)
    fetchTorTrainings().then(setItems).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const f = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }))

  const submit = async () => {
    if (!form.title) { setErr('Training Title' + ' is required'); return }
    if (scope === 'employee' && !form.employee_id) { setErr('Employee' + ' is required'); return }
    if (scope === 'department' && !form.department) { setErr('Department' + ' is required'); return }
    setSubmitting(true); setErr('')
    try {
      await createTorTraining({ ...form, scope })
      setShowForm(false)
      setForm({ employee_id: '', department: '', title: '', objective: '', duration: '', venue: '', trainer: '', start_date: '', end_date: '' })
      load()
    } catch (e: any) { setErr(e.message) } finally { setSubmitting(false) }
  }

  const downloadTor = (item: TorTraining) => {
    const blob = new Blob([item.tor_content || ''], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `TOR-${item.title.replace(/\s+/g, '-')}.txt`
    a.click()
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{'TOR — Training'}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {isHR ? 'Create Terms of Reference for employee training programs' : 'No training programs assigned to you or your department yet.'}
          </p>
        </div>
        {isHR && (
          <button onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
            + {'New TOR'}
          </button>
        )}
      </div>

      {/* Create form - HR only */}
      {showForm && isHR && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4 shadow-sm">
          <h2 className="font-semibold text-gray-900">{'Create Training TOR'}</h2>
          {err && <p className="text-sm text-red-600">{err}</p>}

          {/* Scope toggle */}
          <div className="flex gap-2">
            <button onClick={() => setScope('employee')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${scope === 'employee' ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
              {'Single Employee'}
            </button>
            <button onClick={() => setScope('department')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${scope === 'department' ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
              {'Whole Department'}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {scope === 'employee' ? (
              <div>
                <EmployeePicker
                  label={'Employee' + ' *'}
                  value={form.employee_id}
                  onChange={id => setForm(p => ({ ...p, employee_id: id }))}
                  required
                />
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">{'Department'} *</label>
                <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                  value={form.department} onChange={f('department')}>
                  <option value="">Select department…</option>
                  {DEPARTMENTS.map((d: string) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Training Title'} *</label>
              <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.title} onChange={f('title')} placeholder="e.g. Advanced Excel, Leadership Skills" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Objective'}</label>
              <textarea className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                rows={2} value={form.objective} onChange={f('objective')}
                placeholder="Training objective and expected outcomes" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Duration'}</label>
              <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.duration} onChange={f('duration')} placeholder="e.g. 3 days, 2 weeks" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Venue'}</label>
              <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.venue} onChange={f('venue')} placeholder="Location or Online" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Trainer / Facilitator'}</label>
              <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.trainer} onChange={f('trainer')} placeholder="Trainer name or organization" />
            </div>
            <div />
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Start Date'}</label>
              <input type="date" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.start_date} onChange={f('start_date')} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'End Date'}</label>
              <input type="date" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.end_date} onChange={f('end_date')} />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={submit} disabled={submitting}
              className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {submitting ? 'Loading…' : 'Generate'}
            </button>
            <button onClick={() => { setShowForm(false); setErr('') }}
              className="px-5 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
              {'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* TOR detail modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-xl p-6 max-w-2xl w-full shadow-2xl max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <h2 className="font-semibold text-gray-900">TOR — {selected.title}</h2>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <pre className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs font-mono whitespace-pre-wrap text-gray-700">
              {selected.tor_content}
            </pre>
            <button onClick={() => downloadTor(selected)}
              className="mt-4 px-4 py-2 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg text-sm hover:bg-indigo-100 flex items-center gap-2">
              📄 {'Download TOR'}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">{'Loading…'}</div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          {isHR ? 'No TOR records yet.' : 'No training programs assigned to you or your department yet.'}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Assigned To'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Training Title'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Duration'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Date'}</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">
                    {item.scope === 'department' ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold">DEPT</span>
                        {item.department}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold">EMP</span>
                        {item.employee?.full_name || item.employee_id}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">{item.title}</td>
                  <td className="px-4 py-3 text-gray-600">{item.duration || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {item.start_date ? new Date(item.start_date).toLocaleDateString() : '—'}
                    {item.end_date ? ` → ${new Date(item.end_date).toLocaleDateString()}` : ''}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => setSelected(item)} className="text-indigo-600 hover:underline text-xs font-medium">
                        {'View TOR'}
                      </button>
                      <button onClick={() => downloadTor(item)} className="text-gray-500 hover:underline text-xs font-medium">
                        {'Download'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
