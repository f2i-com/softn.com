export interface HrOverview {
  headcount: number;
  activeCount: number;
  onLeaveCount: number;
  checkedInCount: number;
  pendingLeaves: number;
  openCandidates: number;
  monthlyPayroll: number;
  openAppraisals: number;
}

export interface Employee {
  id: number;
  name: string;
  role_title: string;
  department: string;
  email: string;
  location: string;
  manager_name: string;
  employment_type: string;
  base_salary: number;
  status: string;
  leave_balance: number;
  start_date: string;
  checked_in?: boolean;
  check_in_time?: string;
}

export interface Attendance {
  id: number;
  employee_id: number;
  employee_name: string;
  work_date: string;
  check_in: string;
  check_out: string;
  worked_hours: number;
  status: string;
}

export interface LeaveRequest {
  id: number;
  employee_id: number;
  employee_name: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  days: number;
  reason: string;
  status: string;
}

export interface Candidate {
  id: number;
  name: string;
  role_applied: string;
  department: string;
  email: string;
  stage: string;
  rating: number;
  notes: string;
}

export interface Appraisal {
  id: number;
  employee_id: number;
  employee_name: string;
  cycle: string;
  goals: string;
  self_rating: number;
  manager_rating: number;
  status: string;
  review_date: string;
}

export interface Payslip {
  id: number;
  slip_number: string;
  employee_id: number;
  employee_name: string;
  pay_period: string;
  gross_pay: number;
  tax_withheld: number;
  super_contrib: number;
  net_pay: number;
  status: string;
  created_at: string;
}
