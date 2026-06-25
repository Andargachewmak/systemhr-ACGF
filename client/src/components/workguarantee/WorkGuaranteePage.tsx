import { useState, useEffect } from 'react'
import { fetchWorkGuarantees, requestWorkGuarantee, updateWorkGuaranteeStatus, downloadWorkGuaranteeLetter, type WorkGuaranteeRequest } from '@/lib/api'
import { useAuth } from '@/lib/auth'

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
}

export default function WorkGuaranteePage() {
  const user = useAuth(s => s.user)
  const isHR = user?.role === 'admin' || user?.role === 'hr_director'
  const [items, setItems] = useState<WorkGuaranteeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState<WorkGuaranteeRequest | null>(null)
  const [form, setForm] = useState({ guaranteed_person_name: '', guaranteed_company: '', purpose: '' })
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const load = () => {
    setLoading(true)
    fetchWorkGuarantees().then(setItems).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const submit = async () => {
    if (!form.guaranteed_person_name || !form.guaranteed_company) {
      setErr('guaranteed_person' + ' and ' + 'Company / Organization' + ' are required')
      return
    }
    setSubmitting(true); setErr('')
    try {
      await requestWorkGuarantee(form)
      setShowForm(false)
      setForm({ guaranteed_person_name: '', guaranteed_company: '', purpose: '' })
      load()
    } catch (e: any) { setErr(e.message) } finally { setSubmitting(false) }
  }

  const approve = async (id: string) => {
    try {
      await updateWorkGuaranteeStatus(id, 'approved')
      load()
      // refresh selected
      setSelected(s => s?.id === id ? { ...s!, status: 'approved' } : s)
    } catch (e: any) { alert(e.message) }
  }

  const reject = async (id: string) => {
    const reason = window.prompt('Reason for rejection' + ' (optional):') ?? ''
    try {
      await updateWorkGuaranteeStatus(id, 'rejected', reason)
      load()
      setSelected(null)
    } catch (e: any) { alert(e.message) }
  }

  // Refresh selected letter_content after approve
  const openSelected = (item: WorkGuaranteeRequest) => {
    setSelected(item)
  }

  // After approve, reload and re-open to show letter
  const approveAndRefresh = async (id: string) => {
    await approve(id)
    const fresh = await fetchWorkGuarantees()
    setItems(fresh)
    const found = fresh.find(x => x.id === id)
    if (found) setSelected(found)
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{'Work Guarantee Letters'}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {isHR ? 'Review and approve work guarantee requests' : 'Request a work guarantee letter on behalf of someone'}
          </p>
        </div>
        <button onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
          + {'New Request'}
        </button>
      </div>

      {/* New request form */}
      {showForm && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4 shadow-sm">
          <h2 className="font-semibold text-gray-900">{'New Work Guarantee Request'}</h2>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'guaranteed_person'} *</label>
              <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                value={form.guaranteed_person_name}
                onChange={e => setForm(p => ({ ...p, guaranteed_person_name: e.target.value }))}
                placeholder="Full name of person being guaranteed" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Company / Organization'} *</label>
              <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                value={form.guaranteed_company}
                onChange={e => setForm(p => ({ ...p, guaranteed_company: e.target.value }))}
                placeholder="Company or organization name" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Purpose'}</label>
              <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                value={form.purpose}
                onChange={e => setForm(p => ({ ...p, purpose: e.target.value }))}
                placeholder="e.g. Bank loan guarantee, employment reference…" />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button onClick={submit} disabled={submitting}
              className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {submitting ? 'Loading…' : 'Submit'}
            </button>
            <button onClick={() => { setShowForm(false); setErr('') }}
              className="px-5 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
              {'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-xl p-6 max-w-2xl w-full shadow-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <h2 className="font-semibold text-gray-900">{'Work Guarantee'} — {selected.guaranteed_person_name}</h2>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-sm mb-4">
              <div>
                <dt className="text-gray-500 text-xs">{'Company / Organization'}</dt>
                <dd className="font-medium">{selected.guaranteed_company}</dd>
              </div>
              <div>
                <dt className="text-gray-500 text-xs">{'Status'}</dt>
                <dd><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[selected.status]}`}>{selected.status}</span></dd>
              </div>
              {selected.purpose && (
                <div className="col-span-2">
                  <dt className="text-gray-500 text-xs">{'Purpose'}</dt>
                  <dd>{selected.purpose}</dd>
                </div>
              )}
            </dl>

            {/* Generated letter preview */}
            {selected.letter_content && (
              <div className="mb-4 space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Generated Letter</p>
                <pre className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs font-mono whitespace-pre-wrap text-gray-700 max-h-64 overflow-y-auto">
                  {selected.letter_content}
                </pre>
                <button onClick={() => downloadWorkGuaranteeLetter(selected.id)}
                  className="px-4 py-2 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg text-sm hover:bg-indigo-100 flex items-center gap-2">
                  📄 {'Download'}
                </button>
              </div>
            )}

            {/* HR actions */}
            {isHR && selected.status === 'pending' && (
              <div className="flex gap-3">
                <button onClick={() => approveAndRefresh(selected.id)}
                  className="px-5 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                  ✓ {'Approve & Generate Letter'}
                </button>
                <button onClick={() => reject(selected.id)}
                  className="px-5 py-2 border border-red-300 text-red-700 rounded-lg text-sm font-medium hover:bg-red-50">
                  {'Reject'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">{'Loading…'}</div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-gray-400">{'No work guarantee requests yet.'}</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'guaranteed_person'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Company / Organization'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Requested By'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Status'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Date'}</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{item.guaranteed_person_name}</td>
                  <td className="px-4 py-3 text-gray-600">{item.guaranteed_company}</td>
                  <td className="px-4 py-3 text-gray-600">{item.employee?.full_name || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[item.status]}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{new Date(item.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => openSelected(item)} className="text-indigo-600 hover:underline text-xs font-medium">
                        {'View'}
                      </button>
                      {item.status === 'approved' && item.letter_content && (
                        <button onClick={() => downloadWorkGuaranteeLetter(item.id)} className="text-green-700 hover:underline text-xs font-medium">
                          {'Download'}
                        </button>
                      )}
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
