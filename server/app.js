const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const bcrypt = require('bcryptjs')
const { initDb } = require('./src/db')
const { signToken, requireAuth, requireRole } = require('./src/auth')

const HR = ['admin', 'hr_director'] // roles allowed to manage HR data
const DEPT_MGRS = ['admin', 'hr_director', 'department_director'] // can approve leave, attendance, performance in their dept
const LEAVE_TYPES = ['annual', 'sick', 'personal', 'maternity', 'paternity', 'unpaid', 'bereavement', 'wedding']
const LEAVE_STATUSES = ['pending', 'approved', 'denied', 'cancelled']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const normEmail = (e) => String(e || '').trim().toLowerCase()

// Builds and returns the configured Express app. Async because the DB inits async.
// Used by both the local dev server (index.js) and the Vercel serverless entry (api/index.js).
async function createApp() {
  // all/get/run are async (real async on Postgres; trivially awaitable on the sql.js fallback).
  const { all, get, run, uid, now } = await initDb()
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1) // correct client IPs behind Vercel's proxy
  app.use(helmet())
  // Token-based API (no cookies), so reflecting the request origin is safe. Lock it down
  // with CORS_ORIGIN (comma-separated) when you know your front-end origin(s).
  app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }))
  app.use(express.json({ limit: '1mb' }))

  // Wrap async handlers so a rejected promise becomes a clean 500 instead of crashing.
  const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e)
    if (!res.headersSent) res.status(500).json({ message: 'Server error' })
  })

  // Lightweight in-memory fixed-window rate limiter for sensitive endpoints. Note: on
  // serverless this is per-instance and resets on cold starts — a basic guard, not a
  // substitute for a shared store (e.g. Redis) in a high-security deployment.
  const rateLimit = ({ windowMs, max }) => {
    const hits = new Map()
    return (req, res, next) => {
      const key = `${req.ip}:${req.path}`
      const t = Date.now()
      const e = hits.get(key)
      if (!e || t > e.reset) hits.set(key, { count: 1, reset: t + windowMs })
      else if (++e.count > max) {
        return res.status(429).json({ message: 'Too many attempts. Please try again later.' })
      }
      if (hits.size > 5000) for (const [k, v] of hits) if (t > v.reset) hits.delete(k)
      next()
    }
  }
  const authLimiter = rateLimit({ windowMs: 5 * 60_000, max: 20 })

  // ── shaping helpers ────────────────────────────────────────────────
  const shapeEmp = (r) => r && ({ ...r, skills: r.skills ? JSON.parse(r.skills) : [], full_name: `${r.first_name} ${r.last_name}` })
  const stripSalary = (e) => { if (!e) return e; const { salary, ...rest } = e; return rest }
  // Embedded employee objects (on leave/payroll/etc.) never need salary — strip it so an
  // employee can't read a colleague's pay via an approver/record embed.
  const pubEmp = (r) => stripSalary(shapeEmp(r))
  const empMap = async () => { const m = {}; for (const e of await all('SELECT * FROM employees')) m[e.id] = pubEmp(e); return m }
  // Accepts either the internal UUID or the human-readable employee_code (e.g. ACGF-20260612-1234)
  // and resolves it to the canonical employee row, or null if no match. Use this everywhere a
  // person might paste/type an employee identifier (route params or request body fields).
  const resolveEmployee = async (idOrCode) => {
    if (!idOrCode) return null
    return await get('SELECT * FROM employees WHERE id=? OR employee_code=?', [idOrCode, idOrCode])
  }
  const resolveEmployeeId = async (idOrCode) => {
    const e = await resolveEmployee(idOrCode)
    return e ? e.id : null
  }

  // ── health ─────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: now() }))

  // ── auth ───────────────────────────────────────────────────────────
  app.post('/api/auth/login', authLimiter, h(async (req, res) => {
    const email = normEmail((req.body || {}).email)
    const { password } = req.body || {}
    const u = await get('SELECT * FROM users WHERE email = ?', [email])
    if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
      return res.status(401).json({ message: 'Invalid email or password' })
    }
    const user = { id: u.id, name: u.name, email: u.email, role: u.role, employee_id: u.employee_id }
    res.json({ token: signToken(user), user })
  }))
  app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user))
  app.post('/api/auth/register', authLimiter, h(async (req, res) => {
    const name = String((req.body || {}).name || '').trim()
    const email = normEmail((req.body || {}).email)
    const { password } = req.body || {}
    if (!name || !email || !password) return res.status(400).json({ message: 'All fields are required' })
    if (name.length > 100) return res.status(400).json({ message: 'Name is too long' })
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email address' })
    if (String(password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' })
    if (await get('SELECT id FROM users WHERE email = ?', [email])) return res.status(409).json({ message: 'An account with this email already exists' })
    // Public sign-up is always Employee. HR Directors & Admins are created by an admin.
    const role = 'employee'
    const id = uid()
    // If HR has already added an employee with this email, link the login to that record so
    // the person gets the full employee experience (own payroll, performance, etc.).
    // Otherwise they sign up as an applicant: no employee record, and they can only browse
    // and apply to open roles until HR adds them as an employee.
    const emp = await get('SELECT id FROM employees WHERE email = ?', [email])
    const employee_id = emp ? emp.id : null
    await run('INSERT INTO users (id,name,email,password_hash,role,employee_id) VALUES (?,?,?,?,?,?)',
      [id, name, email, bcrypt.hashSync(password, 10), role, employee_id])
    const user = { id, name, email, role, employee_id }
    res.status(201).json({ token: signToken(user), user })
  }))

  // ── users (admin only) ─────────────────────────────────────────────
  app.get('/api/users', requireAuth, requireRole('admin'), h(async (_req, res) => {
    res.json(await all('SELECT id,name,email,role,employee_id FROM users'))
  }))
  app.post('/api/users', requireAuth, requireRole('admin'), h(async (req, res) => {
    const name = String((req.body || {}).name || '').trim()
    const email = normEmail((req.body || {}).email)
    const { password, role, employee_id } = req.body || {}
    if (!name || !email || !password || !role) return res.status(400).json({ message: 'Missing fields' })
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email address' })
    if (String(password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' })
    if (!['admin', 'hr_director', 'employee'].includes(role)) return res.status(400).json({ message: 'Invalid role' })
    if (await get('SELECT id FROM users WHERE email=?', [email])) return res.status(409).json({ message: 'Email already exists' })
    const id = uid()
    await run('INSERT INTO users (id,name,email,password_hash,role,employee_id) VALUES (?,?,?,?,?,?)',
      [id, name, email, bcrypt.hashSync(password, 10), role, employee_id || null])
    res.status(201).json({ id, name, email, role, employee_id: employee_id || null })
  }))
  app.patch('/api/users/:id', requireAuth, requireRole('admin'), h(async (req, res) => {
    const existing = await get('SELECT * FROM users WHERE id=?', [req.params.id])
    if (!existing) return res.status(404).json({ message: 'User not found' })
    const b = req.body || {}
    const name = b.name !== undefined ? String(b.name).trim() : existing.name
    const email = b.email !== undefined ? normEmail(b.email) : existing.email
    const role = b.role !== undefined ? b.role : existing.role
    if (!name) return res.status(400).json({ message: 'Name is required' })
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email address' })
    if (!['admin', 'hr_director', 'employee'].includes(role)) return res.status(400).json({ message: 'Invalid role' })
    if (await get('SELECT id FROM users WHERE email=? AND id<>?', [email, req.params.id])) {
      return res.status(409).json({ message: 'Email already exists' })
    }
    // Don't allow demoting the last remaining admin (avoids lockout).
    if (existing.role === 'admin' && role !== 'admin') {
      const admins = await get("SELECT COUNT(*) AS c FROM users WHERE role='admin'")
      if (Number(admins.c) <= 1) return res.status(400).json({ message: 'Cannot change the role of the last admin' })
    }
    const employee_id = b.employee_id !== undefined ? (b.employee_id ? await resolveEmployeeId(b.employee_id) : null) : existing.employee_id
    let password_hash = existing.password_hash
    if (b.password) {
      if (String(b.password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' })
      password_hash = bcrypt.hashSync(b.password, 10)
    }
    await run('UPDATE users SET name=?,email=?,role=?,employee_id=?,password_hash=? WHERE id=?',
      [name, email, role, employee_id, password_hash, req.params.id])
    res.json({ id: req.params.id, name, email, role, employee_id })
  }))
  app.delete('/api/users/:id', requireAuth, requireRole('admin'), h(async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ message: 'You cannot delete your own account' })
    const existing = await get('SELECT * FROM users WHERE id=?', [req.params.id])
    if (!existing) return res.status(404).json({ message: 'User not found' })
    if (existing.role === 'admin') {
      const admins = await get("SELECT COUNT(*) AS c FROM users WHERE role='admin'")
      if (Number(admins.c) <= 1) return res.status(400).json({ message: 'Cannot delete the last admin' })
    }
    await run('DELETE FROM users WHERE id=?', [req.params.id])
    res.json({ id: req.params.id, deleted: true })
  }))

  // ── employees ──────────────────────────────────────────────────────
  app.get('/api/employees', requireAuth, h(async (req, res) => {
    // Employees can only see their own record — no directory enumeration.
    if (req.user.role === 'employee') {
      if (!req.user.employee_id) return res.json([])
      const self = await get('SELECT * FROM employees WHERE id=?', [req.user.employee_id])
      return res.json(self ? [shapeEmp(self)] : [])
    }
    let rows = await all('SELECT * FROM employees ORDER BY first_name')
    const { search, department, status } = req.query
    if (department) rows = rows.filter((e) => e.department === department)
    if (status) rows = rows.filter((e) => e.status === status)
    if (search) {
      const q = String(search).toLowerCase()
      rows = rows.filter((e) => `${e.first_name} ${e.last_name} ${e.email} ${e.job_title}`.toLowerCase().includes(q))
    }
    res.json(rows.map(shapeEmp))
  }))
  app.get('/api/employees/:id', requireAuth, h(async (req, res) => {
    const e = await get('SELECT * FROM employees WHERE id=? OR employee_code=?', [req.params.id, req.params.id])
    if (!e) return res.status(404).json({ message: 'Not found' })
    // An employee may only fetch their own profile.
    if (req.user.role === 'employee' && e.id !== req.user.employee_id) {
      return res.status(403).json({ message: 'You do not have permission to perform this action' })
    }
    res.json(shapeEmp(e))
  }))
  app.post('/api/employees', requireAuth, requireRole(...HR), h(async (req, res) => {
    const b = req.body || {}
    const email = normEmail(b.email)
    if (!b.first_name || !b.last_name || !email || !b.department || !b.job_title) {
      return res.status(400).json({ message: 'first_name, last_name, email, department and job_title are required' })
    }
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email address' })
    const t = now()
    // Auto-generate unique employee code: ACGF-YYYYMMDD-XXXX
    const genCode = async () => {
      const dp = new Date().toISOString().slice(0,10).replace(/-/g,'')
      const rand = Math.floor(1000+Math.random()*9000)
      const code = `ACGF-${dp}-${rand}`
      return (await get('SELECT id FROM employees WHERE employee_code=?',[code])) ? genCode() : code
    }
    const employee_code = await genCode()
    const existing = await get('SELECT * FROM employees WHERE email=?', [email])
    if (existing) {
      const prevSkills = existing.skills ? (() => { try { return JSON.parse(existing.skills) } catch { return [] } })() : []
      const ec = existing.employee_code || employee_code
      await run(
        `UPDATE employees SET first_name=?,last_name=?,phone=?,avatar_url=?,department=?,job_title=?,employment_type=?,status=?,location=?,start_date=?,salary=?,manager_id=?,bio=?,skills=?,updated_at=?,employee_code=?,edu_file_data=?,edu_file_name=?,edu_file_mime=?,exp_file_data=?,exp_file_name=?,exp_file_mime=?,cv_file_data=?,cv_file_name=?,cv_file_mime=?,other_file_data=?,other_file_name=?,other_file_mime=?,photo_data=?,photo_name=?,photo_mime=? WHERE id=?`,
        [b.first_name, b.last_name, b.phone??existing.phone??null, b.avatar_url??existing.avatar_url??null,
         b.department, b.job_title, b.employment_type||existing.employment_type||'full_time',
         b.status||(existing.status==='onboarding'?'active':existing.status)||'active',
         b.location??existing.location??'', b.start_date||existing.start_date||t.slice(0,10),
         Number(b.salary)||existing.salary||0, b.manager_id??existing.manager_id??null,
         b.bio??existing.bio??null, JSON.stringify(b.skills||prevSkills), t, ec,
         b.edu_file_data||existing.edu_file_data||null, b.edu_file_name||existing.edu_file_name||null, b.edu_file_mime||existing.edu_file_mime||null,
         b.exp_file_data||existing.exp_file_data||null, b.exp_file_name||existing.exp_file_name||null, b.exp_file_mime||existing.exp_file_mime||null,
         b.cv_file_data||existing.cv_file_data||null, b.cv_file_name||existing.cv_file_name||null, b.cv_file_mime||existing.cv_file_mime||null,
         b.other_file_data||existing.other_file_data||null, b.other_file_name||existing.other_file_name||null, b.other_file_mime||existing.other_file_mime||null,
         b.photo_data||existing.photo_data||null, b.photo_name||existing.photo_name||null, b.photo_mime||existing.photo_mime||null,
         existing.id])
      await run('UPDATE users SET employee_id=? WHERE email=? AND (employee_id IS NULL OR employee_id<>?)', [existing.id, email, existing.id])
      return res.status(200).json(shapeEmp(await get('SELECT * FROM employees WHERE id=?', [existing.id])))
    }
    const id = uid()
    await run(`INSERT INTO employees (id,created_at,updated_at,first_name,last_name,email,phone,avatar_url,department,job_title,employment_type,status,location,start_date,salary,manager_id,bio,skills,employee_code,edu_file_data,edu_file_name,edu_file_mime,exp_file_data,exp_file_name,exp_file_mime,cv_file_data,cv_file_name,cv_file_mime,other_file_data,other_file_name,other_file_mime,photo_data,photo_name,photo_mime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,t,t,b.first_name,b.last_name,email,b.phone||null,b.avatar_url||null,b.department,b.job_title,
       b.employment_type||'full_time',b.status||'active',b.location||'',b.start_date||t.slice(0,10),
       Number(b.salary)||0,b.manager_id||null,b.bio||null,JSON.stringify(b.skills||[]),employee_code,
       b.edu_file_data||null,b.edu_file_name||null,b.edu_file_mime||null,
       b.exp_file_data||null,b.exp_file_name||null,b.exp_file_mime||null,
       b.cv_file_data||null,b.cv_file_name||null,b.cv_file_mime||null,
       b.other_file_data||null,b.other_file_name||null,b.other_file_mime||null,
       b.photo_data||null,b.photo_name||null,b.photo_mime||null])
    await run('UPDATE users SET employee_id=? WHERE email=? AND employee_id IS NULL', [id, email])
    res.status(201).json(shapeEmp(await get('SELECT * FROM employees WHERE id=?', [id])))
  }))
  app.patch('/api/employees/:id', requireAuth, requireRole(...HR), h(async (req, res) => {
    const e = await get('SELECT * FROM employees WHERE id=? OR employee_code=?', [req.params.id, req.params.id])
    if (!e) return res.status(404).json({ message: 'Not found' })
    const b = req.body || {}
    if ('email' in b) { b.email = normEmail(b.email); if (!EMAIL_RE.test(b.email)) return res.status(400).json({ message: 'Please enter a valid email address' }) }
    const fields = ['first_name', 'last_name', 'email', 'phone', 'avatar_url', 'department', 'job_title', 'employment_type', 'status', 'location', 'start_date', 'salary', 'manager_id', 'bio']
    const sets = [], vals = []
    for (const f of fields) if (f in b) { sets.push(`${f}=?`); vals.push(b[f]) }
    if ('skills' in b) { sets.push('skills=?'); vals.push(JSON.stringify(b.skills || [])) }
    sets.push('updated_at=?'); vals.push(now())
    vals.push(e.id)
    await run(`UPDATE employees SET ${sets.join(',')} WHERE id=?`, vals)
    res.json(shapeEmp(await get('SELECT * FROM employees WHERE id=?', [e.id])))
  }))
  app.delete('/api/employees/:id', requireAuth, requireRole(...HR), h(async (req, res) => {
    const e = await get('SELECT id FROM employees WHERE id=? OR employee_code=?', [req.params.id, req.params.id])
    if (!e) return res.status(404).json({ message: 'Not found' })
    await run('DELETE FROM employees WHERE id=?', [e.id])
    res.json({ id: e.id, deleted: true })
  }))

  // ── leave ──────────────────────────────────────────────────────────

  // Annual leave entitlement rules:
  //   Year 1  (0–1 yr service)  → 14 days
  //   Year 2  (1–2 yr service)  → 15 days
  //   Year 3  (2–3 yr service)  → 16 days
  //   After 3 years             → annual leave expires (0 days allocated)
  const calcAnnualAllocation = (start_date) => {
    if (!start_date) return { allocated: 0, year_cycle: 0, expired: true }
    const start = new Date(start_date)
    const today = new Date()
    const diffMs = today - start
    const yearsOfService = diffMs / (1000 * 60 * 60 * 24 * 365.25)
    if (yearsOfService >= 3) return { allocated: 0, year_cycle: Math.ceil(yearsOfService), expired: true }
    if (yearsOfService >= 2) return { allocated: 16, year_cycle: 3, expired: false }
    if (yearsOfService >= 1) return { allocated: 15, year_cycle: 2, expired: false }
    return { allocated: 14, year_cycle: 1, expired: false }
  }

  // Ensure balance record exists and is up-to-date for an employee
  const ensureBalance = async (employee_id) => {
    const emp = await get('SELECT start_date FROM employees WHERE id=?', [employee_id])
    if (!emp) return null
    const { allocated, year_cycle, expired } = calcAnnualAllocation(emp.start_date)
    const existing = await get('SELECT * FROM annual_leave_balances WHERE employee_id=?', [employee_id])
    const ts = now()

    if (!existing) {
      const id = uid()
      await run(
        'INSERT INTO annual_leave_balances (id,employee_id,allocated,used,year_cycle,calculated_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [id, employee_id, allocated, 0, year_cycle, ts, ts]
      )
      return await get('SELECT * FROM annual_leave_balances WHERE employee_id=?', [employee_id])
    }

    // If year cycle changed (employee anniversary), reset used and update allocation
    if (existing.year_cycle !== year_cycle) {
      await run(
        'UPDATE annual_leave_balances SET allocated=?,used=0,year_cycle=?,calculated_at=?,updated_at=? WHERE employee_id=?',
        [allocated, year_cycle, ts, ts, employee_id]
      )
    } else {
      // Just refresh allocation in case rules changed
      await run(
        'UPDATE annual_leave_balances SET allocated=?,updated_at=? WHERE employee_id=?',
        [allocated, ts, employee_id]
      )
    }
    return await get('SELECT * FROM annual_leave_balances WHERE employee_id=?', [employee_id])
  }

  // GET /api/leave
  app.get('/api/leave', requireAuth, h(async (req, res) => {
    const em = await empMap()
    // Exclude attachment_data from list for performance
    let rows = await all('SELECT id,employee_id,leave_type,start_date,end_date,days,reason,status,approved_by,created_at,attachment_name,attachment_mime,bereavement_relation FROM leave_requests ORDER BY created_at DESC')
    if (req.user.role === 'employee') rows = rows.filter((r) => r.employee_id === req.user.employee_id)
    else {
      if (req.query.status) rows = rows.filter((r) => r.status === req.query.status)
      if (req.query.employee_id) rows = rows.filter((r) => r.employee_id === req.query.employee_id || (em[r.employee_id] && em[r.employee_id].employee_code === req.query.employee_id))
    }
    res.json(rows.map((r) => ({ ...r, employee: em[r.employee_id], approver: r.approved_by ? em[r.approved_by] : undefined })))
  }))

  // GET /api/leave/balance/:employee_id
  app.get('/api/leave/balance/:employee_id', requireAuth, h(async (req, res) => {
    const resolved = await resolveEmployeeId(req.params.employee_id)
    if (!resolved) return res.status(404).json({ message: 'Employee not found' })
    const eid = resolved
    // Employees can only see own balance
    if (req.user.role === 'employee' && req.user.employee_id !== eid) return res.status(403).json({ message: 'Forbidden' })
    const balance = await ensureBalance(eid)
    if (!balance) return res.status(404).json({ message: 'Employee not found' })
    const emp = await get('SELECT start_date FROM employees WHERE id=?', [eid])
    const { expired } = calcAnnualAllocation(emp?.start_date)
    res.json({ ...balance, remaining: Math.max(0, balance.allocated - balance.used), expired })
  }))

  // GET /api/leave/:id/attachment — download attachment
  app.get('/api/leave/:id/attachment', requireAuth, h(async (req, res) => {
    const row = await get('SELECT employee_id, attachment_data, attachment_name, attachment_mime FROM leave_requests WHERE id=?', [req.params.id])
    if (!row) return res.status(404).json({ message: 'Not found' })
    if (req.user.role === 'employee' && req.user.employee_id !== row.employee_id) return res.status(403).json({ message: 'Forbidden' })
    if (!row.attachment_data) return res.status(404).json({ message: 'No attachment' })
    const buf = Buffer.from(row.attachment_data, 'base64')
    res.setHeader('Content-Type', row.attachment_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.attachment_name || 'attachment')}"`)
    res.send(buf)
  }))

  // POST /api/leave
  app.post('/api/leave', requireAuth, h(async (req, res) => {
    const b = req.body || {}
    const employee_id = req.user.role === 'employee' ? req.user.employee_id : await resolveEmployeeId(b.employee_id)
    if (!employee_id) return res.status(400).json({ message: 'employee_id required' })
    if (!LEAVE_TYPES.includes(b.leave_type)) return res.status(400).json({ message: 'Invalid leave type' })
    const start = new Date(b.start_date), end = new Date(b.end_date)
    if (!b.start_date || !b.end_date || isNaN(start) || isNaN(end)) return res.status(400).json({ message: 'Valid start and end dates are required' })
    if (end < start) return res.status(400).json({ message: 'End date must be on or after the start date' })
    const days = Math.max(1, Math.floor(Number(b.days) || 0))

    // Bereavement: validate relation and enforce day limits
    if (b.leave_type === 'bereavement') {
      const rel = b.bereavement_relation
      if (!rel) return res.status(400).json({ message: 'bereavement_relation is required (parent|sibling|grandparent)' })
      const maxDays = rel === 'parent' ? 7 : rel === 'sibling' ? 5 : rel === 'grandparent' ? 3 : null
      if (!maxDays) return res.status(400).json({ message: 'bereavement_relation must be parent, sibling, or grandparent' })
      if (days > maxDays) return res.status(400).json({ message: `Bereavement leave for ${rel} is capped at ${maxDays} day(s)` })
    }

    // Wedding: 7 days max
    if (b.leave_type === 'wedding' && days > 7) return res.status(400).json({ message: 'Wedding leave is capped at 7 days' })

    // Maternity: 120 days max (~4 months)
    if (b.leave_type === 'maternity' && days > 120) return res.status(400).json({ message: 'Maternity leave is capped at 120 days (4 months)' })

    // Paternity: 5 days max
    if (b.leave_type === 'paternity' && days > 5) return res.status(400).json({ message: 'Paternity leave is capped at 5 days' })

    // For Annual leave: check balance and expiry
    if (b.leave_type === 'annual') {
      const balance = await ensureBalance(employee_id)
      if (!balance) return res.status(400).json({ message: 'No balance record found for employee' })
      const emp2 = await get('SELECT start_date FROM employees WHERE id=?', [employee_id])
      const { expired } = calcAnnualAllocation(emp2?.start_date)
      if (expired) return res.status(400).json({ message: 'Annual leave entitlement has expired after 3 years of service' })
      const remaining = Math.max(0, balance.allocated - balance.used)
      if (days > remaining) return res.status(400).json({ message: `Insufficient annual leave balance. Remaining: ${remaining} day(s), requested: ${days}` })
    }

    const id = uid()
    await run(
      'INSERT INTO leave_requests (id,employee_id,leave_type,start_date,end_date,days,reason,status,approved_by,created_at,attachment_data,attachment_name,attachment_mime,bereavement_relation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, employee_id, b.leave_type, b.start_date, b.end_date, days, b.reason || null, 'pending', null, now(),
       b.attachment_data || null, b.attachment_name || null, b.attachment_mime || null, b.bereavement_relation || null]
    )
    const row = await get('SELECT id,employee_id,leave_type,start_date,end_date,days,reason,status,approved_by,created_at,attachment_name,attachment_mime,bereavement_relation FROM leave_requests WHERE id=?', [id])
    res.status(201).json(row)
  }))

  // PATCH /api/leave/:id/status — HR or dept director (for their dept only)
  app.patch('/api/leave/:id/status', requireAuth, h(async (req, res) => {
    const caller = req.user
    if (!DEPT_MGRS.includes(caller.role)) return res.status(403).json({ message: 'Forbidden' })
    if (!LEAVE_STATUSES.includes(req.body.status)) return res.status(400).json({ message: 'Invalid status' })
    const leave = await get('SELECT * FROM leave_requests WHERE id=?', [req.params.id])
    if (!leave) return res.status(404).json({ message: 'Leave request not found' })

    // Department director: can only approve leave for employees in their own dept
    if (caller.role === 'department_director') {
      const directorEmp = caller.employee_id ? await get('SELECT department FROM employees WHERE id=?', [caller.employee_id]) : null
      if (!directorEmp) return res.status(403).json({ message: 'Department director not linked to an employee record' })
      const leaveEmp = await get('SELECT department FROM employees WHERE id=?', [leave.employee_id])
      if (!leaveEmp || leaveEmp.department !== directorEmp.department) {
        return res.status(403).json({ message: 'You can only approve leave for employees in your department' })
      }
    }

    const prevStatus = leave.status
    const newStatus  = req.body.status

    await run('UPDATE leave_requests SET status=?, approved_by=? WHERE id=?',
      [newStatus, req.body.approved_by || req.user.employee_id || null, req.params.id])

    // Adjust annual leave balance
    if (leave.leave_type === 'annual') {
      const balance = await get('SELECT * FROM annual_leave_balances WHERE employee_id=?', [leave.employee_id])
      if (balance) {
        const ts = now()
        if (newStatus === 'approved' && prevStatus !== 'approved') {
          // Deduct days used
          await run('UPDATE annual_leave_balances SET used=used+?,updated_at=? WHERE employee_id=?', [leave.days, ts, leave.employee_id])
        } else if (prevStatus === 'approved' && newStatus !== 'approved') {
          // Restore days (reversal)
          await run('UPDATE annual_leave_balances SET used=MAX(0,used-?),updated_at=? WHERE employee_id=?', [leave.days, ts, leave.employee_id])
        }
      }
    }

    res.json({ id: req.params.id, status: newStatus })
  }))

  // ── attendance (daily present/absent) ──────────────────────────────
  app.get('/api/attendance', requireAuth, h(async (req, res) => {
    const date = req.query.date
    let rows = date ? await all('SELECT * FROM attendance WHERE date=?', [date]) : await all('SELECT * FROM attendance')
    if (req.user.role === 'employee') rows = rows.filter((r) => r.employee_id === req.user.employee_id)
    res.json(rows.map((r) => ({ id: r.id, employee_id: r.employee_id, date: r.date, status: r.status })))
  }))
  app.post('/api/attendance', requireAuth, h(async (req, res) => {
    const caller = req.user
    if (!DEPT_MGRS.includes(caller.role)) return res.status(403).json({ message: 'Forbidden' })
    const { date, status } = req.body || {}
    const employee_id = await resolveEmployeeId(req.body?.employee_id)
    if (!employee_id || !date || !['present', 'absent'].includes(status)) {
      return res.status(400).json({ message: 'employee_id, date and status (present|absent) are required' })
    }
    // Dept directors can only mark attendance for employees in their dept
    if (caller.role === 'department_director') {
      const dirEmp = caller.employee_id ? await get('SELECT department FROM employees WHERE id=?', [caller.employee_id]) : null
      const targEmp = await get('SELECT department FROM employees WHERE id=?', [employee_id])
      if (!dirEmp || !targEmp || targEmp.department !== dirEmp.department) {
        return res.status(403).json({ message: 'You can only mark attendance for employees in your department' })
      }
    }
    const existing = await get('SELECT id FROM attendance WHERE employee_id=? AND date=?', [employee_id, date])
    if (existing) await run('UPDATE attendance SET status=? WHERE id=?', [status, existing.id])
    else await run('INSERT INTO attendance (id,employee_id,date,status,created_at) VALUES (?,?,?,?,?)', [uid(), employee_id, date, status, now()])
    res.json({ employee_id, date, status })
  }))

  // ── recruitment (HR only) ──────────────────────────────────────────
  app.get('/api/jobs', requireAuth, requireRole(...HR), h(async (req, res) => {
    let rows = await all('SELECT * FROM job_postings ORDER BY created_at DESC')
    if (req.query.status) rows = rows.filter((j) => j.status === req.query.status)
    if (req.query.department) rows = rows.filter((j) => j.department === req.query.department)
    res.json(rows.map((j) => ({ ...j, requirements: j.requirements ? JSON.parse(j.requirements) : [] })))
  }))
  app.post('/api/jobs', requireAuth, requireRole(...HR), h(async (req, res) => {
    const b = req.body || {}; const id = uid(); const t = now()
    await run('INSERT INTO job_postings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, b.title, b.department, b.location || '', b.employment_type || 'full_time', b.description || '',
       JSON.stringify(b.requirements || []), Number(b.salary_min) || 0, Number(b.salary_max) || 0, b.status || 'open', 0, t, t, null])
    const j = await get('SELECT * FROM job_postings WHERE id=?', [id])
    res.status(201).json({ ...j, requirements: JSON.parse(j.requirements) })
  }))

  // Open roles visible to any authenticated user (employees can browse + apply).
  app.get('/api/jobs/open', requireAuth, h(async (req, res) => {
    const rows = await all("SELECT * FROM job_postings WHERE status='open' ORDER BY created_at DESC")
    // Tell the caller which roles they have already applied to (matched by their email).
    let appliedIds = []
    const email = req.user.email
    if (email) {
      const mine = await all('SELECT job_id FROM candidates WHERE email=?', [email])
      appliedIds = mine.map((c) => c.job_id)
    }
    res.json(rows.map((j) => ({
      id: j.id, title: j.title, department: j.department, location: j.location,
      employment_type: j.employment_type, description: j.description,
      requirements: j.requirements ? JSON.parse(j.requirements) : [],
      salary_min: j.salary_min, salary_max: j.salary_max,
      applicant_count: j.applicant_count, created_at: j.created_at,
      applied: appliedIds.includes(j.id),
    })))
  }))

  // Apply to a posted job with required documents.
  app.post('/api/jobs/:id/apply', requireAuth, h(async (req, res) => {
    const job = await get("SELECT * FROM job_postings WHERE id=?", [req.params.id])
    if (!job || job.status !== 'open') return res.status(404).json({ message: 'This role is no longer open' })
    const b = req.body || {}
    // Allow applicant to provide name/email/phone in body; fall back to account info
    const email = normEmail(b.email || req.user.email || '')
    if (!email) return res.status(400).json({ message: 'Email is required' })
    if (await get('SELECT id FROM candidates WHERE job_id=? AND email=?', [req.params.id, email])) {
      return res.status(409).json({ message: 'You have already applied to this role' })
    }
    const nameParts = String(b.full_name || req.user.name || '').split(/\s+/).filter(Boolean)
    const first = b.first_name || nameParts[0] || 'Applicant'
    const last = b.last_name || nameParts.slice(1).join(' ') || ''
    const t = now()
    const id = uid()
    await run(
      'INSERT INTO candidates (id,job_id,first_name,last_name,email,phone,stage,application_status,score,notes,created_at,updated_at,cv_data,cv_name,cv_mime,cover_letter_data,cover_letter_name,cover_letter_mime,edu_cert_data,edu_cert_name,edu_cert_mime,exp_doc_data,exp_doc_name,exp_doc_mime,other_doc_data,other_doc_name,other_doc_mime,photo_data,photo_name,photo_mime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, req.params.id, first, last, email, b.phone || null, 'applied', 'under_review', null, null, t, t,
       b.cv_data || null, b.cv_name || null, b.cv_mime || null,
       b.cover_letter_data || null, b.cover_letter_name || null, b.cover_letter_mime || null,
       b.edu_cert_data || null, b.edu_cert_name || null, b.edu_cert_mime || null,
       b.exp_doc_data || null, b.exp_doc_name || null, b.exp_doc_mime || null,
       b.other_doc_data || null, b.other_doc_name || null, b.other_doc_mime || null,
       b.photo_data || null, b.photo_name || null, b.photo_mime || null]
    )
    await run('UPDATE job_postings SET applicant_count = applicant_count + 1, updated_at=? WHERE id=?', [t, req.params.id])
    res.status(201).json({ applied: true, id })
  }))

  app.get('/api/candidates', requireAuth, requireRole(...HR), h(async (req, res) => {
    let rows = await all('SELECT * FROM candidates ORDER BY created_at DESC')
    if (req.query.job_id) rows = rows.filter((c) => c.job_id === req.query.job_id)
    // strip binary data from list view
    res.json(rows.map(r => ({ ...r, cv_data: undefined, cover_letter_data: undefined, edu_cert_data: undefined, exp_doc_data: undefined, other_doc_data: undefined, photo_data: undefined })))
  }))

  // HR sends application status + message to applicant
  app.patch('/api/candidates/:id/respond', requireAuth, requireRole(...HR), h(async (req, res) => {
    const { application_status, hr_message, stage } = req.body || {}
    const valid = ['under_review', 'shortlisted', 'interview_scheduled', 'offer_extended', 'hired', 'rejected']
    if (application_status && !valid.includes(application_status)) return res.status(400).json({ message: 'Invalid application_status' })
    const sets = [], vals = []
    if (application_status) { sets.push('application_status=?'); vals.push(application_status) }
    if (hr_message !== undefined) { sets.push('hr_message=?'); vals.push(hr_message) }
    if (stage) { sets.push('stage=?'); vals.push(stage) }
    sets.push('updated_at=?'); vals.push(now())
    vals.push(req.params.id)
    await run(`UPDATE candidates SET ${sets.join(',')} WHERE id=?`, vals)
    res.json({ id: req.params.id, application_status, hr_message, stage })
  }))
  app.patch('/api/candidates/:id/stage', requireAuth, requireRole(...HR), h(async (req, res) => {
    await run('UPDATE candidates SET stage=?, updated_at=? WHERE id=?', [req.body.stage, now(), req.params.id])
    res.json({ id: req.params.id, stage: req.body.stage })
  }))

  // ── payroll ────────────────────────────────────────────────────────
  const TAX_RATE = 0.35

  const calcPayroll = (base_salary, bonus = 0, benefits = 0) => {
    const gross_pay = base_salary + bonus + benefits
    const deductions = Math.round(gross_pay * TAX_RATE)   // 35% tax on gross
    const net_pay = gross_pay - deductions
    return { gross_pay, deductions, net_pay }
  }

  app.get('/api/payroll', requireAuth, h(async (req, res) => {
    const em = await empMap()
    let rows = await all('SELECT * FROM payroll_records ORDER BY created_at DESC')
    if (req.user.role === 'employee') rows = rows.filter((r) => r.employee_id === req.user.employee_id)
    res.json(rows.map((r) => ({ ...r, employee: em[r.employee_id] })))
  }))

  // Process payroll — accepts per-employee bonus and benefits overrides
  app.post('/api/payroll/process', requireAuth, requireRole(...HR), h(async (req, res) => {
    const { employeeIds = [], period_start, period_end, overrides = {} } = req.body || {}
    const t = now()
    const results = []
    for (const eid of employeeIds) {
      const e = await get('SELECT id,salary FROM employees WHERE id=? OR employee_code=?', [eid, eid]); if (!e) continue
      const base_salary = Math.round((Number(e.salary) || 0) / 12)
      const bonus    = Number(overrides[eid]?.bonus    ?? 0) || 0
      const benefits = Number(overrides[eid]?.benefits ?? 0) || 0
      const { gross_pay, deductions, net_pay } = calcPayroll(base_salary, bonus, benefits)
      const id = uid()
      await run(
        'INSERT INTO payroll_records (id,employee_id,period_start,period_end,base_salary,bonus,benefits,gross_pay,deductions,net_pay,status,processed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, e.id, period_start, period_end, base_salary, bonus, benefits, gross_pay, deductions, net_pay, 'processed', t, t]
      )
      results.push(id)
    }
    const em = await empMap()
    const rows = await Promise.all(results.map(id => get('SELECT * FROM payroll_records WHERE id=?', [id])))
    res.json({ processed: results.length, records: rows.map(r => ({ ...r, employee: em[r.employee_id] })) })
  }))

  // Update bonus/benefits on an existing record (HR only)
  app.patch('/api/payroll/:id', requireAuth, requireRole(...HR), h(async (req, res) => {
    const rec = await get('SELECT * FROM payroll_records WHERE id=?', [req.params.id])
    if (!rec) return res.status(404).json({ message: 'Record not found' })
    const b = req.body || {}
    const bonus    = b.bonus    !== undefined ? Number(b.bonus)    : rec.bonus
    const benefits = b.benefits !== undefined ? Number(b.benefits) : rec.benefits ?? 0
    const { gross_pay, deductions, net_pay } = calcPayroll(rec.base_salary, bonus, benefits)
    await run(
      'UPDATE payroll_records SET bonus=?,benefits=?,gross_pay=?,deductions=?,net_pay=?,status=? WHERE id=?',
      [bonus, benefits, gross_pay, deductions, net_pay, 'processed', req.params.id]
    )
    const updated = await get('SELECT * FROM payroll_records WHERE id=?', [req.params.id])
    const em = await empMap()
    res.json({ ...updated, employee: em[updated.employee_id] })
  }))

  // ── performance ────────────────────────────────────────────────────
  app.get('/api/performance/reviews', requireAuth, h(async (req, res) => {
    const em = await empMap()
    let rows = await all('SELECT * FROM performance_reviews ORDER BY created_at DESC')
    if (req.user.role === 'employee') rows = rows.filter((r) => r.employee_id === req.user.employee_id)
    else if (req.query.employee_id) rows = rows.filter((r) => r.employee_id === req.query.employee_id || (em[r.employee_id] && em[r.employee_id].employee_code === req.query.employee_id))
    res.json(rows.map((r) => ({ ...r, employee: em[r.employee_id], reviewer: em[r.reviewer_id] })))
  }))
  app.get('/api/performance/goals', requireAuth, h(async (req, res) => {
    const em = await empMap()
    let rows = await all('SELECT * FROM goals ORDER BY created_at DESC')
    if (req.user.role === 'employee') rows = rows.filter((r) => r.employee_id === req.user.employee_id)
    else if (req.query.employee_id) rows = rows.filter((r) => r.employee_id === req.query.employee_id || (em[r.employee_id] && em[r.employee_id].employee_code === req.query.employee_id))
    res.json(rows.map((r) => ({ ...r, employee: em[r.employee_id] })))
  }))
  app.post('/api/performance/reviews', requireAuth, h(async (req, res) => {
    const caller = req.user
    if (!DEPT_MGRS.includes(caller.role)) return res.status(403).json({ message: 'Forbidden' })
    const b = req.body || {}
    if (!b.employee_id || !b.period) return res.status(400).json({ message: 'Employee and review period are required' })
    const resolvedEmpId = await resolveEmployeeId(b.employee_id)
    if (!resolvedEmpId) return res.status(404).json({ message: 'Employee not found' })
    const clamp = (n) => Math.max(0, Math.min(10, Math.round((Number(n) || 0) * 10) / 10))
    const g = clamp(b.goals_score), s = clamp(b.skills_score), c = clamp(b.culture_score)
    const score = b.score != null ? clamp(b.score) : clamp((g + s + c) / 3)
    const id = uid(); const t = now()
    await run('INSERT INTO performance_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, resolvedEmpId, req.user.employee_id || null, b.period, score, g, s, c, b.comments || '', b.status || 'submitted', t])
    const em = await empMap()
    const r = await get('SELECT * FROM performance_reviews WHERE id=?', [id])
    res.status(201).json({ ...r, employee: em[r.employee_id], reviewer: em[r.reviewer_id] })
  }))
  app.post('/api/performance/goals', requireAuth, requireRole(...HR), h(async (req, res) => {
    const b = req.body || {}
    if (!b.employee_id || !b.title) return res.status(400).json({ message: 'Employee and goal title are required' })
    const resolvedEmpId = await resolveEmployeeId(b.employee_id)
    if (!resolvedEmpId) return res.status(404).json({ message: 'Employee not found' })
    const progress = Math.max(0, Math.min(100, Math.round(Number(b.progress) || 0)))
    const status = b.status || (progress >= 100 ? 'completed' : 'on_track')
    const id = uid(); const t = now()
    await run('INSERT INTO goals VALUES (?,?,?,?,?,?,?,?)',
      [id, resolvedEmpId, b.title, b.description || '', b.target_date || '', progress, status, t])
    const em = await empMap()
    const g = await get('SELECT * FROM goals WHERE id=?', [id])
    res.status(201).json({ ...g, employee: em[g.employee_id] })
  }))
  app.patch('/api/performance/goals/:id/progress', requireAuth, requireRole(...HR), h(async (req, res) => {
    const p = Math.max(0, Math.min(100, Number(req.body.progress) || 0))
    const status = p >= 100 ? 'completed' : p < 40 ? 'at_risk' : 'on_track'
    await run('UPDATE goals SET progress=?, status=? WHERE id=?', [p, status, req.params.id])
    res.json({ id: req.params.id, progress: p, status })
  }))

  // ── documents ──────────────────────────────────────────────────────
  // Helper: check if a user (employee) can access a document
  const canAccessDoc = (doc, user, empRecord) => {
    if (HR.includes(user.role)) return true // HR always sees all
    if (doc.access_level === 'hr_only') return false
    if (doc.access_level === 'all_employees') return true // all logged-in users
    if (doc.access_level === 'specific_department') {
      if (!empRecord || !doc.access_departments) return false
      const depts = JSON.parse(doc.access_departments || '[]')
      return depts.includes(empRecord.department)
    }
    return false
  }

  app.get('/api/documents', requireAuth, h(async (req, res) => {
    const rows = await all('SELECT id, name, type, owner, size, updated_at, file_mime, access_level, access_departments FROM documents ORDER BY updated_at DESC')
    if (HR.includes(req.user.role)) return res.json(rows)
    // Employee: load their own record to check department
    const emp = req.user.employee_id ? await get('SELECT department FROM employees WHERE id=?', [req.user.employee_id]) : null
    res.json(rows.filter(d => canAccessDoc(d, req.user, emp)))
  }))

  app.post('/api/documents', requireAuth, requireRole(...HR), h(async (req, res) => {
    const b = req.body || {}; const id = uid()
    const access_level = ['hr_only', 'all_employees', 'specific_department'].includes(b.access_level) ? b.access_level : 'all_employees'
    const access_departments = access_level === 'specific_department' && Array.isArray(b.access_departments)
      ? JSON.stringify(b.access_departments) : null
    await run(
      'INSERT INTO documents (id,name,type,owner,size,updated_at,file_data,file_mime,access_level,access_departments) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, b.name, b.type || 'Other', b.owner || req.user.name, b.size || '—', now(),
       b.file_data || null, b.file_mime || null, access_level, access_departments]
    )
    res.status(201).json(await get('SELECT id,name,type,owner,size,updated_at,file_mime,access_level,access_departments FROM documents WHERE id=?', [id]))
  }))

  // PATCH access level — HR only
  app.patch('/api/documents/:id/access', requireAuth, requireRole(...HR), h(async (req, res) => {
    const b = req.body || {}
    const access_level = ['hr_only', 'all_employees', 'specific_department'].includes(b.access_level) ? b.access_level : 'all_employees'
    const access_departments = access_level === 'specific_department' && Array.isArray(b.access_departments)
      ? JSON.stringify(b.access_departments) : null
    const doc = await get('SELECT id FROM documents WHERE id=?', [req.params.id])
    if (!doc) return res.status(404).json({ message: 'Not found' })
    await run('UPDATE documents SET access_level=?,access_departments=?,updated_at=? WHERE id=?',
      [access_level, access_departments, now(), req.params.id])
    res.json(await get('SELECT id,name,type,owner,size,updated_at,file_mime,access_level,access_departments FROM documents WHERE id=?', [req.params.id]))
  }))

  app.get('/api/documents/:id/download', requireAuth, h(async (req, res) => {
    const doc = await get('SELECT name, file_data, file_mime, access_level, access_departments FROM documents WHERE id=?', [req.params.id])
    if (!doc) return res.status(404).json({ message: 'Document not found' })
    // Access check for employees
    if (!HR.includes(req.user.role)) {
      const emp = req.user.employee_id ? await get('SELECT department FROM employees WHERE id=?', [req.user.employee_id]) : null
      if (!canAccessDoc(doc, req.user, emp)) return res.status(403).json({ message: 'Access denied' })
    }
    if (!doc.file_data) return res.status(404).json({ message: 'No file attached to this document' })
    const buf = Buffer.from(doc.file_data, 'base64')
    res.setHeader('Content-Type', doc.file_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.name)}"`)
    res.send(buf)
  }))

  app.delete('/api/documents/:id', requireAuth, requireRole(...HR), h(async (req, res) => {
    await run('DELETE FROM documents WHERE id=?', [req.params.id])
    res.json({ id: req.params.id, deleted: true })
  }))

  // ── dashboard ──────────────────────────────────────────────────────
  app.get('/api/dashboard', requireAuth, requireRole(...HR), h(async (_req, res) => {
    const employees = await all('SELECT id, first_name, last_name, department, status, start_date, created_at FROM employees')
    const total = employees.length
    const empById = {}; for (const e of employees) empById[e.id] = e

    const deptColors = { 'Internal Audit': '#6C63FF', 'Risk and Compliance': '#00D4AA', 'Secretary': '#F5A623', 'Information Technology': '#3B82F6', 'Plan, Marketing and Promotion': '#E86FA0', 'Legal': '#8B85FF', 'Ethics Officer': '#4FA3E8', 'Operation': '#3DD68C', 'Branch Operations': '#0EA5E9', 'Finance': '#FF5F5F', 'Procurement': '#F59E0B', 'HR': '#14B8A6' }
    const byDept = {}; for (const e of employees) byDept[e.department] = (byDept[e.department] || 0) + 1
    const dept_headcount = Object.entries(byDept).map(([department, count]) => ({ department, count, color: deptColors[department] || '#94a3b8' }))

    const statusMeta = { active: ['Active', '#3dd68c'], wfh: ['Remote / WFH', '#3B82F6'], on_leave: ['On Leave', '#F5A623'], onboarding: ['Onboarding', '#8B85FF'], terminated: ['Terminated', '#EF4444'] }
    const byStatus = {}; for (const e of employees) byStatus[e.status] = (byStatus[e.status] || 0) + 1
    const status_breakdown = Object.entries(byStatus).map(([status, count]) => ({ status, label: (statusMeta[status] || [status])[0], count, color: (statusMeta[status] || [status, '#94a3b8'])[1] }))

    const pct = (n) => (total ? Math.round((n / total) * 100) : 0)
    const presence = [
      { label: 'In Office', count: byStatus['active'] || 0, pct: pct(byStatus['active'] || 0), color: 'bg-brand-500' },
      { label: 'Remote / WFH', count: byStatus['wfh'] || 0, pct: pct(byStatus['wfh'] || 0), color: 'bg-amber-500' },
      { label: 'On Leave', count: byStatus['on_leave'] || 0, pct: pct(byStatus['on_leave'] || 0), color: 'bg-teal-500' },
    ]

    // COUNT(*) comes back as a string on Postgres, so coerce with Number().
    const open_positions = Number((await get("SELECT COUNT(*) c FROM job_postings WHERE status='open'")).c)
    const pending_leave = Number((await get("SELECT COUNT(*) c FROM leave_requests WHERE status='pending'")).c)
    const approved_leave = Number((await get("SELECT COUNT(*) c FROM leave_requests WHERE status='approved'")).c)
    const denied_leave = Number((await get("SELECT COUNT(*) c FROM leave_requests WHERE status='denied'")).c)

    const today = new Date().toISOString().slice(0, 10)
    const att = await all('SELECT status FROM attendance WHERE date=?', [today])
    const present = att.filter(a => a.status === 'present').length
    const absent = att.filter(a => a.status === 'absent').length
    const attendance_rate = total ? Math.round((present / total) * 1000) / 10 : 0

    // Headcount trend: cumulative headcount by month from real start dates (last 6 months)
    const nowDate = new Date()
    const headcount_trend = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1)
      const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      const count = employees.filter(e => e.start_date && new Date(e.start_date) <= endOfMonth).length
      headcount_trend.push({ month: d.toLocaleString('en-US', { month: 'short' }), count })
    }

    // Recruitment pipeline: candidates by stage
    const stageOrder = ['applied', 'screening', 'interview', 'assessment', 'offer', 'hired', 'rejected']
    const byStage = {}; for (const c of await all('SELECT stage FROM candidates')) byStage[c.stage] = (byStage[c.stage] || 0) + 1
    const pipeline = stageOrder.filter(st => byStage[st]).map(stage => ({ stage: stage[0].toUpperCase() + stage.slice(1), count: byStage[stage] }))

    const reviews = {
      submitted: Number((await get("SELECT COUNT(*) c FROM performance_reviews WHERE status IN ('submitted','acknowledged')")).c),
      total,
    }

    // Activity feed: most recent real records across leave, candidates, hires
    const relTime = (iso) => {
      const diff = Date.now() - new Date(iso).getTime()
      const hh = Math.floor(diff / 3600000)
      if (hh < 1) return 'Just now'
      if (hh < 24) return `${hh}h ago`
      const dys = Math.floor(hh / 24)
      if (dys < 30) return `${dys}d ago`
      return `${Math.floor(dys / 30)}mo ago`
    }
    const acts = []
    for (const r of await all('SELECT employee_id, leave_type, created_at FROM leave_requests ORDER BY created_at DESC LIMIT 5')) {
      const e = empById[r.employee_id]
      acts.push({ created_at: r.created_at, text: `**${e ? e.first_name + ' ' + e.last_name : 'Someone'}** requested ${r.leave_type} leave`, dept: e ? e.department : '—', color: 'bg-amber-400' })
    }
    for (const c of await all('SELECT first_name, last_name, created_at FROM candidates ORDER BY created_at DESC LIMIT 5')) {
      acts.push({ created_at: c.created_at, text: `New candidate **${c.first_name} ${c.last_name}** applied`, dept: 'Recruiting', color: 'bg-teal-400' })
    }
    for (const e of await all('SELECT first_name, last_name, department, created_at FROM employees ORDER BY created_at DESC LIMIT 5')) {
      acts.push({ created_at: e.created_at, text: `**${e.first_name} ${e.last_name}** joined ${e.department}`, dept: e.department, color: 'bg-brand-400' })
    }
    const activity_feed = acts
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5)
      .map((it, i) => ({ id: i + 1, text: it.text, time: relTime(it.created_at), dept: it.dept, color: it.color }))

    // Upcoming: real upcoming leave requests
    const upcoming_events = (await all('SELECT employee_id, leave_type, start_date, status FROM leave_requests WHERE start_date >= ? ORDER BY start_date ASC LIMIT 5', [today]))
      .map((r, i) => {
        const e = empById[r.employee_id]
        const d = new Date(r.start_date)
        return { id: i + 1, title: `${e ? e.first_name + ' ' + e.last_name : 'Someone'} — ${r.leave_type} leave`, date: d.toLocaleString('en-US', { month: 'short', day: 'numeric' }), time: r.status, detail: `${r.leave_type} leave`, color: r.status === 'approved' ? 'border-teal-500' : 'border-amber-500' }
      })

    res.json({
      total_employees: total, on_leave: byStatus['on_leave'] || 0, open_positions, pending_leave, approved_leave, denied_leave,
      attendance_today: { present, absent, rate: attendance_rate, date: today },
      presence, dept_headcount, status_breakdown, headcount_trend, pipeline, reviews,
      activity_feed, upcoming_events,
    })
  }))

  // ── experience letters ──────────────────────────────────────────────
  // GET /api/experience-letters  — HR sees all; employee sees own
  app.get('/api/experience-letters', requireAuth, h(async (req, res) => {
    const isHR = HR.includes(req.user.role)
    if (isHR) {
      const rows = await all('SELECT * FROM experience_letters ORDER BY created_at DESC')
      const empM = await empMap()
      return res.json(rows.map(r => ({ ...r, employee: empM[r.employee_id] || null })))
    }
    if (!req.user.employee_id) return res.json([])
    const rows = await all('SELECT * FROM experience_letters WHERE employee_id=? ORDER BY created_at DESC', [req.user.employee_id])
    const empM = await empMap()
    res.json(rows.map(r => ({ ...r, employee: empM[r.employee_id] || null })))
  }))

  // POST /api/experience-letters  — any employee requests; HR can create on behalf
  app.post('/api/experience-letters', requireAuth, h(async (req, res) => {
    const b = req.body || {}
    const isHR = HR.includes(req.user.role)
    // employees can only request for themselves
    const employee_id = isHR && b.employee_id ? await resolveEmployeeId(b.employee_id) : req.user.employee_id
    if (!employee_id) return res.status(400).json({ message: 'No employee record linked to your account' })

    const emp = await get('SELECT * FROM employees WHERE id=?', [employee_id])
    if (!emp) return res.status(404).json({ message: 'Employee not found' })

    const id = uid()
    const ts = now()

    // Determine start/end dates: use provided values or fall back to employee start_date / today
    const startDate = b.start_date || emp.start_date || ts.slice(0, 10)
    const endDate = b.end_date || (emp.status === 'terminated' ? emp.updated_at.slice(0, 10) : ts.slice(0, 10))

    await run(
      `INSERT INTO experience_letters (id,employee_id,requested_by,requested_at,status,purpose,start_date,end_date,approved_by,approved_at,rejection_reason,letter_content,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, employee_id, req.user.id, ts, 'pending', b.purpose || null, startDate, endDate, null, null, null, null, ts, ts]
    )
    const row = await get('SELECT * FROM experience_letters WHERE id=?', [id])
    res.status(201).json({ ...row, employee: shapeEmp(emp) })
  }))

  // PATCH /api/experience-letters/:id/status  — HR approves/rejects
  app.patch('/api/experience-letters/:id/status', requireAuth, requireRole(...HR), h(async (req, res) => {
    const b = req.body || {}
    const { status, rejection_reason } = b
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'status must be approved or rejected' })

    const letter = await get('SELECT * FROM experience_letters WHERE id=?', [req.params.id])
    if (!letter) return res.status(404).json({ message: 'Letter request not found' })

    const ts = now()

    if (status === 'rejected') {
      await run(
        `UPDATE experience_letters SET status=?,rejection_reason=?,updated_at=? WHERE id=?`,
        ['rejected', rejection_reason || null, ts, req.params.id]
      )
    } else {
      // Generate letter content on approval
      const emp = await get('SELECT * FROM employees WHERE id=?', [letter.employee_id])
      if (!emp) return res.status(404).json({ message: 'Employee not found' })

      const formatDate = (d) => {
        if (!d) return 'N/A'
        const dt = new Date(d)
        return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      }

      // Calculate years of experience
      const start = new Date(letter.start_date)
      const end = new Date(letter.end_date)
      const diffMs = end - start
      const totalMonths = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44))
      const years = Math.floor(totalMonths / 12)
      const months = totalMonths % 12
      let duration = ''
      if (years > 0 && months > 0) duration = `${years} year${years > 1 ? 's' : ''} and ${months} month${months > 1 ? 's' : ''}`
      else if (years > 0) duration = `${years} year${years > 1 ? 's' : ''}`
      else if (months > 0) duration = `${months} month${months > 1 ? 's' : ''}`
      else duration = 'less than a month'

      const letterContent = `EXPERIENCE LETTER
ACGF — Addis Capital Goods Finance Business

Date: ${formatDate(ts)}
Ref: EXP-${req.params.id.slice(0, 8).toUpperCase()}

To Whom It May Concern,

This is to certify that ${emp.first_name} ${emp.last_name} has been employed with ACGF in the capacity of ${emp.job_title} in the ${emp.department} department.

Period of Employment:
  Start Date : ${formatDate(letter.start_date)}
  End Date   : ${formatDate(letter.end_date)}
  Duration   : ${duration}

${emp.first_name} has demonstrated professional conduct and diligence throughout their tenure.${letter.purpose ? ` This letter is issued upon request for the purpose of: ${letter.purpose}.` : ''}

We wish ${emp.first_name} the very best in all future endeavours.

Sincerely,

_______________________________
Human Resources Department
ACGF — Addis Capital Goods Finance Business
`

      await run(
        `UPDATE experience_letters SET status=?,approved_by=?,approved_at=?,letter_content=?,updated_at=? WHERE id=?`,
        ['approved', req.user.id, ts, letterContent, ts, req.params.id]
      )
    }

    const updated = await get('SELECT * FROM experience_letters WHERE id=?', [req.params.id])
    const emp2 = await get('SELECT * FROM employees WHERE id=?', [updated.employee_id])
    res.json({ ...updated, employee: shapeEmp(emp2) })
  }))

  // DELETE /api/experience-letters/:id  — HR can delete any; employee can cancel pending own
  app.delete('/api/experience-letters/:id', requireAuth, h(async (req, res) => {
    const letter = await get('SELECT * FROM experience_letters WHERE id=?', [req.params.id])
    if (!letter) return res.status(404).json({ message: 'Not found' })
    const isHR = HR.includes(req.user.role)
    const isOwner = req.user.employee_id === letter.employee_id
    if (!isHR && !isOwner) return res.status(403).json({ message: 'Forbidden' })
    if (!isHR && letter.status !== 'pending') return res.status(400).json({ message: 'Can only cancel pending requests' })
    await run('DELETE FROM experience_letters WHERE id=?', [req.params.id])
    res.json({ id: req.params.id, deleted: true })
  }))

  // ── clearance requests ─────────────────────────────────────────────
  // HR sees all clearance requests; an employee can see their own.
  app.get('/api/clearance', requireAuth, h(async (req, res) => {
    const em = await empMap()
    let rows = await all('SELECT id,employee_id,requested_by,last_working_date,reason,status,doc_name,doc_mime,approved_by,approved_at,rejection_reason,certificate_content,created_at,updated_at FROM clearance_requests ORDER BY created_at DESC')
    if (!HR.includes(req.user.role)) {
      if (!req.user.employee_id) return res.json([])
      rows = rows.filter(r => r.employee_id === req.user.employee_id)
    }
    res.json(rows.map(r => ({ ...r, employee: em[r.employee_id] })))
  }))

  app.post('/api/clearance', requireAuth, requireRole(...HR), h(async (req, res) => {
    const b = req.body || {}
    if (!b.employee_id) return res.status(400).json({ message: 'employee_id required' })
    const emp = await get('SELECT * FROM employees WHERE id=? OR employee_code=?', [b.employee_id, b.employee_id])
    if (!emp) return res.status(404).json({ message: 'Employee not found' })
    const id = uid(); const ts = now()
    await run(
      'INSERT INTO clearance_requests (id,employee_id,requested_by,last_working_date,reason,status,doc_data,doc_name,doc_mime,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, emp.id, req.user.id, b.last_working_date || null, b.reason || null, 'pending',
       b.doc_data || null, b.doc_name || null, b.doc_mime || null, ts, ts]
    )
    res.status(201).json(await get('SELECT id,employee_id,requested_by,last_working_date,reason,status,doc_name,doc_mime,created_at,updated_at FROM clearance_requests WHERE id=?', [id]))
  }))

  app.patch('/api/clearance/:id/status', requireAuth, requireRole(...HR), h(async (req, res) => {
    const { status, rejection_reason } = req.body || {}
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ message: 'Invalid status' })
    const rec = await get('SELECT * FROM clearance_requests WHERE id=?', [req.params.id])
    if (!rec) return res.status(404).json({ message: 'Not found' })
    const emp = await get('SELECT * FROM employees WHERE id=?', [rec.employee_id])
    const ts = now()
    let certificate_content = null
    if (status === 'approved' && emp) {
      const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'
      certificate_content = `CLEARANCE CERTIFICATE
ACGF — Addis Capital Goods Finance Business

Date: ${formatDate(ts)}
Ref: CLR-${req.params.id.slice(0,8).toUpperCase()}

This is to certify that ${emp.first_name} ${emp.last_name} (Employee ID: ${emp.employee_code || emp.id.slice(0,8).toUpperCase()}), who served as ${emp.job_title} in the ${emp.department} Department, has been duly cleared from all responsibilities and obligations to ACGF.

Last Working Date : ${formatDate(rec.last_working_date)}
Reason            : ${rec.reason || 'N/A'}

All company property, documents, and access credentials have been returned/revoked. There are no outstanding dues or pending obligations as of the date of issuance of this certificate.

This certificate is issued for official and reference purposes.

_______________________________
Human Resources Department
ACGF — Addis Capital Goods Finance Business
`
    }
    await run('UPDATE clearance_requests SET status=?,approved_by=?,approved_at=?,rejection_reason=?,certificate_content=?,updated_at=? WHERE id=?',
      [status, req.user.id, ts, rejection_reason || null, certificate_content, ts, req.params.id])
    if (status === 'approved') {
      await run("UPDATE employees SET status='terminated',updated_at=? WHERE id=?", [ts, rec.employee_id])
    }
    res.json({ id: req.params.id, status, certificate_content })
  }))

  // HR or the affected employee can download the attached resignation/termination doc.
  app.get('/api/clearance/:id/doc', requireAuth, h(async (req, res) => {
    const rec = await get('SELECT employee_id,doc_data,doc_name,doc_mime FROM clearance_requests WHERE id=?', [req.params.id])
    if (!rec) return res.status(404).json({ message: 'Not found' })
    if (!HR.includes(req.user.role) && req.user.employee_id !== rec.employee_id) return res.status(403).json({ message: 'Forbidden' })
    if (!rec.doc_data) return res.status(404).json({ message: 'No document' })
    const buf = Buffer.from(rec.doc_data, 'base64')
    res.setHeader('Content-Type', rec.doc_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(rec.doc_name || 'clearance.pdf')}"`)
    res.send(buf)
  }))

  // HR or the affected employee can download the generated clearance certificate.
  app.get('/api/clearance/:id/certificate', requireAuth, h(async (req, res) => {
    const rec = await get('SELECT employee_id,certificate_content FROM clearance_requests WHERE id=?', [req.params.id])
    if (!rec) return res.status(404).json({ message: 'Not found' })
    if (!HR.includes(req.user.role) && req.user.employee_id !== rec.employee_id) return res.status(403).json({ message: 'Forbidden' })
    if (!rec.certificate_content) return res.status(404).json({ message: 'Certificate not yet generated' })
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="clearance-certificate-${req.params.id.slice(0,8)}.txt"`)
    res.send(rec.certificate_content)
  }))

  // ── work guarantee requests ────────────────────────────────────────
  app.get('/api/work-guarantee', requireAuth, h(async (req, res) => {
    const em = await empMap()
    let rows = await all('SELECT id,employee_id,guaranteed_person_name,guaranteed_company,purpose,status,letter_content,approved_by,approved_at,rejection_reason,created_at,updated_at FROM work_guarantee_requests ORDER BY created_at DESC')
    if (!HR.includes(req.user.role)) rows = rows.filter(r => r.employee_id === req.user.employee_id)
    res.json(rows.map(r => ({ ...r, employee: em[r.employee_id] })))
  }))

  app.post('/api/work-guarantee', requireAuth, h(async (req, res) => {
    const b = req.body || {}
    const employee_id = HR.includes(req.user.role)
      ? (b.employee_id ? await resolveEmployeeId(b.employee_id) : req.user.employee_id)
      : req.user.employee_id
    if (!employee_id) return res.status(400).json({ message: 'employee_id required' })
    if (!b.guaranteed_person_name || !b.guaranteed_company) return res.status(400).json({ message: 'guaranteed_person_name and guaranteed_company are required' })
    const id = uid(); const ts = now()
    await run(
      'INSERT INTO work_guarantee_requests (id,employee_id,guaranteed_person_name,guaranteed_company,purpose,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, employee_id, b.guaranteed_person_name, b.guaranteed_company, b.purpose || null, 'pending', ts, ts]
    )
    res.status(201).json(await get('SELECT * FROM work_guarantee_requests WHERE id=?', [id]))
  }))

  app.patch('/api/work-guarantee/:id/status', requireAuth, requireRole(...HR), h(async (req, res) => {
    const { status, rejection_reason } = req.body || {}
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ message: 'Invalid status' })
    const req_ = await get('SELECT * FROM work_guarantee_requests WHERE id=?', [req.params.id])
    if (!req_) return res.status(404).json({ message: 'Not found' })
    const emp = await get('SELECT * FROM employees WHERE id=?', [req_.employee_id])
    const ts = now()
    let letter_content = null
    if (status === 'approved' && emp) {
      const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'
      letter_content = `WORK GUARANTEE LETTER
ACGF — Addis Capital Goods Finance Business

Date: ${formatDate(ts)}
Ref: WGL-${req.params.id.slice(0,8).toUpperCase()}

To Whom It May Concern,

We, the undersigned, hereby confirm that ${emp.first_name} ${emp.last_name}, currently serving as ${emp.job_title} in the ${emp.department} Department at ACGF, Employee ID: ${emp.employee_code || emp.id.slice(0,8).toUpperCase()}, has formally requested this work guarantee letter on behalf of ${req_.guaranteed_person_name}.

This letter serves as an official guarantee that ${emp.first_name} ${emp.last_name} takes full responsibility for ${req_.guaranteed_person_name} with respect to their engagement with ${req_.guaranteed_company}.${req_.purpose ? `\n\nPurpose: ${req_.purpose}` : ''}

ACGF confirms that ${emp.first_name} ${emp.last_name} is a standing employee in good conduct.

Sincerely,

_______________________________
Human Resources Department
ACGF — Addis Capital Goods Finance Business
`
    }
    await run('UPDATE work_guarantee_requests SET status=?,approved_by=?,approved_at=?,rejection_reason=?,letter_content=?,updated_at=? WHERE id=?',
      [status, req.user.id, ts, rejection_reason || null, letter_content, ts, req.params.id])
    res.json({ id: req.params.id, status, letter_content })
  }))

  // HR or the requesting employee can download the generated letter.
  app.get('/api/work-guarantee/:id/letter', requireAuth, h(async (req, res) => {
    const rec = await get('SELECT employee_id,letter_content FROM work_guarantee_requests WHERE id=?', [req.params.id])
    if (!rec) return res.status(404).json({ message: 'Not found' })
    if (!HR.includes(req.user.role) && req.user.employee_id !== rec.employee_id) return res.status(403).json({ message: 'Forbidden' })
    if (!rec.letter_content) return res.status(404).json({ message: 'Letter not yet generated (request must be approved)' })
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="work-guarantee-letter-${req.params.id.slice(0,8)}.txt"`)
    res.send(rec.letter_content)
  }))

  // ── TOR trainings ──────────────────────────────────────────────────
  // HR sees all TOR records. Employees see TORs scoped to them individually
  // or to their department.
  app.get('/api/tor', requireAuth, h(async (req, res) => {
    const em = await empMap()
    let rows = await all('SELECT * FROM tor_trainings ORDER BY created_at DESC')
    if (!HR.includes(req.user.role)) {
      const myEmp = req.user.employee_id ? await get('SELECT department FROM employees WHERE id=?', [req.user.employee_id]) : null
      rows = rows.filter(r =>
        (r.scope === 'employee' && r.employee_id === req.user.employee_id) ||
        (r.scope === 'department' && myEmp && r.department === myEmp.department)
      )
    }
    res.json(rows.map(r => ({ ...r, employee: r.employee_id ? em[r.employee_id] : undefined })))
  }))

  app.post('/api/tor', requireAuth, requireRole(...HR), h(async (req, res) => {
    const b = req.body || {}
    const scope = b.scope === 'department' ? 'department' : 'employee'
    if (!b.title) return res.status(400).json({ message: 'title is required' })
    if (scope === 'employee' && !b.employee_id) return res.status(400).json({ message: 'employee_id is required for employee-scoped TOR' })
    if (scope === 'department' && !b.department) return res.status(400).json({ message: 'department is required for department-scoped TOR' })

    let emp = null
    if (scope === 'employee') {
      emp = await get('SELECT * FROM employees WHERE id=? OR employee_code=?', [b.employee_id, b.employee_id])
      if (!emp) return res.status(404).json({ message: 'Employee not found' })
    }

    const id = uid(); const ts = now()
    const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'

    const traineeBlock = scope === 'employee'
      ? `TRAINEE INFORMATION
  Full Name   : ${emp.first_name} ${emp.last_name}
  Employee ID : ${emp.employee_code || emp.id.slice(0,8).toUpperCase()}
  Department  : ${emp.department}
  Job Title   : ${emp.job_title}`
      : `TRAINEE INFORMATION
  Department  : ${b.department}
  Scope       : All employees in this department`

    const tor_content = `TERMS OF REFERENCE (TOR)
ACGF — Addis Capital Goods Finance Business
Training & Development

Date: ${formatDate(ts)}
Ref: TOR-${id.slice(0,8).toUpperCase()}

${traineeBlock}

TRAINING DETAILS
  Title     : ${b.title}
  Objective : ${b.objective || 'To enhance professional skills and competencies'}
  Duration  : ${b.duration || 'TBD'}
  Venue     : ${b.venue || 'TBD'}
  Trainer   : ${b.trainer || 'TBD'}
  Start     : ${formatDate(b.start_date)}
  End       : ${formatDate(b.end_date)}

SCOPE OF TRAINING
${scope === 'employee'
  ? "The training aims to develop the professional capabilities of the above-named employee in alignment with ACGF's strategic objectives and individual development plans."
  : `This training is organized for all employees of the ${b.department} Department as part of ACGF's departmental development plan.`}

EXPECTED OUTCOMES
${scope === 'employee'
  ? 'Following the training, the employee is expected to apply the acquired knowledge and skills in their day-to-day responsibilities and contribute to departmental effectiveness.'
  : 'Following the training, participating employees are expected to apply the acquired knowledge and skills in their roles, improving overall departmental performance.'}

Approved by,

_______________________________
Human Resources Department
ACGF — Addis Capital Goods Finance Business
`
    await run(
      'INSERT INTO tor_trainings (id,employee_id,department,scope,title,objective,duration,venue,trainer,start_date,end_date,created_by,tor_content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, scope === 'employee' ? emp.id : null, scope === 'department' ? b.department : (emp ? emp.department : null),
       scope, b.title, b.objective||null, b.duration||null, b.venue||null, b.trainer||null,
       b.start_date||null, b.end_date||null, req.user.id, tor_content, ts, ts]
    )
    const em = await empMap()
    const row = await get('SELECT * FROM tor_trainings WHERE id=?', [id])
    res.status(201).json({ ...row, employee: row.employee_id ? em[row.employee_id] : undefined })
  }))

  // ── social security document generation ───────────────────────────
  app.get('/api/employees/:id/social-security', requireAuth, requireRole(...HR), h(async (req, res) => {
    const emp = await get('SELECT * FROM employees WHERE id=? OR employee_code=?', [req.params.id, req.params.id])
    if (!emp) return res.status(404).json({ message: 'Employee not found' })
    const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'
    const doc = `SOCIAL SECURITY ENROLLMENT FORM
ACGF — Addis Capital Goods Finance Business

Date: ${formatDate(new Date())}
Ref: SSF-${emp.employee_code || emp.id.slice(0,8).toUpperCase()}

EMPLOYEE DETAILS
  Full Name         : ${emp.first_name} ${emp.last_name}
  Employee Code     : ${emp.employee_code || emp.id.slice(0,8).toUpperCase()}
  Email             : ${emp.email}
  Phone             : ${emp.phone || 'N/A'}
  Department        : ${emp.department}
  Job Title         : ${emp.job_title}
  Employment Type   : ${emp.employment_type}
  Start Date        : ${formatDate(emp.start_date)}
  Monthly Salary    : ETB ${Math.round((Number(emp.salary)||0)/12).toLocaleString()}

EMPLOYER DETAILS
  Organization      : ACGF
  Location          : ${emp.location || 'Addis Ababa, Ethiopia'}

CONTRIBUTION SUMMARY
  Employee Contribution (7%)  : ETB ${Math.round(((Number(emp.salary)||0)/12)*0.07).toLocaleString()}
  Employer Contribution (11%) : ETB ${Math.round(((Number(emp.salary)||0)/12)*0.11).toLocaleString()}
  Total Monthly Contribution  : ETB ${Math.round(((Number(emp.salary)||0)/12)*0.18).toLocaleString()}

This document is issued for social security enrollment purposes.

_______________________________
Human Resources Department
ACGF — Addis Capital Goods Finance Business
`
    res.json({ employee_id: emp.id, employee_code: emp.employee_code, full_name: `${emp.first_name} ${emp.last_name}`, document: doc })
  }))

  // ── employee ID card data ──────────────────────────────────────────
  // HR generates/issues the official ID card for an employee. This stamps the employee
  // record so the card becomes visible on that employee's own dashboard.

  // Build the full id-card payload. Photo is embedded as a base64 data URL so
  // the browser can render it in an <img> tag without needing an auth header.
  const buildCardPayload = (emp, extra = {}) => {
    const photoDataUrl = emp.photo_data
      ? `data:${emp.photo_mime || 'image/jpeg'};base64,${emp.photo_data}`
      : null
    return {
      id: emp.id,
      employee_code: emp.employee_code || `ACGF-${emp.id.slice(0,8).toUpperCase()}`,
      full_name: `${emp.first_name} ${emp.last_name}`,
      job_title: emp.job_title,
      department: emp.department,
      email: emp.email,
      phone: emp.phone,
      start_date: emp.start_date,
      photo_data_url: photoDataUrl,
      organization: 'ACGF',
      is_issued: !!emp.id_card_issued_at,
      issued_at: emp.id_card_issued_at || new Date().toISOString(),
      ...extra,
    }
  }

  app.post('/api/employees/:id/id-card/issue', requireAuth, requireRole(...HR), h(async (req, res) => {
    const emp = await get('SELECT * FROM employees WHERE id=? OR employee_code=?', [req.params.id, req.params.id])
    if (!emp) return res.status(404).json({ message: 'Employee not found' })
    const ts = now()
    await run('UPDATE employees SET id_card_issued_at=?,id_card_issued_by=? WHERE id=?', [ts, req.user.id, emp.id])
    // Reload emp to get photo_data
    const empFull = await get('SELECT * FROM employees WHERE id=?', [emp.id])
    res.json(buildCardPayload(empFull, { issued_at: ts, is_issued: true }))
  }))

  // View a previously generated ID card. HR can preview any card at any time (even before
  // formally issuing it). A non-HR employee can only view their own card, and only after HR
  // has issued it at least once.
  app.get('/api/employees/:id/id-card', requireAuth, h(async (req, res) => {
    const isHR = HR.includes(req.user.role)
    // Accept either the internal UUID or the human-readable employee_code (e.g. ACGF-20260612-1234)
    const emp = await get('SELECT * FROM employees WHERE id=? OR employee_code=?', [req.params.id, req.params.id])
    if (!emp) return res.status(404).json({ message: 'Employee not found' })
    if (!isHR && req.user.employee_id !== emp.id) return res.status(403).json({ message: 'Forbidden' })
    if (!isHR && !emp.id_card_issued_at) return res.status(404).json({ message: 'Your ID card has not been issued yet. Please contact HR.' })
    res.json(buildCardPayload(emp))
  }))

  // ── candidate document downloads ───────────────────────────────────
  app.get('/api/candidates/:id/cv', requireAuth, requireRole(...HR), h(async (req, res) => {
    const c = await get('SELECT cv_data,cv_name,cv_mime FROM candidates WHERE id=?', [req.params.id])
    if (!c || !c.cv_data) return res.status(404).json({ message: 'CV not found' })
    const buf = Buffer.from(c.cv_data, 'base64')
    res.setHeader('Content-Type', c.cv_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(c.cv_name || 'cv')}"`)
    res.send(buf)
  }))
  app.get('/api/candidates/:id/cover-letter', requireAuth, requireRole(...HR), h(async (req, res) => {
    const c = await get('SELECT cover_letter_data,cover_letter_name,cover_letter_mime FROM candidates WHERE id=?', [req.params.id])
    if (!c || !c.cover_letter_data) return res.status(404).json({ message: 'Cover letter not found' })
    const buf = Buffer.from(c.cover_letter_data, 'base64')
    res.setHeader('Content-Type', c.cover_letter_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(c.cover_letter_name || 'cover-letter')}"`)
    res.send(buf)
  }))
  app.get('/api/candidates/:id/edu-cert', requireAuth, requireRole(...HR), h(async (req, res) => {
    const c = await get('SELECT edu_cert_data,edu_cert_name,edu_cert_mime FROM candidates WHERE id=?', [req.params.id])
    if (!c || !c.edu_cert_data) return res.status(404).json({ message: 'Education cert not found' })
    const buf = Buffer.from(c.edu_cert_data, 'base64')
    res.setHeader('Content-Type', c.edu_cert_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(c.edu_cert_name || 'edu-cert')}"`)
    res.send(buf)
  }))
  app.get('/api/candidates/:id/exp-doc', requireAuth, requireRole(...HR), h(async (req, res) => {
    const c = await get('SELECT exp_doc_data,exp_doc_name,exp_doc_mime FROM candidates WHERE id=?', [req.params.id])
    if (!c || !c.exp_doc_data) return res.status(404).json({ message: 'Experience doc not found' })
    const buf = Buffer.from(c.exp_doc_data, 'base64')
    res.setHeader('Content-Type', c.exp_doc_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(c.exp_doc_name || 'exp-doc')}"`)
    res.send(buf)
  }))

  // ── employee file downloads ─────────────────────────────────────────
  app.get('/api/employees/:id/photo', requireAuth, h(async (req, res) => {
    const isHR = HR.includes(req.user.role)
    if (!isHR && req.user.employee_id !== req.params.id) return res.status(403).json({ message: 'Forbidden' })
    const e = await get('SELECT photo_data,photo_name,photo_mime FROM employees WHERE id=?', [req.params.id])
    if (!e || !e.photo_data) return res.status(404).json({ message: 'No photo' })
    const buf = Buffer.from(e.photo_data, 'base64')
    res.setHeader('Content-Type', e.photo_mime || 'image/jpeg')
    res.send(buf)
  }))
  app.get('/api/employees/:id/cv-file', requireAuth, requireRole(...HR), h(async (req, res) => {
    const e = await get('SELECT cv_file_data,cv_file_name,cv_file_mime FROM employees WHERE id=?', [req.params.id])
    if (!e || !e.cv_file_data) return res.status(404).json({ message: 'No CV file' })
    const buf = Buffer.from(e.cv_file_data, 'base64')
    res.setHeader('Content-Type', e.cv_file_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(e.cv_file_name || 'cv')}"`)
    res.send(buf)
  }))
  app.get('/api/employees/:id/other-file', requireAuth, requireRole(...HR), h(async (req, res) => {
    const e = await get('SELECT other_file_data,other_file_name,other_file_mime FROM employees WHERE id=?', [req.params.id])
    if (!e || !e.other_file_data) return res.status(404).json({ message: 'No file' })
    const buf = Buffer.from(e.other_file_data, 'base64')
    res.setHeader('Content-Type', e.other_file_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(e.other_file_name || 'document')}"`)
    res.send(buf)
  }))

  // Employee can check status of their own applications
  app.get('/api/my-applications', requireAuth, h(async (req, res) => {
    const email = req.user.email
    if (!email) return res.status(400).json({ message: 'No email on account' })
    const rows = await all('SELECT id,job_id,first_name,last_name,email,stage,application_status,hr_message,created_at,updated_at FROM candidates WHERE email=? ORDER BY created_at DESC', [email])
    const jobs = await all('SELECT id,title,department FROM job_postings')
    const jobMap = Object.fromEntries(jobs.map(j => [j.id, j]))
    res.json(rows.map(r => ({ ...r, job: jobMap[r.job_id] })))
  }))

  // Documents accessible to ALL authenticated users (not just HR)
  app.get('/api/documents/all', requireAuth, h(async (_req, res) => {
    const rows = await all('SELECT id,name,type,owner,size,updated_at,access_level,access_departments FROM documents ORDER BY updated_at DESC')
    res.json(rows)
  }))

  app.get('/api/candidates/:id/other-doc', requireAuth, requireRole(...HR), h(async (req, res) => {
    const c = await get('SELECT other_doc_data,other_doc_name,other_doc_mime FROM candidates WHERE id=?', [req.params.id])
    if (!c || !c.other_doc_data) return res.status(404).json({ message: 'Other doc not found' })
    const buf = Buffer.from(c.other_doc_data, 'base64')
    res.setHeader('Content-Type', c.other_doc_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(c.other_doc_name || 'document')}"`)
    res.send(buf)
  }))

  app.get('/api/employees/:id/edu-file', requireAuth, requireRole(...HR), h(async (req, res) => {
    const e = await get('SELECT edu_file_data,edu_file_name,edu_file_mime FROM employees WHERE id=?', [req.params.id])
    if (!e || !e.edu_file_data) return res.status(404).json({ message: 'No education file' })
    const buf = Buffer.from(e.edu_file_data, 'base64')
    res.setHeader('Content-Type', e.edu_file_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(e.edu_file_name || 'education')}"`)
    res.send(buf)
  }))
  app.get('/api/employees/:id/exp-file', requireAuth, requireRole(...HR), h(async (req, res) => {
    const e = await get('SELECT exp_file_data,exp_file_name,exp_file_mime FROM employees WHERE id=?', [req.params.id])
    if (!e || !e.exp_file_data) return res.status(404).json({ message: 'No experience file' })
    const buf = Buffer.from(e.exp_file_data, 'base64')
    res.setHeader('Content-Type', e.exp_file_mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(e.exp_file_name || 'experience')}"`)
    res.send(buf)
  }))

  // 403/401 errors return JSON already; generic fallback:
  app.use((_req, res) => res.status(404).json({ message: 'Route not found' }))

  return app
}

module.exports = { createApp }
