import { useState, useRef, useEffect } from 'react'
import { fetchEmployeeIdCard, issueEmployeeIdCard, fetchSocialSecurityDoc, type IdCardData } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { EmployeePicker } from '@/components/ui/EmployeePicker'

export default function IdCardPage() {
  const user = useAuth(s => s.user)
  const isHR = user?.role === 'admin' || user?.role === 'hr_director'

  const [empId, setEmpId]           = useState(user?.employee_id || '')
  const [card, setCard]             = useState<IdCardData | null>(null)
  const [ssDoc, setSsDoc]           = useState<string | null>(null)
  const [loading, setLoading]       = useState(false)
  const [issuing, setIssuing]       = useState(false)
  const [err, setErr]               = useState('')
  const [notIssued, setNotIssued]   = useState(false)
  const printRef = useRef<HTMLDivElement>(null)

  // Load card preview (read-only, no issuance)
  const loadCard = async (id: string) => {
    if (!id) return
    setLoading(true); setErr(''); setNotIssued(false); setCard(null); setSsDoc(null)
    try {
      setCard(await fetchEmployeeIdCard(id))
    } catch (e: any) {
      if (/not been issued/i.test(e.message)) setNotIssued(true)
      else setErr(e.message)
    } finally { setLoading(false) }
  }

  // Issue card (HR action) → stamps DB → employee can now see it
  const generateCard = async () => {
    if (!empId) return
    setIssuing(true); setErr(''); setCard(null); setNotIssued(false)
    try {
      setCard(await issueEmployeeIdCard(empId))
    } catch (e: any) { setErr(e.message) }
    finally { setIssuing(false) }
  }

  // Auto-load for employees on mount
  useEffect(() => {
    if (!isHR && user?.employee_id) loadCard(user.employee_id)
  }, [])

  const loadSS = async () => {
    if (!card) return
    setLoading(true); setErr('')
    try {
      const d = await fetchSocialSecurityDoc(card.id)
      setSsDoc(d.document)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }

  const printCard = () => {
    const html = printRef.current?.innerHTML
    if (!html) return
    const w = window.open('', '_blank')!
    w.document.write(`<!DOCTYPE html><html><head><title>ID Card</title>
      <style>*{box-sizing:border-box}body{margin:0;display:flex;justify-content:center;align-items:center;
      min-height:100vh;background:#e5e7eb;font-family:system-ui,-apple-system,sans-serif}
      @media print{body{background:white}}</style></head><body>${html}</body></html>`)
    w.document.close()
    setTimeout(() => { w.focus(); w.print(); w.close() }, 300)
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Employee ID Card</h1>
        <p className="text-sm text-gray-500 mt-1">
          {isHR
            ? 'Enter an employee ID or search, then click Generate to issue the official ID card.'
            : 'Your official ACGF employee ID card.'}
        </p>
      </div>

      {/* ── HR Panel ── */}
      {isHR && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm space-y-4">
          {/* Direct ID input */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">
              Employee ID
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={empId}
                onChange={e => { setEmpId(e.target.value); setErr('') }}
                onKeyDown={e => { if (e.key === 'Enter' && empId) generateCard() }}
                placeholder="e.g. ACGF-20260612-1234 or paste UUID"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
              <button
                onClick={generateCard}
                disabled={issuing || !empId}
                className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap flex items-center gap-2"
              >
                {issuing
                  ? <><span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full inline-block" /> Generating…</>
                  : '🪪 Generate & Issue'}
              </button>
            </div>
          </div>

          {/* Or search */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">
              Or search by name / department
            </label>
            <EmployeePicker
              label=""
              value={empId}
              onChange={id => {
                setEmpId(id)
                setErr('')
                if (!id) setCard(null)
              }}
              placeholder="Search employee…"
            />
          </div>

          {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}

          {card?.is_issued && (
            <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              <span>✓</span>
              <span>Card issued — <strong>{card.full_name}</strong> can now see it on their own dashboard.</span>
            </div>
          )}

          {card && (
            <button
              onClick={loadSS}
              disabled={loading}
              className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
            >
              Generate Social Security Doc
            </button>
          )}
        </div>
      )}

      {/* ── Employee: not yet issued ── */}
      {!isHR && notIssued && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-8 text-center space-y-2">
          <p className="text-4xl">🪪</p>
          <p className="font-semibold text-amber-800">Your ID card hasn't been issued yet</p>
          <p className="text-sm text-amber-600">Please contact HR to have your employee ID card generated.</p>
        </div>
      )}

      {/* ── Error (employee view) ── */}
      {!isHR && err && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm text-red-600">{err}</p>
        </div>
      )}

      {/* ── Loading ── */}
      {(loading || issuing) && !card && (
        <div className="flex items-center justify-center py-12 text-gray-400 gap-3">
          <div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full" />
          {issuing ? 'Generating card…' : 'Loading…'}
        </div>
      )}

      {/* ── ID Card ── */}
      {card && (
        <div className="space-y-4">
          <div ref={printRef}>
            <RealIDCard card={card} />
          </div>
          <div className="flex gap-3">
            <button
              onClick={printCard}
              className="px-4 py-2 border border-gray-300 bg-white rounded-lg text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 shadow-sm"
            >
              🖨 Print / Save as PDF
            </button>
            {isHR && (
              <button
                onClick={generateCard}
                disabled={issuing}
                className="px-4 py-2 border border-indigo-300 bg-indigo-50 rounded-lg text-sm text-indigo-700 hover:bg-indigo-100 flex items-center gap-2"
              >
                🔄 Re-issue
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Social Security ── */}
      {ssDoc && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Social Security Enrollment</h2>
            <button
              onClick={() => {
                const blob = new Blob([ssDoc], { type: 'text/plain' })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = `SSF-${card?.employee_code || empId}.txt`
                a.click()
              }}
              className="text-sm text-indigo-600 hover:underline"
            >
              Download
            </button>
          </div>
          <pre className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs font-mono whitespace-pre-wrap text-gray-700 max-h-80 overflow-y-auto">
            {ssDoc}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── Real ID Card Visual ──────────────────────────────────────────────────────
function RealIDCard({ card }: { card: IdCardData }) {
  const [photoErr, setPhotoErr] = useState(false)
  const hasPhoto = !!card.photo_data_url && !photoErr

  const fmtDate = (d?: string) =>
    d ? new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'N/A'
  const fmtIssued = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })

  return (
    <div style={{
      width: 354,
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      borderRadius: 18,
      overflow: 'hidden',
      boxShadow: '0 10px 40px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12)',
      background: 'white',
      userSelect: 'none',
    }}>
      {/* ── Header ── */}
      <div style={{
        background: 'linear-gradient(135deg, #1a3558 0%, #1d4ed8 60%, #1e40af 100%)',
        padding: '14px 18px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ color: '#93c5fd', fontSize: 8, letterSpacing: 2.5, textTransform: 'uppercase', marginBottom: 4, fontWeight: 600 }}>
            Official Employee ID
          </div>
          <div style={{ color: 'white', fontWeight: 800, fontSize: 22, letterSpacing: 0.3, lineHeight: 1 }}>
            ACGF
          </div>
          <div style={{ color: '#bfdbfe', fontSize: 8.5, marginTop: 4, letterSpacing: 0.3 }}>
            Addis Capital Goods Finance Business
          </div>
        </div>
        {/* Logo */}
        <div style={{
          width: 48, height: 48,
          background: 'white',
          borderRadius: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 3,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>
          <img
            src="/logo.jpg"
            alt="ACGF"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: '16px 18px 12px', display: 'flex', gap: 14 }}>
        {/* Photo */}
        <div style={{
          width: 82,
          height: 100,
          borderRadius: 10,
          overflow: 'hidden',
          border: '3px solid #1d4ed8',
          flexShrink: 0,
          background: '#e0e7ff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          {hasPhoto ? (
            <img
              src={card.photo_data_url!}
              alt={card.full_name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={() => setPhotoErr(true)}
            />
          ) : (
            /* Silhouette placeholder */
            <svg viewBox="0 0 82 100" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
              <rect width="82" height="100" fill="#c7d2fe" />
              <circle cx="41" cy="34" r="19" fill="#818cf8" />
              <ellipse cx="41" cy="90" rx="30" ry="24" fill="#818cf8" />
            </svg>
          )}
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#0f172a', lineHeight: 1.2, marginBottom: 3 }}>
            {card.full_name}
          </div>
          <div style={{ fontSize: 11, color: '#1d4ed8', fontWeight: 700, marginBottom: 7 }}>
            {card.job_title}
          </div>
          <div style={{
            display: 'inline-block',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#1e40af',
            fontSize: 9.5,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 4,
            marginBottom: 8,
          }}>
            {card.department}
          </div>
          <div style={{ fontSize: 9, color: '#64748b', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>
            <span>✉</span> {card.email}
          </div>
          {card.phone && (
            <div style={{ fontSize: 9, color: '#64748b', display: 'flex', alignItems: 'center', gap: 3 }}>
              <span>☏</span> {card.phone}
            </div>
          )}
        </div>
      </div>

      {/* ── ID Strip ── */}
      <div style={{
        background: '#f8fafc',
        borderTop: '1.5px solid #e2e8f0',
        borderBottom: '1.5px solid #e2e8f0',
        padding: '10px 18px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 7, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 3, fontWeight: 600 }}>
            Employee ID
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#1e40af', letterSpacing: 1.5 }}>
            {card.employee_code}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 7, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 3, fontWeight: 600 }}>
            Since
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>
            {fmtDate(card.start_date)}
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{
        background: 'linear-gradient(135deg, #1a3558 0%, #1d4ed8 60%, #1e40af 100%)',
        padding: '8px 18px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div style={{ color: '#bfdbfe', fontSize: 8, fontWeight: 500 }}>
          Issued: {fmtIssued(card.issued_at)}
        </div>
        <div style={{ color: '#93c5fd', fontSize: 8, fontWeight: 700, letterSpacing: 0.5 }}>
          OFFICIAL USE ONLY
        </div>
      </div>
    </div>
  )
}
