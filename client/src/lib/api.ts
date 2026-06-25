/**
 * ACGF HR — REST API layer.
 * Same function signatures the app already uses; now backed by the Node/Express API.
 */
import { apiFetch, qs } from './api-client'
export type { AnnualLeaveBalance } from '@/types'
import type {
  Employee, LeaveRequest, JobPosting, Candidate,
  PayrollRecord, PerformanceReview, Goal,
  LeaveStatus, CandidateStage, EmployeeStatus,
} from '@/types'

// ─── Employees ───────────────────────────────────────────────────────────────
export async function fetchEmployees(filters?: {
  department?: string; status?: EmployeeStatus; search?: string
}): Promise<Employee[]> {
  return apiFetch<Employee[]>(`/employees${qs(filters)}`)
}
export async function fetchEmployee(id: string): Promise<Employee | null> {
  return apiFetch<Employee>(`/employees/${id}`)
}
export async function createEmployee(emp: Omit<Employee, 'id' | 'created_at' | 'updated_at'>): Promise<Employee> {
  return apiFetch<Employee>('/employees', { method: 'POST', body: JSON.stringify(emp) })
}
export async function updateEmployee(id: string, updates: Partial<Employee>): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${id}`, { method: 'PATCH', body: JSON.stringify(updates) })
}
export async function deleteEmployee(id: string): Promise<void> {
  await apiFetch(`/employees/${id}`, { method: 'DELETE' })
}

// ─── Dashboard ───────────────────────────────────────────────────────────────
export interface DashboardData {
  total_employees: number
  on_leave: number
  open_positions: number
  pending_leave: number
  approved_leave: number
  denied_leave: number
  attendance_today: { present: number; absent: number; rate: number; date: string }
  presence: { label: string; count: number; pct: number; color: string }[]
  dept_headcount: { department: string; count: number; color: string }[]
  status_breakdown: { status: string; label: string; count: number; color: string }[]
  headcount_trend: { month: string; count: number }[]
  pipeline: { stage: string; count: number }[]
  reviews: { submitted: number; total: number }
  activity_feed: { id: number; text: string; time: string; dept: string; color: string }[]
  upcoming_events: { id: number; title: string; date: string; time: string; detail: string; color: string }[]
}
export async function fetchDashboardStats(): Promise<DashboardData> {
  return apiFetch<DashboardData>('/dashboard')
}

// ─── Leave ───────────────────────────────────────────────────────────────────
export async function fetchLeaveRequests(filters?: { status?: LeaveStatus; employee_id?: string }): Promise<LeaveRequest[]> {
  return apiFetch<LeaveRequest[]>(`/leave${qs(filters)}`)
}
export async function updateLeaveStatus(id: string, status: LeaveStatus, approved_by?: string): Promise<void> {
  await apiFetch(`/leave/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, approved_by }) })
}
export async function createLeaveRequest(req: Omit<LeaveRequest, 'id' | 'created_at'> & { attachment_data?: string; bereavement_relation?: string }): Promise<LeaveRequest> {
  return apiFetch<LeaveRequest>('/leave', { method: 'POST', body: JSON.stringify(req) })
}
export async function fetchAnnualLeaveBalance(employee_id: string): Promise<import('@/types').AnnualLeaveBalance> {
  return apiFetch(`/leave/balance/${employee_id}`)
}
export async function downloadLeaveAttachment(id: string, name: string): Promise<void> {
  const { getToken } = await import('./auth')
  const API_URL = import.meta.env.VITE_API_URL || '/api'
  const token = getToken()
  const res = await fetch(`${API_URL}/leave/${id}/attachment`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('Download failed')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

// ─── Attendance (daily present/absent) ───────────────────────────────────────
export interface AttendanceRecord { id: string; employee_id: string; date: string; status: 'present' | 'absent' }
export async function fetchAttendance(date?: string): Promise<AttendanceRecord[]> {
  return apiFetch<AttendanceRecord[]>(`/attendance${qs({ date })}`)
}
export async function markAttendance(input: { employee_id: string; date: string; status: 'present' | 'absent' }): Promise<AttendanceRecord> {
  return apiFetch<AttendanceRecord>('/attendance', { method: 'POST', body: JSON.stringify(input) })
}

// ─── Recruitment ─────────────────────────────────────────────────────────────
export async function fetchJobPostings(filters?: { status?: string; department?: string }): Promise<JobPosting[]> {
  return apiFetch<JobPosting[]>(`/jobs${qs(filters)}`)
}
export async function createJobPosting(
  job: Omit<JobPosting, 'id' | 'created_at' | 'updated_at' | 'applicant_count' | 'recruiter'>,
): Promise<JobPosting> {
  return apiFetch<JobPosting>('/jobs', { method: 'POST', body: JSON.stringify(job) })
}
export async function fetchCandidates(jobId?: string): Promise<Candidate[]> {
  return apiFetch<Candidate[]>(`/candidates${qs({ job_id: jobId })}`)
}
export async function updateCandidateStage(id: string, stage: CandidateStage): Promise<void> {
  await apiFetch(`/candidates/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage }) })
}
export async function respondToCandidate(id: string, data: { application_status?: string; hr_message?: string }): Promise<{ id: string; application_status?: string; hr_message?: string; stage?: string }> {
  return apiFetch(`/candidates/${id}/respond`, { method: 'PATCH', body: JSON.stringify(data) })
}

// Open roles any authenticated user can browse + apply to (used by the employee Careers page)
export interface OpenJob {
  id: string; title: string; department: string; location: string; employment_type: string
  description: string; requirements: string[]; salary_min: number; salary_max: number
  applicant_count: number; created_at: string; applied: boolean
}
export async function fetchOpenJobs(): Promise<OpenJob[]> { return apiFetch<OpenJob[]>('/jobs/open') }
export async function applyToJob(jobId: string, docs?: {
  cv_data?: string; cv_name?: string; cv_mime?: string;
  cover_letter_data?: string; cover_letter_name?: string; cover_letter_mime?: string;
  edu_cert_data?: string; edu_cert_name?: string; edu_cert_mime?: string;
  exp_doc_data?: string; exp_doc_name?: string; exp_doc_mime?: string;
;
  other_doc_data?: string; other_doc_name?: string; other_doc_mime?: string;
  photo_data?: string; photo_name?: string; photo_mime?: string;
}): Promise<{ applied: boolean; id?: string }> {
  return apiFetch<{ applied: boolean; id?: string }>(`/jobs/${jobId}/apply`, { method: 'POST', body: JSON.stringify(docs || {}) })
}

// ─── Payroll ──────────────────────────────────────────────────────────────────
export async function fetchPayrollRecords(period?: string): Promise<PayrollRecord[]> {
  return apiFetch<PayrollRecord[]>(`/payroll${qs({ period })}`)
}
export async function processPayroll(
  employeeIds: string[],
  period_start: string,
  period_end: string,
  overrides?: Record<string, { bonus?: number; benefits?: number }>,
): Promise<{ processed: number; records: PayrollRecord[] }> {
  return apiFetch('/payroll/process', {
    method: 'POST',
    body: JSON.stringify({ employeeIds, period_start, period_end, overrides: overrides ?? {} }),
  })
}
export async function updatePayrollRecord(id: string, data: { bonus?: number; benefits?: number }): Promise<PayrollRecord> {
  return apiFetch<PayrollRecord>(`/payroll/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
}

// ─── Performance ─────────────────────────────────────────────────────────────
export async function fetchPerformanceReviews(filters?: { period?: string; employee_id?: string }): Promise<PerformanceReview[]> {
  return apiFetch<PerformanceReview[]>(`/performance/reviews${qs(filters)}`)
}
export async function fetchGoals(employee_id?: string): Promise<Goal[]> {
  return apiFetch<Goal[]>(`/performance/goals${qs({ employee_id })}`)
}
export async function createPerformanceReview(r: {
  employee_id: string; period: string; goals_score: number; skills_score: number; culture_score: number; score?: number; comments?: string
}): Promise<PerformanceReview> {
  return apiFetch<PerformanceReview>('/performance/reviews', { method: 'POST', body: JSON.stringify(r) })
}
export async function createGoal(g: {
  employee_id: string; title: string; description?: string; target_date?: string; progress?: number
}): Promise<Goal> {
  return apiFetch<Goal>('/performance/goals', { method: 'POST', body: JSON.stringify(g) })
}
export async function updateGoalProgress(id: string, progress: number): Promise<void> {
  await apiFetch(`/performance/goals/${id}/progress`, { method: 'PATCH', body: JSON.stringify({ progress }) })
}

// ─── Documents ───────────────────────────────────────────────────────────────
export type DocAccessLevel = 'hr_only' | 'all_employees' | 'specific_department'
export interface DocItem {
  id: string; name: string; type: string; owner: string; size: string; updated_at: string
  file_mime?: string; access_level: DocAccessLevel; access_departments?: string | null
}
export async function fetchDocuments(): Promise<DocItem[]> { return apiFetch<DocItem[]>('/documents') }
export async function createDocument(d: {
  name: string; type: string; file_data?: string; file_mime?: string; size?: string
  access_level?: DocAccessLevel; access_departments?: string[]
}): Promise<DocItem> {
  return apiFetch<DocItem>('/documents', { method: 'POST', body: JSON.stringify(d) })
}
export async function updateDocumentAccess(id: string, access_level: DocAccessLevel, access_departments?: string[]): Promise<DocItem> {
  return apiFetch<DocItem>(`/documents/${id}/access`, { method: 'PATCH', body: JSON.stringify({ access_level, access_departments }) })
}
export async function deleteDocument(id: string): Promise<void> { await apiFetch(`/documents/${id}`, { method: 'DELETE' }) }
export async function downloadDocument(id: string, name: string): Promise<void> {
  const { getToken } = await import('./auth')
  const API_URL = import.meta.env.VITE_API_URL || '/api'
  const token = getToken()
  const res = await fetch(`${API_URL}/documents/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('Download failed')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ─── Users (admin) ───────────────────────────────────────────────────────────
export interface UserItem { id: string; name: string; email: string; role: string; employee_id?: string | null }
export async function fetchUsers(): Promise<UserItem[]> { return apiFetch<UserItem[]>('/users') }
export async function createUser(u: { name: string; email: string; password: string; role: string }): Promise<UserItem> {
  return apiFetch<UserItem>('/users', { method: 'POST', body: JSON.stringify(u) })
}
export async function updateUser(id: string, patch: Partial<{ name: string; email: string; role: string; password: string }>): Promise<UserItem> {
  return apiFetch<UserItem>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}
export async function deleteUser(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch<{ id: string; deleted: boolean }>(`/users/${id}`, { method: 'DELETE' })
}

// ─── Experience Letters ───────────────────────────────────────────────────────
import type { ExperienceLetter } from '@/types'

export async function fetchExperienceLetters(): Promise<ExperienceLetter[]> {
  return apiFetch<ExperienceLetter[]>('/experience-letters')
}
export async function requestExperienceLetter(data: {
  employee_id?: string
  purpose?: string
  start_date?: string
  end_date?: string
}): Promise<ExperienceLetter> {
  return apiFetch<ExperienceLetter>('/experience-letters', { method: 'POST', body: JSON.stringify(data) })
}
export async function updateExperienceLetterStatus(
  id: string,
  status: 'approved' | 'rejected',
  rejection_reason?: string,
): Promise<ExperienceLetter> {
  return apiFetch<ExperienceLetter>(`/experience-letters/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, rejection_reason }),
  })
}
export async function deleteExperienceLetter(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch<{ id: string; deleted: boolean }>(`/experience-letters/${id}`, { method: 'DELETE' })
}

// ─── Clearance Requests ───────────────────────────────────────────────────────
export interface ClearanceRequest {
  id: string; employee_id: string; requested_by: string; last_working_date?: string
  reason?: string; status: 'pending'|'approved'|'rejected'; doc_name?: string; doc_mime?: string
  approved_by?: string; approved_at?: string; rejection_reason?: string
  created_at: string; updated_at: string; employee?: import('@/types').Employee
}
export async function fetchClearanceRequests(): Promise<ClearanceRequest[]> { return apiFetch('/clearance') }
export async function createClearanceRequest(data: { employee_id: string; last_working_date?: string; reason?: string; doc_data?: string; doc_name?: string; doc_mime?: string }): Promise<ClearanceRequest> {
  return apiFetch('/clearance', { method: 'POST', body: JSON.stringify(data) })
}
export async function updateClearanceStatus(id: string, status: 'approved'|'rejected', rejection_reason?: string): Promise<{ id: string; status: string }> {
  return apiFetch(`/clearance/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, rejection_reason }) })
}

// ─── Work Guarantee Requests ──────────────────────────────────────────────────
export interface WorkGuaranteeRequest {
  id: string; employee_id: string; guaranteed_person_name: string; guaranteed_company: string
  purpose?: string; status: 'pending'|'approved'|'rejected'; letter_content?: string
  approved_by?: string; approved_at?: string; rejection_reason?: string
  created_at: string; updated_at: string; employee?: import('@/types').Employee
}
export async function fetchWorkGuarantees(): Promise<WorkGuaranteeRequest[]> { return apiFetch('/work-guarantee') }
export async function requestWorkGuarantee(data: { employee_id?: string; guaranteed_person_name: string; guaranteed_company: string; purpose?: string }): Promise<WorkGuaranteeRequest> {
  return apiFetch('/work-guarantee', { method: 'POST', body: JSON.stringify(data) })
}
export async function updateWorkGuaranteeStatus(id: string, status: 'approved'|'rejected', rejection_reason?: string): Promise<{ id: string; status: string; letter_content?: string }> {
  return apiFetch(`/work-guarantee/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, rejection_reason }) })
}

// ─── TOR Trainings ────────────────────────────────────────────────────────────
export interface TorTraining {
  id: string; employee_id?: string | null; department?: string | null; scope: 'employee' | 'department'
  title: string; objective?: string; duration?: string
  venue?: string; trainer?: string; start_date?: string; end_date?: string
  created_by: string; tor_content?: string; created_at: string; updated_at: string
  employee?: import('@/types').Employee
}
export async function fetchTorTrainings(): Promise<TorTraining[]> { return apiFetch('/tor') }
export async function createTorTraining(data: { employee_id?: string; department?: string; scope?: 'employee' | 'department'; title: string; objective?: string; duration?: string; venue?: string; trainer?: string; start_date?: string; end_date?: string }): Promise<TorTraining> {
  return apiFetch('/tor', { method: 'POST', body: JSON.stringify(data) })
}

// ─── Social Security / ID Card ────────────────────────────────────────────────
export async function fetchSocialSecurityDoc(employeeId: string): Promise<{ document: string; full_name: string; employee_code: string }> {
  return apiFetch(`/employees/${employeeId}/social-security`)
}
export interface IdCardData {
  id: string; employee_code: string; full_name: string; job_title: string
  department: string; email: string; phone?: string; start_date?: string
  photo_data_url?: string | null; organization: string; issued_at: string; is_issued?: boolean
}
// View a previously generated ID card (HR can always preview; employees only after HR issues it).
export async function fetchEmployeeIdCard(employeeId: string): Promise<IdCardData> {
  return apiFetch(`/employees/${employeeId}/id-card`)
}
// HR action: formally generate/issue the ID card so it becomes visible on the employee's own dashboard.
export async function issueEmployeeIdCard(employeeId: string): Promise<IdCardData> {
  return apiFetch(`/employees/${employeeId}/id-card/issue`, { method: 'POST' })
}

// ─── Candidate document downloads ─────────────────────────────────────────────
async function downloadFile(url: string, filename: string) {
  const { getToken } = await import('./auth')
  const API_URL = import.meta.env.VITE_API_URL || '/api'
  const token = getToken()
  const res = await fetch(`${API_URL}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error('Download failed')
  const blob = await res.blob()
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename
  document.body.appendChild(link); link.click(); link.remove()
}
export const downloadCandidateCV = (id: string, name: string) => downloadFile(`/candidates/${id}/cv`, name)
export const downloadClearanceDoc = (id: string, name: string) => downloadFile(`/clearance/${id}/doc`, name)
export const downloadClearanceCertificate = (id: string) => downloadFile(`/clearance/${id}/certificate`, `clearance-certificate-${id.slice(0,8)}.txt`)
export const downloadWorkGuaranteeLetter = (id: string) => downloadFile(`/work-guarantee/${id}/letter`, `work-guarantee-letter-${id.slice(0,8)}.txt`)
export const downloadCandidateCoverLetter = (id: string, name: string) => downloadFile(`/candidates/${id}/cover-letter`, name)
export const downloadCandidateEduCert = (id: string, name: string) => downloadFile(`/candidates/${id}/edu-cert`, name)
export const downloadCandidateExpDoc = (id: string, name: string) => downloadFile(`/candidates/${id}/exp-doc`, name)
export const downloadEmployeeEduFile = (id: string, name: string) => downloadFile(`/employees/${id}/edu-file`, name)
export const downloadEmployeeExpFile = (id: string, name: string) => downloadFile(`/employees/${id}/exp-file`, name)

// ─── My Applications (employee view) ─────────────────────────────────────────
export interface MyApplication {
  id: string; job_id: string; first_name: string; last_name: string; email: string
  stage: string; application_status: string; hr_message?: string; created_at: string; updated_at: string
  job?: { id: string; title: string; department: string }
}
export async function fetchMyApplications(): Promise<MyApplication[]> { return apiFetch('/my-applications') }
