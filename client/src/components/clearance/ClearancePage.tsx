import { useState, useEffect, useRef } from 'react'
import { fetchClearanceRequests, createClearanceRequest, updateClearanceStatus, downloadClearanceDoc, downloadClearanceCertificate, type ClearanceRequest } from '@/lib/api'
import { EmployeePicker } from '@/components/ui/EmployeePicker'

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
}

export default function ClearancePage() {
  const [items, setItems] = useState<ClearanceRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ employee_id: '', last_working_date: '', reason: '' })
  const [docFile, setDocFile] = useState<{ data: string; name: string; mime: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => {
    setLoading(true)
    fetchClearanceRequests().then(setItems).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setDocFile({
      data: (reader.result as string).split(',')[1],
      name: file.name,
      mime: file.type,
    })
    reader.readAsDataURL(file)
  }

  const submit = async () => {
    if (!form.employee_id) { setErr('Please select an employee'); return }
    setSubmitting(true); setErr('')
    try {
      await createClearanceRequest({
        employee_id: form.employee_id,
        last_working_date: form.last_working_date || undefined,
        reason: form.reason || undefined,
        doc_data: docFile?.data,
        doc_name: docFile?.name,
        doc_mime: docFile?.mime,
      })
      setShowForm(false)
      setForm({ employee_id: '', last_working_date: '', reason: '' })
      setDocFile(null)
      load()
    } catch (e: any) { setErr(e.message) } finally { setSubmitting(false) }
  }

  const handleStatus = async (id: string, status: 'approved' | 'rejected') => {
    const reason = status === 'rejected' ? (window.prompt('Reason for rejection' + ':') ?? '') : ''
    try {
      await updateClearanceStatus(id, status, reason)
      load()
    } catch (e: any) { alert(e.message) }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{'Clearance Requests'}</h1>
          <p className="text-sm text-gray-500 mt-1">Process employee clearance when leaving the organization</p>
        </div>
        <button onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
          + {'New Request'}
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4 shadow-sm">
          <h2 className="font-semibold text-gray-900">{'Initiate Clearance'}</h2>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <EmployeePicker
                label={'Employee' + ' *'}
                value={form.employee_id}
                onChange={id => setForm(p => ({ ...p, employee_id: id }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Last Working Date'}</label>
              <input type="date"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.last_working_date}
                onChange={e => setForm(p => ({ ...p, last_working_date: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Reason'}</label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.reason}
                onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                placeholder="Resignation, termination, retirement…" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">{'Attach Document (resignation letter, termination letter…)'}</label>
              <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={handleFile}
                className="block text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer" />
              {docFile && <p className="text-xs text-green-600 mt-1">✓ {docFile.name}</p>}
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

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">{'Loading…'}</div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-gray-400">{'No clearance requests yet.'}</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Employee'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Last Working Date'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Reason'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Document'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Certificate'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{'Status'}</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{item.employee?.full_name || item.employee_id}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">
                    {item.last_working_date ? new Date(item.last_working_date).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600 max-w-[140px] truncate text-xs">{item.reason || '—'}</td>
                  <td className="px-4 py-3">
                    {item.doc_name ? (
                      <button onClick={() => downloadClearanceDoc(item.id, item.doc_name!)}
                        className="text-indigo-600 hover:underline text-xs flex items-center gap-1">
                        📎 {item.doc_name.length > 16 ? item.doc_name.slice(0, 14) + '…' : item.doc_name}
                      </button>
                    ) : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {item.status === 'approved' ? (
                      <button onClick={() => downloadClearanceCertificate(item.id)}
                        className="text-green-700 hover:underline text-xs font-medium flex items-center gap-1">
                        📄 {'Download'}
                      </button>
                    ) : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[item.status]}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {item.status === 'pending' && (
                      <div className="flex gap-2">
                        <button onClick={() => handleStatus(item.id, 'approved')}
                          className="text-green-700 hover:underline text-xs font-medium">{'Approve'}</button>
                        <button onClick={() => handleStatus(item.id, 'rejected')}
                          className="text-red-600 hover:underline text-xs font-medium">{'Reject'}</button>
                      </div>
                    )}
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
