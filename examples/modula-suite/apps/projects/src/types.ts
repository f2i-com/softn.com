export interface EmployeeUtil {
  employee: string;
  hours: number;
  billable: number;
}

export interface ProjectsOverview {
  activeProjects: number;
  openTasks: number;
  doneTasks: number;
  milestonesTotal: number;
  milestonesReached: number;
  totalHours: number;
  billableHours: number;
  billableRevenue: number;
  laborCost: number;
  grossMargin: number;
  byEmployee: EmployeeUtil[];
}

export interface Project {
  id: number;
  name: string;
  client_name: string;
  status: string;
  budget_hours: number;
  hourly_rate: number;
  cost_rate: number;
  due_date: string;
  lead_name: string;
  logged_hours: number;
  billed_revenue: number;
  labor_cost: number;
  task_total: number;
  task_done: number;
}

export interface Milestone {
  id: number;
  project_id: number;
  project_name: string;
  title: string;
  target_date: string;
  bill_amount: number;
  reached: number;
}

export interface Subtask {
  text: string;
  done: boolean;
}

export interface Task {
  id: number;
  project_id: number;
  project_name: string;
  title: string;
  stage: string;
  priority: string;
  assignee: string;
  estimate_hours: number;
  logged_hours: number;
  due_date: string;
  subtasks: Subtask[];
}

export interface Timesheet {
  id: number;
  project_id: number;
  project_name: string;
  task_title: string;
  hourly_rate: number;
  employee_name: string;
  work_date: string;
  hours: number;
  billable: number;
  note: string;
}

export const TASK_STAGES = ['Backlog', 'In Progress', 'Review', 'Done'] as const;
