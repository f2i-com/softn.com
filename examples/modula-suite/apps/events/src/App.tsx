import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatMoney, formatPercent } from '../../../shared/ui/format';
import { AcademyView } from './components/AcademyView';
import { EventsManagerView } from './components/EventsManagerView';
import { SurveysView } from './components/SurveysView';
import type {
  CourseItem,
  EventItem,
  EventRegistration,
  EventsOverview,
  LessonItem,
  SurveyItem,
  SurveyResponse,
} from './types';

export function App() {
  const [tab, setTab] = useState<'events' | 'surveys' | 'academy'>('events');
  const [overview, setOverview] = useState<EventsOverview | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const [registrations, setRegistrations] = useState<EventRegistration[]>([]);

  const [surveys, setSurveys] = useState<SurveyItem[]>([]);
  const [selectedSurvey, setSelectedSurvey] = useState<SurveyItem | null>(null);
  const [responses, setResponses] = useState<SurveyResponse[]>([]);

  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<CourseItem | null>(null);
  const [lessons, setLessons] = useState<LessonItem[]>([]);

  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const selectedIdsRef = useRef<{ eventId: number | null; surveyId: number | null; courseId: number | null }>({
    eventId: null,
    surveyId: null,
    courseId: null,
  });

  const [showNewEvent, setShowNewEvent] = useState(false);
  const [eventForm, setEventForm] = useState({ title: '', category: 'Conference', event_date: '2026-12-22', location: 'Online Live', capacity: '80', ticket_price: '49', description: '' });

  const [showNewSurvey, setShowNewSurvey] = useState(false);
  const [surveyForm, setSurveyForm] = useState({ title: '', kind: 'NPS', prompt_text: 'How likely are you (0-10) to recommend this workflow?' });

  const [showNewCourse, setShowNewCourse] = useState(false);
  const [courseForm, setCourseForm] = useState({ title: '', category: 'Operations', instructor_name: 'Alex Rivera', level: 'Beginner', duration_min: '30', description: '' });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const selectEvent = useCallback(async (ev: EventItem) => {
    selectedIdsRef.current.eventId = ev.id;
    setSelectedEvent(ev);
    const res = await apiFetch<{ registrations: EventRegistration[] }>(`/api/events/${ev.id}/registrations`);
    setRegistrations(res.registrations);
  }, []);

  const selectSurvey = useCallback(async (s: SurveyItem) => {
    selectedIdsRef.current.surveyId = s.id;
    setSelectedSurvey(s);
    const res = await apiFetch<{ responses: SurveyResponse[] }>(`/api/surveys/${s.id}/responses`);
    setResponses(res.responses);
  }, []);

  const selectCourse = useCallback(async (c: CourseItem) => {
    selectedIdsRef.current.courseId = c.id;
    setSelectedCourse(c);
    const res = await apiFetch<{ lessons: LessonItem[] }>(`/api/courses/${c.id}/lessons`);
    setLessons(res.lessons);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, eRes, sRes, cRes, rt] = await Promise.all([
        apiFetch<EventsOverview>('/api/overview'),
        apiFetch<{ events: EventItem[] }>('/api/events'),
        apiFetch<{ surveys: SurveyItem[] }>('/api/surveys'),
        apiFetch<{ courses: CourseItem[] }>('/api/courses'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setEvents(eRes.events);
      setSurveys(sRes.surveys);
      setCourses(cRes.courses);
      setRuntime(rt);

      const evTarget = eRes.events.find((e) => e.id === selectedIdsRef.current.eventId) ?? eRes.events[0] ?? null;
      if (evTarget) await selectEvent(evTarget);

      const svTarget = sRes.surveys.find((s) => s.id === selectedIdsRef.current.surveyId) ?? sRes.surveys[0] ?? null;
      if (svTarget) await selectSurvey(svTarget);

      const crTarget = cRes.courses.find((c) => c.id === selectedIdsRef.current.courseId) ?? cRes.courses[0] ?? null;
      if (crTarget) await selectCourse(crTarget);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectCourse, selectEvent, selectSurvey]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#9333ea', ['--accent-soft' as string]: '#f3e8ff', ['--accent-ink' as string]: '#6b21a8' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">EV</div>
          <div>
            <h1>Events, Surveys &amp; eLearning</h1>
            <div className="erp-brand-sub">Event Ticketing &amp; Check-In, Live NPS Surveys &amp; Self-Hosted Academy</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="Events and Learning sections">
          <button type="button" className={`erp-tab ${tab === 'events' ? 'active' : ''}`} onClick={() => setTab('events')}>Events ({events.length})</button>
          <button type="button" className={`erp-tab ${tab === 'surveys' ? 'active' : ''}`} onClick={() => setTab('surveys')}>Surveys &amp; NPS ({surveys.length})</button>
          <button type="button" className={`erp-tab ${tab === 'academy' ? 'active' : ''}`} onClick={() => setTab('academy')}>eLearning ({courses.length})</button>
        </nav>

        <div className="erp-actions">
          {tab === 'events' && <button type="button" className="btn btn-primary" onClick={() => setShowNewEvent(true)}>+ Event</button>}
          {tab === 'surveys' && <button type="button" className="btn btn-primary" onClick={() => setShowNewSurvey(true)}>+ Survey</button>}
          {tab === 'academy' && <button type="button" className="btn btn-primary" onClick={() => setShowNewCourse(true)}>+ Course</button>}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Published Events</span>
              <span className="kpi-value">{overview.publishedEvents}</span>
              <span className="kpi-sub">{overview.totalRegistrations} registered · {overview.checkedInCount} checked in</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Ticket Revenue</span>
              <span className="kpi-value" style={{ color: '#059669' }}>{formatMoney(overview.ticketRevenue)}</span>
              <span className="kpi-sub">Instant badge generation</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Live NPS Score</span>
              <span className="kpi-value" style={{ color: '#9333ea' }}>{overview.npsScore >= 0 ? `+${overview.npsScore}` : overview.npsScore}</span>
              <span className="kpi-sub">{overview.responseCount} verified survey responses</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Academy Progress</span>
              <span className="kpi-value">{formatPercent(overview.completionRate)}</span>
              <span className="kpi-sub">{overview.coursesCount} published courses</span>
            </div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading Events, Surveys &amp; Academy from PHP + XDB SQLite...</div></div>
        ) : tab === 'events' ? (
          <EventsManagerView
            events={events}
            selectedEvent={selectedEvent}
            registrations={registrations}
            onSelectEvent={selectEvent}
            onRegisterAttendee={async (eventId, payload) => {
              await apiFetch(`/api/events/${eventId}/registrations`, { method: 'POST', body: payload });
              await loadAll();
              notify('Attendee ticket issued');
            }}
            onToggleCheckIn={async (regId) => {
              await apiFetch(`/api/registrations/${regId}/checkin`, { method: 'PATCH' });
              await loadAll();
              notify('Check-in status updated');
            }}
          />
        ) : tab === 'surveys' ? (
          <SurveysView
            surveys={surveys}
            selectedSurvey={selectedSurvey}
            responses={responses}
            onSelectSurvey={selectSurvey}
            onSubmitResponse={async (surveyId, payload) => {
              await apiFetch(`/api/surveys/${surveyId}/responses`, { method: 'POST', body: payload });
              await loadAll();
              notify('Survey response recorded');
            }}
          />
        ) : (
          <AcademyView
            courses={courses}
            selectedCourse={selectedCourse}
            lessons={lessons}
            onSelectCourse={selectCourse}
            onToggleLesson={async (lessonId) => {
              await apiFetch(`/api/lessons/${lessonId}/toggle`, { method: 'PATCH' });
              await loadAll();
              notify('Lesson progress saved');
            }}
          />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Events, Surveys &amp; eLearning · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewEvent && (
        <div className="modal-backdrop" onClick={() => setShowNewEvent(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/events', { method: 'POST', body: { ...eventForm, capacity: Number(eventForm.capacity) || 100, ticket_price: Number(eventForm.ticket_price) || 0 } });
              setShowNewEvent(false);
              setEventForm({ title: '', category: 'Conference', event_date: '2026-12-22', location: 'Online Live', capacity: '80', ticket_price: '49', description: '' });
              await loadAll();
              notify('Event published');
            }}
          >
            <div className="modal-head"><h3>Create Event</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewEvent(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Event Title *</label><input className="input" required value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} /></div>
                <div className="field"><label>Category</label><select className="select" value={eventForm.category} onChange={(e) => setEventForm({ ...eventForm, category: e.target.value })}><option value="Conference">Conference</option><option value="Workshop">Workshop</option><option value="Webinar">Webinar</option><option value="Launch">Launch</option></select></div>
                <div className="field"><label>Date</label><input className="input" type="date" value={eventForm.event_date} onChange={(e) => setEventForm({ ...eventForm, event_date: e.target.value })} /></div>
                <div className="field full"><label>Location</label><input className="input" value={eventForm.location} onChange={(e) => setEventForm({ ...eventForm, location: e.target.value })} /></div>
                <div className="field"><label>Capacity</label><input className="input" type="number" value={eventForm.capacity} onChange={(e) => setEventForm({ ...eventForm, capacity: e.target.value })} /></div>
                <div className="field"><label>Ticket Price ($)</label><input className="input" type="number" step="0.01" value={eventForm.ticket_price} onChange={(e) => setEventForm({ ...eventForm, ticket_price: e.target.value })} /></div>
                <div className="field full"><label>Description</label><textarea className="textarea" value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewEvent(false)}>Cancel</button><button type="submit" className="btn btn-primary">Publish Event</button></div>
          </form>
        </div>
      )}

      {showNewSurvey && (
        <div className="modal-backdrop" onClick={() => setShowNewSurvey(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/surveys', { method: 'POST', body: surveyForm });
              setShowNewSurvey(false);
              setSurveyForm({ title: '', kind: 'NPS', prompt_text: 'How likely are you (0-10) to recommend this workflow?' });
              await loadAll();
              notify('Survey published');
            }}
          >
            <div className="modal-head"><h3>Create Live Survey</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewSurvey(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Survey Title *</label><input className="input" required value={surveyForm.title} onChange={(e) => setSurveyForm({ ...surveyForm, title: e.target.value })} /></div>
                <div className="field"><label>Survey Type</label><select className="select" value={surveyForm.kind} onChange={(e) => setSurveyForm({ ...surveyForm, kind: e.target.value })}><option value="NPS">NPS (0-10)</option><option value="CSAT">CSAT</option><option value="Product Feedback">Product Feedback</option><option value="Employee Pulse">Employee Pulse</option></select></div>
                <div className="field full"><label>Question Prompt</label><textarea className="textarea" value={surveyForm.prompt_text} onChange={(e) => setSurveyForm({ ...surveyForm, prompt_text: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewSurvey(false)}>Cancel</button><button type="submit" className="btn btn-primary">Launch Survey</button></div>
          </form>
        </div>
      )}

      {showNewCourse && (
        <div className="modal-backdrop" onClick={() => setShowNewCourse(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/courses', { method: 'POST', body: { ...courseForm, duration_min: Number(courseForm.duration_min) || 30 } });
              setShowNewCourse(false);
              setCourseForm({ title: '', category: 'Operations', instructor_name: 'Alex Rivera', level: 'Beginner', duration_min: '30', description: '' });
              await loadAll();
              notify('Course published to Academy');
            }}
          >
            <div className="modal-head"><h3>Publish Academy Course</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewCourse(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Course Title *</label><input className="input" required value={courseForm.title} onChange={(e) => setCourseForm({ ...courseForm, title: e.target.value })} /></div>
                <div className="field"><label>Category</label><input className="input" value={courseForm.category} onChange={(e) => setCourseForm({ ...courseForm, category: e.target.value })} /></div>
                <div className="field"><label>Level</label><select className="select" value={courseForm.level} onChange={(e) => setCourseForm({ ...courseForm, level: e.target.value })}><option value="Beginner">Beginner</option><option value="Intermediate">Intermediate</option><option value="Advanced">Advanced</option></select></div>
                <div className="field"><label>Instructor</label><input className="input" value={courseForm.instructor_name} onChange={(e) => setCourseForm({ ...courseForm, instructor_name: e.target.value })} /></div>
                <div className="field"><label>Duration (min)</label><input className="input" type="number" value={courseForm.duration_min} onChange={(e) => setCourseForm({ ...courseForm, duration_min: e.target.value })} /></div>
                <div className="field full"><label>Course Summary</label><textarea className="textarea" value={courseForm.description} onChange={(e) => setCourseForm({ ...courseForm, description: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewCourse(false)}>Cancel</button><button type="submit" className="btn btn-primary">Publish Course</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
