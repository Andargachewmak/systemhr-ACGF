import { useState, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Card, CardBody, Badge, Button, Skeleton, EmptyState } from '@/components/ui'
import { fetchOpenJobs, applyToJob, fetchMyApplications, type OpenJob, type MyApplication } from '@/lib/api'
import { formatDate } from '@/lib/utils'

interface FileState { data: string; name: string; mime: string }

const fileToBase64 = (file: File): Promise<FileState> =>
  new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res({ data: (r.result as string).split(',')[1], name: file.name, mime: file.type })
    r.onerror = rej
    r.readAsDataURL(file)
  })

export function CareersPage() {
  const qc = useQueryClient()
  const { data: jobs, isLoading } = useQuery({ queryKey: ['open-jobs'], queryFn: fetchOpenJobs })
  const { data: myApps } = useQuery({ queryKey: ['my-applications'], queryFn: fetchMyApplications })
  const [tab, setTab] = useState<'jobs' | 'applications'>('jobs')
  const [applyJob, setApplyJob] = useState<OpenJob | null>(null)
  const [docs, setDocs] = useState<{ cv?: FileState; cover_letter?: FileState; edu_cert?: FileState; exp_doc?: FileState; other?: FileState }>({})
  const [applicantInfo, setApplicantInfo] = useState({ full_name: '', email: '', phone: '' })
  const cvRef = useRef<HTMLInputElement>(null)
  const clRef = useRef<HTMLInputElement>(null)
  const eduRef = useRef<HTMLInputElement>(null)
  const expRef = useRef<HTMLInputElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)

  const APP_STATUS_LABELS: Record<string, { label: string; color: string }> = {
    under_review: { label: 'Under Review', color: 'bg-gray-100 text-gray-700' },
    shortlisted: { label: 'Shortlisted 🎯', color: 'bg-blue-100 text-blue-700' },
    interview_scheduled: { label: 'Interview Scheduled 📅', color: 'bg-purple-100 text-purple-700' },
    offer_extended: { label: 'Offer Extended 🎉', color: 'bg-amber-100 text-amber-700' },
    hired: { label: 'Hired ✅', color: 'bg-green-100 text-green-700' },
    rejected: { label: 'Not Selected', color: 'bg-red-100 text-red-700' },
  }

  const apply = useMutation({
    mutationFn: (jobId: string) => applyToJob(jobId, {
      ...applicantInfo,
      cv_data: docs.cv?.data, cv_name: docs.cv?.name, cv_mime: docs.cv?.mime,
      cover_letter_data: docs.cover_letter?.data, cover_letter_name: docs.cover_letter?.name, cover_letter_mime: docs.cover_letter?.mime,
      edu_cert_data: docs.edu_cert?.data, edu_cert_name: docs.edu_cert?.name, edu_cert_mime: docs.edu_cert?.mime,
      exp_doc_data: docs.exp_doc?.data, exp_doc_name: docs.exp_doc?.name, exp_doc_mime: docs.exp_doc?.mime,
      other_doc_data: docs.other?.data, other_doc_name: docs.other?.name, other_doc_mime: docs.other?.mime,
    }),
    onSuccess: () => {
      toast.success('Application submitted!')
      qc.invalidateQueries({ queryKey: ['open-jobs'] })
      qc.invalidateQueries({ queryKey: ['my-applications'] })
      setApplyJob(null); setDocs({}); setApplicantInfo({ full_name: '', email: '', phone: '' })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const handleFile = async (key: keyof typeof docs, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const fs = await fileToBase64(file)
    setDocs(p => ({ ...p, [key]: fs }))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-semibold text-white">Careers</h2>
          <p className="text-sm text-slate-500 mt-0.5">{'Open roles and your application status'}</p>
        </div>
        <div className="flex gap-1 bg-surface-2 rounded-xl p-1">
          {(['jobs', 'applications'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-sm rounded-lg font-medium transition-all ${tab === t ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-white'}`}>
              {t === 'jobs' ? 'Open Roles' : `My Applications${myApps?.length ? ` (${myApps.length})` : ''}`}
            </button>
          ))}
        </div>
      </div>

      {tab === 'jobs' && (
        isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}</div>
        ) : (jobs ?? []).length === 0 ? (
          <EmptyState title={'No open roles right now.'} description="Check back later." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(jobs ?? []).map((job) => <JobCard key={job.id} job={job} onApply={() => setApplyJob(job)} />)}
          </div>
        )
      )}

      {tab === 'applications' && (
        (myApps ?? []).length === 0 ? (
          <EmptyState title="No applications yet" description="Apply to an open role to get started." />
        ) : (
          <div className="space-y-3">
            {(myApps ?? []).map(app => {
              const s = APP_STATUS_LABELS[app.application_status] || { label: app.application_status, color: 'bg-gray-100 text-gray-700' }
              return (
                <div key={app.id} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-gray-900">{app.job?.title || 'Position'}</p>
                      <p className="text-sm text-gray-500">{app.job?.department} · Applied {new Date(app.created_at).toLocaleDateString()}</p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${s.color}`}>{s.label}</span>
                  </div>
                  {app.hr_message && (
                    <div className="mt-3 p-3 bg-blue-50 rounded-xl border border-blue-100">
                      <p className="text-xs font-medium text-blue-700 mb-1">{'Message from HR:'}</p>
                      <p className="text-sm text-blue-800">{app.hr_message}</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}

      {/* Apply Modal */}
      {applyJob && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setApplyJob(null)}>
          <div className="bg-white rounded-2xl p-6 max-w-lg w-full shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-bold text-gray-900 text-lg">Apply: {applyJob.title}</h2>
                <p className="text-sm text-gray-500">{applyJob.department}</p>
              </div>
              <button onClick={() => setApplyJob(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            {/* Applicant Info */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{'Your Information'}</p>
              <input value={applicantInfo.full_name} onChange={e => setApplicantInfo(p => ({ ...p, full_name: e.target.value }))}
                placeholder={ 'Full Name' + ' *' } className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
              <input value={applicantInfo.email} onChange={e => setApplicantInfo(p => ({ ...p, email: e.target.value }))}
                placeholder={ 'Email' + ' *' } type="email" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
              <input value={applicantInfo.phone} onChange={e => setApplicantInfo(p => ({ ...p, phone: e.target.value }))}
                placeholder={ 'Phone' } className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>

            {/* Documents */}
            <div className="space-y-3 border-t border-gray-100 pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Documents</p>
              {([
                { key: 'cv' as const, label: 'CV / Resume *', ref: cvRef },
                { key: 'cover_letter' as const, label: 'Cover Letter', ref: clRef },
                { key: 'edu_cert' as const, label: 'Education Certificate', ref: eduRef },
                { key: 'exp_doc' as const, label: 'Experience Document', ref: expRef },
                { key: 'other' as const, label: 'Other Document', ref: otherRef },
              ]).map(({ key, label, ref }) => (
                <div key={key}>
                  <p className="text-xs font-medium text-gray-700 mb-1">{label}</p>
                  <input ref={ref} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={e => handleFile(key, e)}
                    className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer" />
                  {docs[key] && <p className="text-xs text-green-600 mt-0.5">✓ {docs[key]!.name}</p>}
                </div>
              ))}
            </div>

            <div className="flex gap-3 pt-2">
              <button onClick={() => apply.mutate(applyJob.id)} disabled={apply.isPending}
                className="flex-1 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                {apply.isPending ? 'Submitting…' : 'Submit Application'}
              </button>
              <button onClick={() => setApplyJob(null)} className="px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50">{'Cancel'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtRange(min: number, max: number) {
  if (!min && !max) return null
  const f = (n: number) => `$${(n / 1000).toFixed(0)}K`
  if (min && max) return `${f(min)} – ${f(max)}`
  return f(min || max)
}

function JobCard({ job, onApply }: { job: OpenJob; onApply: () => void }) {
  const range = fmtRange(job.salary_min, job.salary_max)
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display font-semibold text-white text-sm">{job.title}</h3>
            <p className="text-xs text-slate-500 mt-0.5">{job.department}{job.location ? ` · ${job.location}` : ''}</p>
          </div>
          <Badge status="open">{job.employment_type.replace('_', ' ')}</Badge>
        </div>
        {job.description && <p className="text-xs text-slate-400 leading-relaxed line-clamp-3">{job.description}</p>}
        {job.requirements?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {job.requirements.slice(0, 5).map((r) => (
              <span key={r} className="text-[11px] px-2 py-0.5 rounded-full bg-surface-2 border border-white/8 text-slate-400">{r}</span>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <div className="text-xs text-slate-500">
            {range && <span className="text-slate-300 font-medium">{range}</span>}
            <span className="block text-slate-600 mt-0.5">Posted {formatDate(job.created_at, 'short')}</span>
          </div>
          {job.applied ? (
            <Badge status="active" className="bg-emerald-500/15 text-emerald-400 border-emerald-500/20">{'✓ Applied'}</Badge>
          ) : (
            <Button variant="primary" size="sm" onClick={onApply}>{'Apply'}</Button>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
