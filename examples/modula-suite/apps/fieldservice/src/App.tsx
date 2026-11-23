import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatMoney } from '../../../shared/ui/format';
import { AppointmentsView } from './components/AppointmentsView';
import { DispatchBoardView } from './components/DispatchBoardView';
import { ShiftPlannerView } from './components/ShiftPlannerView';
import type { Appointment, FieldOverview, Shift, Technician, WorkOrder } from './types';

export function App() {
  const [tab, setTab] = useState<'dispatch' | 'appointments' | 'planning'>('dispatch');
  const [overview, setOverview] = useState<FieldOverview | null>(null);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showNewWo, setShowNewWo] = useState(false);
  const [woForm, setWoForm] = useState({ title: '', customer_name: '', site_address: '', technician_id: '1', priority: 'High', scheduled_date: '2026-11-23', est_hours: '2.5', notes: '' });

  const [showNewAppt, setShowNewAppt] = useState(false);
  const [apptForm, setApptForm] = useState({ service_type: 'On-Site Consultation', customer_name: '', customer_phone: '', technician_name: 'Daniel Brooks', appt_date: '2026-11-23', start_time: '11:00', duration_min: '45', notes: '' });

  const [showNewShift, setShowNewShift] = useState(false);
  const [shiftForm, setShiftForm] = useState({ technician_id: '1', shift_date: '2026-11-25', start_time: '08:00', end_time: '16:30', role_label: 'Field Dispatch', location: 'Metro North', hours: '8' });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, tRes, wRes, aRes, sRes, rt] = await Promise.all([
        apiFetch<FieldOverview>('/api/overview'),
        apiFetch<{ technicians: Technician[] }>('/api/technicians'),
        apiFetch<{ workOrders: WorkOrder[] }>('/api/work-orders'),
        apiFetch<{ appointments: Appointment[] }>('/api/appointments'),
        apiFetch<{ shifts: Shift[] }>('/api/shifts'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setTechnicians(tRes.technicians);
      setWorkOrders(wRes.workOrders);
      setAppointments(aRes.appointments);
      setShifts(sRes.shifts);
      setRuntime(rt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#0891b2', ['--accent-soft' as string]: '#cffafe', ['--accent-ink' as string]: '#155e75' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">FS</div>
          <div>
            <h1>Field Service, Appointments &amp; Planning</h1>
            <div className="erp-brand-sub">Technician Dispatch Kanban, Slot Bookings &amp; Shift Capacity Roster</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="Field Service sections">
          <button type="button" className={`erp-tab ${tab === 'dispatch' ? 'active' : ''}`} onClick={() => setTab('dispatch')}>Dispatch Board ({workOrders.length})</button>
          <button type="button" className={`erp-tab ${tab === 'appointments' ? 'active' : ''}`} onClick={() => setTab('appointments')}>Appointments ({appointments.length})</button>
          <button type="button" className={`erp-tab ${tab === 'planning' ? 'active' : ''}`} onClick={() => setTab('planning')}>Shift Planning ({shifts.length})</button>
        </nav>

        <div className="erp-actions">
          {tab === 'dispatch' && <button type="button" className="btn btn-primary" onClick={() => setShowNewWo(true)}>+ Work Order</button>}
          {tab === 'appointments' && <button type="button" className="btn btn-primary" onClick={() => setShowNewAppt(true)}>+ Appointment</button>}
          {tab === 'planning' && <button type="button" className="btn btn-primary" onClick={() => setShowNewShift(true)}>+ Shift</button>}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Active Work Orders</span>
              <span className="kpi-value">{overview.openWorkOrders}</span>
              <span className="kpi-sub">{overview.urgentCount} urgent priority</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Completed Job Billing</span>
              <span className="kpi-value" style={{ color: '#059669' }}>{formatMoney(overview.completedRevenue)}</span>
              <span className="kpi-sub">Signed labor + parts total</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Upcoming Appointments</span>
              <span className="kpi-value">{overview.upcomingAppointments}</span>
              <span className="kpi-sub">Conflict-checked calendar slots</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Planned Roster Hours</span>
              <span className="kpi-value" style={{ color: '#0891b2' }}>{overview.plannedHours}h</span>
              <span className="kpi-sub">{overview.draftShifts} unpublished draft shift(s)</span>
            </div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading Field Service &amp; Planning from PHP + XDB SQLite...</div></div>
        ) : tab === 'dispatch' ? (
          <DispatchBoardView
            workOrders={workOrders}
            onStageChange={async (id, stage) => {
              await apiFetch(`/api/work-orders/${id}/stage`, { method: 'PATCH', body: { stage } });
              await loadAll();
              notify(`Work order moved to ${stage}`);
            }}
            onComplete={async (id, payload) => {
              await apiFetch(`/api/work-orders/${id}/complete`, { method: 'POST', body: payload });
              await loadAll();
              notify('Work order signed off & billed');
            }}
          />
        ) : tab === 'appointments' ? (
          <AppointmentsView
            appointments={appointments}
            onOpenNew={() => setShowNewAppt(true)}
            onStatusChange={async (id, status) => {
              await apiFetch(`/api/appointments/${id}/status`, { method: 'PATCH', body: { status } });
              await loadAll();
              notify(`Appointment marked ${status}`);
            }}
          />
        ) : (
          <ShiftPlannerView
            shifts={shifts}
            technicians={technicians}
            onOpenNewShift={() => setShowNewShift(true)}
            onPublishShift={async (id) => {
              await apiFetch(`/api/shifts/${id}/publish`, { method: 'PATCH' });
              await loadAll();
              notify('Shift published to crew');
            }}
            onPublishAll={async () => {
              await apiFetch('/api/shifts/publish-all', { method: 'POST' });
              await loadAll();
              notify('All draft shifts published');
            }}
          />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Field Service, Appointments &amp; Planning · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewWo && (
        <div className="modal-backdrop" onClick={() => setShowNewWo(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/work-orders', { method: 'POST', body: { ...woForm, technician_id: Number(woForm.technician_id), est_hours: Number(woForm.est_hours) || 2 } });
              setShowNewWo(false);
              setWoForm({ title: '', customer_name: '', site_address: '', technician_id: '1', priority: 'High', scheduled_date: '2026-11-23', est_hours: '2.5', notes: '' });
              await loadAll();
              notify('Field work order dispatched');
            }}
          >
            <div className="modal-head"><h3>Create Field Work Order</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewWo(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Job Title *</label><input className="input" required value={woForm.title} onChange={(e) => setWoForm({ ...woForm, title: e.target.value })} /></div>
                <div className="field"><label>Customer *</label><input className="input" required value={woForm.customer_name} onChange={(e) => setWoForm({ ...woForm, customer_name: e.target.value })} /></div>
                <div className="field"><label>Site Address</label><input className="input" value={woForm.site_address} onChange={(e) => setWoForm({ ...woForm, site_address: e.target.value })} /></div>
                <div className="field">
                  <label>Assign Technician</label>
                  <select className="select" value={woForm.technician_id} onChange={(e) => setWoForm({ ...woForm, technician_id: e.target.value })}>
                    {technicians.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.territory})</option>)}
                  </select>
                </div>
                <div className="field"><label>Priority</label><select className="select" value={woForm.priority} onChange={(e) => setWoForm({ ...woForm, priority: e.target.value })}><option value="Normal">Normal</option><option value="High">High</option><option value="Urgent">Urgent</option></select></div>
                <div className="field"><label>Scheduled Date</label><input className="input" type="date" value={woForm.scheduled_date} onChange={(e) => setWoForm({ ...woForm, scheduled_date: e.target.value })} /></div>
                <div className="field"><label>Est. Hours</label><input className="input" type="number" step="0.5" value={woForm.est_hours} onChange={(e) => setWoForm({ ...woForm, est_hours: e.target.value })} /></div>
                <div className="field full"><label>Dispatch Notes</label><textarea className="textarea" value={woForm.notes} onChange={(e) => setWoForm({ ...woForm, notes: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewWo(false)}>Cancel</button><button type="submit" className="btn btn-primary">Dispatch Work Order</button></div>
          </form>
        </div>
      )}

      {showNewAppt && (
        <div className="modal-backdrop" onClick={() => setShowNewAppt(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await apiFetch('/api/appointments', { method: 'POST', body: { ...apptForm, duration_min: Number(apptForm.duration_min) || 45 } });
                setShowNewAppt(false);
                setApptForm({ service_type: 'On-Site Consultation', customer_name: '', customer_phone: '', technician_name: technicians[0]?.name || 'Daniel Brooks', appt_date: '2026-11-23', start_time: '11:00', duration_min: '45', notes: '' });
                await loadAll();
                notify('Appointment confirmed');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <div className="modal-head"><h3>Book Customer Appointment</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewAppt(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Service Type *</label><input className="input" required value={apptForm.service_type} onChange={(e) => setApptForm({ ...apptForm, service_type: e.target.value })} /></div>
                <div className="field"><label>Customer *</label><input className="input" required value={apptForm.customer_name} onChange={(e) => setApptForm({ ...apptForm, customer_name: e.target.value })} /></div>
                <div className="field"><label>Phone</label><input className="input" value={apptForm.customer_phone} onChange={(e) => setApptForm({ ...apptForm, customer_phone: e.target.value })} /></div>
                <div className="field">
                  <label>Specialist</label>
                  <select className="select" value={apptForm.technician_name} onChange={(e) => setApptForm({ ...apptForm, technician_name: e.target.value })}>
                    {technicians.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                  </select>
                </div>
                <div className="field"><label>Date</label><input className="input" type="date" value={apptForm.appt_date} onChange={(e) => setApptForm({ ...apptForm, appt_date: e.target.value })} /></div>
                <div className="field"><label>Start Time</label><input className="input" type="time" value={apptForm.start_time} onChange={(e) => setApptForm({ ...apptForm, start_time: e.target.value })} /></div>
                <div className="field"><label>Duration (min)</label><input className="input" type="number" step="15" value={apptForm.duration_min} onChange={(e) => setApptForm({ ...apptForm, duration_min: e.target.value })} /></div>
                <div className="field full"><label>Notes</label><textarea className="textarea" value={apptForm.notes} onChange={(e) => setApptForm({ ...apptForm, notes: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewAppt(false)}>Cancel</button><button type="submit" className="btn btn-primary">Confirm Booking</button></div>
          </form>
        </div>
      )}

      {showNewShift && (
        <div className="modal-backdrop" onClick={() => setShowNewShift(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/shifts', { method: 'POST', body: { ...shiftForm, technician_id: Number(shiftForm.technician_id), hours: Number(shiftForm.hours) || 8 } });
              setShowNewShift(false);
              await loadAll();
              notify('Draft shift scheduled');
            }}
          >
            <div className="modal-head"><h3>Assign Team Shift</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewShift(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field">
                  <label>Technician</label>
                  <select className="select" value={shiftForm.technician_id} onChange={(e) => setShiftForm({ ...shiftForm, technician_id: e.target.value })}>
                    {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div className="field"><label>Date</label><input className="input" type="date" value={shiftForm.shift_date} onChange={(e) => setShiftForm({ ...shiftForm, shift_date: e.target.value })} /></div>
                <div className="field"><label>Start</label><input className="input" type="time" value={shiftForm.start_time} onChange={(e) => setShiftForm({ ...shiftForm, start_time: e.target.value })} /></div>
                <div className="field"><label>End</label><input className="input" type="time" value={shiftForm.end_time} onChange={(e) => setShiftForm({ ...shiftForm, end_time: e.target.value })} /></div>
                <div className="field"><label>Role</label><input className="input" value={shiftForm.role_label} onChange={(e) => setShiftForm({ ...shiftForm, role_label: e.target.value })} /></div>
                <div className="field"><label>Hours</label><input className="input" type="number" step="0.5" value={shiftForm.hours} onChange={(e) => setShiftForm({ ...shiftForm, hours: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewShift(false)}>Cancel</button><button type="submit" className="btn btn-primary">Add Draft Shift</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
