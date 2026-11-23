import { useState } from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import type { EventItem, EventRegistration } from '../types';

interface EventsManagerViewProps {
  events: EventItem[];
  selectedEvent: EventItem | null;
  registrations: EventRegistration[];
  onSelectEvent: (ev: EventItem) => Promise<void>;
  onRegisterAttendee: (eventId: number, payload: { attendee_name: string; attendee_email: string; company: string; ticket_tier: string }) => Promise<void>;
  onToggleCheckIn: (regId: number) => Promise<void>;
}

export function EventsManagerView({
  events,
  selectedEvent,
  registrations,
  onSelectEvent,
  onRegisterAttendee,
  onToggleCheckIn,
}: EventsManagerViewProps) {
  const [form, setForm] = useState({ attendee_name: '', attendee_email: '', company: '', ticket_tier: 'Standard' });

  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header"><h2>Published Events &amp; Capacity</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {events.map((ev) => {
            const pct = ev.capacity > 0 ? Math.min(100, Math.round((ev.registered_count / ev.capacity) * 100)) : 0;
            return (
              <div
                key={ev.id}
                className="kanban-card"
                style={{ borderColor: selectedEvent?.id === ev.id ? '#9333ea' : undefined }}
                onClick={() => void onSelectEvent(ev)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="badge badge-accent">{ev.category}</span>
                  <strong>{ev.ticket_price > 0 ? formatMoney(ev.ticket_price) : 'Free'}</strong>
                </div>
                <div className="kanban-card-title">{ev.title}</div>
                <div className="kanban-card-sub">{ev.event_date} · {ev.location}</div>
                <div className="progress"><div className="progress-fill" style={{ width: `${pct}%`, background: '#9333ea' }} /></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span>{ev.registered_count} / {ev.capacity} seats booked</span>
                  <span style={{ color: '#059669' }}>{ev.checked_in_count} checked in</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        {selectedEvent ? (
          <>
            <div className="panel-header">
              <div>
                <h2>{selectedEvent.title}</h2>
                <div className="muted" style={{ fontSize: '12px' }}>{selectedEvent.description}</div>
              </div>
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <form
                style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: '10px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  await onRegisterAttendee(selectedEvent.id, form);
                  setForm({ attendee_name: '', attendee_email: '', company: '', ticket_tier: 'Standard' });
                }}
              >
                <strong style={{ fontSize: '12.5px', color: '#6b21a8' }}>Register New Attendee</strong>
                <div className="form-grid">
                  <input className="input" required placeholder="Attendee Name *" value={form.attendee_name} onChange={(e) => setForm({ ...form, attendee_name: e.target.value })} />
                  <input className="input" required type="email" placeholder="Email *" value={form.attendee_email} onChange={(e) => setForm({ ...form, attendee_email: e.target.value })} />
                  <input className="input" placeholder="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <select className="select" style={{ flex: 1 }} value={form.ticket_tier} onChange={(e) => setForm({ ...form, ticket_tier: e.target.value })}>
                      <option value="Standard">Standard</option>
                      <option value="VIP">VIP</option>
                      <option value="Speaker">Speaker</option>
                    </select>
                    <button type="submit" className="btn btn-primary btn-sm">Issue Ticket</button>
                  </div>
                </div>
              </form>

              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Badge</th>
                      <th>Attendee</th>
                      <th>Tier</th>
                      <th>Check-In</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registrations.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{r.ticket_code}</strong></td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{r.attendee_name}</div>
                          <div className="muted" style={{ fontSize: '11.5px' }}>{r.company || r.attendee_email}</div>
                        </td>
                        <td><span className="badge badge-neutral">{r.ticket_tier}</span></td>
                        <td>
                          <button
                            type="button"
                            className={`btn btn-sm ${r.checked_in ? 'btn-success' : 'btn-primary'}`}
                            onClick={() => void onToggleCheckIn(r.id)}
                          >
                            {r.checked_in ? '✓ Checked In' : 'Check In'}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {registrations.length === 0 && (
                      <tr><td colSpan={4} className="empty-state">No registrations yet for this event.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">Select an event to manage registrations and door check-ins.</div>
        )}
      </div>
    </div>
  );
}
