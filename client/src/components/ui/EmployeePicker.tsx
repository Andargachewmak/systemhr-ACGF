import { useEffect, useState } from 'react'
import { fetchEmployees } from '@/lib/api'
import type { Employee } from '@/types'

interface Props {
  value: string
  onChange: (id: string, employee?: Employee) => void
  label?: string
  placeholder?: string
  required?: boolean
}

export function EmployeePicker({ value, onChange, label = 'Employee', placeholder = 'Search employee…', required }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Employee | null>(null)

  useEffect(() => {
    fetchEmployees().then(setEmployees).catch(() => {})
  }, [])

  // Sync selected label when value set externally
  useEffect(() => {
    if (!value) { setSelected(null); setQuery(''); return }
    const emp = employees.find(e => e.id === value || e.employee_code === value)
    if (emp) { setSelected(emp); setQuery(`${emp.first_name} ${emp.last_name}`) }
  }, [value, employees])

  const filtered = query.length < 1 ? employees.slice(0, 20) : employees.filter(e => {
    const q = query.toLowerCase()
    return `${e.first_name} ${e.last_name}`.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      (e.employee_code || '').toLowerCase().includes(q) ||
      e.department.toLowerCase().includes(q)
  }).slice(0, 20)

  const pick = (emp: Employee) => {
    setSelected(emp)
    setQuery(`${emp.first_name} ${emp.last_name}`)
    setOpen(false)
    onChange(emp.id, emp)
  }

  const clear = () => {
    setSelected(null); setQuery(''); onChange('')
  }

  return (
    <div className="relative">
      {label && (
        <label className="block text-xs font-medium text-gray-700 mb-1">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
      )}
      <div className="relative flex items-center">
        <input
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); if (!e.target.value) clear() }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 pr-8"
        />
        {selected && (
          <button onClick={clear} className="absolute right-2 text-gray-400 hover:text-gray-600 text-xs">✕</button>
        )}
      </div>
      {selected && (
        <p className="text-xs text-indigo-600 mt-0.5 font-mono">{selected.employee_code || selected.id.slice(0,8)} · {selected.department}</p>
      )}
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-xl max-h-56 overflow-y-auto">
          {filtered.map(emp => (
            <button
              key={emp.id}
              onMouseDown={() => pick(emp)}
              className="w-full text-left px-3 py-2.5 hover:bg-indigo-50 transition-colors flex items-center gap-3 border-b border-gray-50 last:border-0"
            >
              <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-xs flex-shrink-0">
                {emp.first_name[0]}{emp.last_name[0]}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{emp.first_name} {emp.last_name}</p>
                <p className="text-xs text-gray-500 truncate">{emp.department} · {emp.employee_code || emp.id.slice(0,8)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
