export interface Technician {
  id: number;
  name: string;
  specialty: string;
  phone: string;
  territory: string;
  hourly_rate: number;
  active: number;
}

export interface PartLine {
  name: string;
  qty: number;
  unitPrice: number;
}

export interface WorkOrder {
  id: number;
  wo_number: string;
  title: string;
  customer_name: string;
  site_address: string;
  technician_id: number;
  technician_name: string;
  priority: 'Normal' | 'High' | 'Urgent';
  stage: 'Scheduled' | 'En Route' | 'In Progress' | 'Completed';
  scheduled_date: string;
  est_hours: number;
  actual_hours: number;
  parts: PartLine[];
  labor_total: number;
  parts_total: number;
  customer_signed_by: string;
  notes: string;
  created_at: string;
}

export interface Appointment {
  id: number;
  ref_code: string;
  service_type: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  technician_name: string;
  appt_date: string;
  start_time: string;
  duration_min: number;
  status: 'Confirmed' | 'Checked In' | 'Completed' | 'Cancelled';
  notes: string;
}

export interface Shift {
  id: number;
  technician_id: number;
  technician_name: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  role_label: string;
  location: string;
  hours: number;
  published: number;
}

export interface FieldOverview {
  openWorkOrders: number;
  urgentCount: number;
  completedRevenue: number;
  upcomingAppointments: number;
  plannedHours: number;
  draftShifts: number;
}

export const WO_STAGES: Array<WorkOrder['stage']> = ['Scheduled', 'En Route', 'In Progress', 'Completed'];
