import { useState } from 'react';
import type { CourseItem, LessonItem } from '../types';

interface AcademyViewProps {
  courses: CourseItem[];
  selectedCourse: CourseItem | null;
  lessons: LessonItem[];
  onSelectCourse: (c: CourseItem) => Promise<void>;
  onToggleLesson: (lessonId: number) => Promise<void>;
}

export function AcademyView({
  courses,
  selectedCourse,
  lessons,
  onSelectCourse,
  onToggleLesson,
}: AcademyViewProps) {
  const [openLessonId, setOpenLessonId] = useState<number | null>(null);

  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header"><h2>eLearning Course Catalog</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {courses.map((c) => {
            const pct = c.lesson_count > 0 ? Math.round((c.completed_count / c.lesson_count) * 100) : 0;
            return (
              <div
                key={c.id}
                className="kanban-card"
                style={{ borderColor: selectedCourse?.id === c.id ? '#9333ea' : undefined }}
                onClick={() => void onSelectCourse(c)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="badge badge-accent">{c.category}</span>
                  <span className="badge badge-neutral">{c.level} · {c.duration_min}m</span>
                </div>
                <div className="kanban-card-title">{c.title}</div>
                <div className="kanban-card-sub">Instructor: {c.instructor_name}</div>
                <div className="progress"><div className="progress-fill" style={{ width: `${pct}%`, background: '#059669' }} /></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span>{c.completed_count} / {c.lesson_count} lessons completed</span>
                  <strong>{pct}%</strong>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        {selectedCourse ? (
          <>
            <div className="panel-header">
              <div>
                <h2>{selectedCourse.title}</h2>
                <div className="muted" style={{ fontSize: '12px' }}>{selectedCourse.description}</div>
              </div>
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {lessons.map((l) => {
                const expanded = openLessonId === l.id || openLessonId === null;
                return (
                  <div key={l.id} className="chatter-item">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                      <div style={{ cursor: 'pointer' }} onClick={() => setOpenLessonId(openLessonId === l.id ? -1 : l.id)}>
                        <span className="badge badge-info" style={{ marginRight: '8px' }}>{l.lesson_type}</span>
                        <strong>{l.position}. {l.title}</strong>
                        <span className="muted" style={{ fontSize: '11.5px', marginLeft: '8px' }}>({l.duration_min} min)</span>
                      </div>
                      <button
                        type="button"
                        className={`btn btn-sm ${l.completed ? 'btn-success' : ''}`}
                        onClick={() => void onToggleLesson(l.id)}
                      >
                        {l.completed ? '✓ Completed' : 'Mark Complete'}
                      </button>
                    </div>
                    {expanded && (
                      <div style={{ fontSize: '13px', color: 'var(--ink-secondary)', paddingTop: '6px' }}>
                        {l.content_text}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="empty-state">Select a course to study lessons and track progress.</div>
        )}
      </div>
    </div>
  );
}
