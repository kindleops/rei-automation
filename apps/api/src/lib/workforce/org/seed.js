// The executive staff seed (docs/WORKFORCE.md §1). The SAME ids as the migration seed:
// emp_ceo (the owner, human), emp_coo "Atlas", emp_cfo "Ledger", one head per department, the
// Operations & Quality Supervisor and one research analyst. NO acquisition agents are seeded:
// the CEO (or the COO, through a proposal) creates them per market.
// employee_code matches the store's CHECK ^[A-Z]{2,6}-[0-9]{2,3}$; markets are lower-case slugs.
import { ROLE_CHARTERS } from './charters.js'

const emp = (o) => Object.freeze({
  kind: ROLE_CHARTERS[o.role_key].kind,
  department_key: ROLE_CHARTERS[o.role_key].department_key,
  status: 'active',
  markets: Object.freeze([]),
  segments: Object.freeze({}),
  tier_ceiling: 'T1',
  spend_day_cap_usd: 0,
  action_principal_id: null,
  user_id: null,
  ...o,
})

export const SEED_EMPLOYEES = Object.freeze([
  emp({ employee_id: 'emp_ceo', role_key: 'ceo', display_name: 'CEO', employee_code: 'CEO-01', manager_employee_id: null }),
  emp({ employee_id: 'emp_coo', role_key: 'coo', display_name: 'Atlas', employee_code: 'COO-01', manager_employee_id: 'emp_ceo' }),
  emp({ employee_id: 'emp_cfo', role_key: 'cfo', display_name: 'Ledger', employee_code: 'CFO-01', manager_employee_id: 'emp_ceo' }),
  emp({ employee_id: 'emp_head_acquisitions', role_key: 'head_acquisitions', display_name: 'Head of Acquisitions', employee_code: 'ACQ-01', manager_employee_id: 'emp_coo' }),
  emp({ employee_id: 'emp_head_marketing', role_key: 'head_marketing', display_name: 'Head of Marketing', employee_code: 'MKT-01', manager_employee_id: 'emp_coo' }),
  emp({ employee_id: 'emp_head_dispositions', role_key: 'head_dispositions', display_name: 'Head of Dispositions', employee_code: 'DSP-01', manager_employee_id: 'emp_coo' }),
  emp({ employee_id: 'emp_head_data', role_key: 'head_data_intelligence', display_name: 'Head of Data & Intelligence', employee_code: 'DAT-01', manager_employee_id: 'emp_coo' }),
  emp({ employee_id: 'emp_ops_supervisor', role_key: 'ops_supervisor', display_name: 'Operations & Quality Supervisor', employee_code: 'OPS-01', manager_employee_id: 'emp_coo' }),
  emp({ employee_id: 'emp_research_01', role_key: 'research_analyst', display_name: 'Research Analyst 1', employee_code: 'RES-01', manager_employee_id: 'emp_head_data' }),
])
export const SEED_EMPLOYEE_IDS = Object.freeze(SEED_EMPLOYEES.map((e) => e.employee_id))
export const CEO_EMPLOYEE_ID = 'emp_ceo'
export const COO_EMPLOYEE_ID = 'emp_coo'
export const CFO_EMPLOYEE_ID = 'emp_cfo'

/** The seed rows for one org; the CEO row is bound to the owner's user id. */
export function seedEmployeesFor({ org_id, owner_user_id = null } = {}) {
  return SEED_EMPLOYEES.map((e) => ({ ...e, org_id, markets: [...e.markets], segments: { ...e.segments }, ...(e.employee_id === CEO_EMPLOYEE_ID ? { user_id: owner_user_id } : {}) }))
}
