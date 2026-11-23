import { useState } from 'react';
import type { SurveyItem, SurveyResponse } from '../types';

interface SurveysViewProps {
  surveys: SurveyItem[];
  selectedSurvey: SurveyItem | null;
  responses: SurveyResponse[];
  onSelectSurvey: (s: SurveyItem) => Promise<void>;
  onSubmitResponse: (surveyId: number, payload: { respondent_name: string; score: number; comment: string }) => Promise<void>;
}

export function SurveysView({
  surveys,
  selectedSurvey,
  responses,
  onSelectSurvey,
  onSubmitResponse,
}: SurveysViewProps) {
  const [respondent, setRespondent] = useState('');
  const [score, setScore] = useState(9);
  const [comment, setComment] = useState('');

  return (
    <div className="split-2">
      <div className="panel">
        <div className="panel-header"><h2>Live Surveys &amp; NPS Polls</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {surveys.map((s) => (
            <div
              key={s.id}
              className="kanban-card"
              style={{ borderColor: selectedSurvey?.id === s.id ? '#9333ea' : undefined }}
              onClick={() => void onSelectSurvey(s)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="badge badge-info">{s.kind}</span>
                <span className={`badge ${s.nps >= 50 ? 'badge-success' : s.nps >= 0 ? 'badge-warning' : 'badge-danger'}`}>
                  NPS {s.nps >= 0 ? `+${s.nps}` : s.nps}
                </span>
              </div>
              <div className="kanban-card-title">{s.title}</div>
              <div className="kanban-card-sub">{s.prompt_text}</div>
              <div className="muted" style={{ fontSize: '12px' }}>
                {s.response_count} responses · avg <strong>{s.avg_score}/10</strong>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        {selectedSurvey ? (
          <>
            <div className="panel-header">
              <div>
                <h2>{selectedSurvey.title}</h2>
                <div className="muted" style={{ fontSize: '12px' }}>{selectedSurvey.prompt_text}</div>
              </div>
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <form
                style={{ background: '#f9fafb', border: '1px solid var(--border)', borderRadius: '10px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  await onSubmitResponse(selectedSurvey.id, { respondent_name: respondent || 'Guest Respondent', score, comment });
                  setRespondent('');
                  setComment('');
                }}
              >
                <strong style={{ fontSize: '12.5px' }}>Record Live Survey Response</strong>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`btn btn-sm ${score === n ? 'btn-primary' : ''}`}
                      style={{ minWidth: '34px' }}
                      onClick={() => setScore(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="form-grid">
                  <input className="input" placeholder="Respondent Name" value={respondent} onChange={(e) => setRespondent(e.target.value)} />
                  <input className="input" placeholder="Feedback comment..." value={comment} onChange={(e) => setComment(e.target.value)} />
                </div>
                <div>
                  <button type="submit" className="btn btn-primary btn-sm">Submit Score ({score}/10)</button>
                </div>
              </form>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {responses.map((r) => (
                  <div key={r.id} className="chatter-item">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{r.respondent_name}</strong>
                      <span className={`badge ${r.score >= 9 ? 'badge-success' : r.score >= 7 ? 'badge-warning' : 'badge-danger'}`}>
                        Score {r.score}/10
                      </span>
                    </div>
                    {r.comment && <div style={{ fontSize: '13px' }}>{r.comment}</div>}
                    <div className="muted" style={{ fontSize: '11px' }}>{r.created_at}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">Select a survey to view analytics or submit a response.</div>
        )}
      </div>
    </div>
  );
}
