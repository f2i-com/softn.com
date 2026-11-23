import { useState } from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import { WO_STAGES, type WorkOrder } from '../types';

interface DispatchBoardViewProps {
  workOrders: WorkOrder[];
  onStageChange: (id: number, stage: WorkOrder['stage']) => Promise<void>;
  onComplete: (id: number, payload: { actual_hours: number; customer_signed_by: string; part_name: string; part_qty: number; part_price: number; notes: string }) => Promise<void>;
}

export function DispatchBoardView({ workOrders, onStageChange, onComplete }: DispatchBoardViewProps) {
  const [closingWo, setClosingWo] = useState<WorkOrder | null>(null);
  const [actualHours, setActualHours] = useState('2.5');
  const [signedBy, setSignedBy] = useState('');
  const [partName, setPartName] = useState('');
  const [partQty, setPartQty] = useState('1');
  const [partPrice, setPartPrice] = useState('0');
  const [notes, setNotes] = useState('');

  const openSignOff = (wo: WorkOrder) => {
    setClosingWo(wo);
    setActualHours(String(wo.est_hours || 2));
    setSignedBy('');
    setPartName('');
    setPartQty('1');
    setPartPrice('0');
    setNotes(wo.notes || '');
  };

  return (
    <>
      <div className="kanban">
        {WO_STAGES.map((stage) => {
          const cards = workOrders.filter((w) => w.stage === stage);
          return (
            <div key={stage} className="kanban-col">
              <div className="kanban-col-head">
                <span className="kanban-col-title">{stage} <span className="badge badge-neutral">{cards.length}</span></span>
              </div>
              {cards.map((wo) => {
                const idx = WO_STAGES.indexOf(wo.stage);
                const nextStage = idx >= 0 && idx < WO_STAGES.length - 1 ? WO_STAGES[idx + 1] : null;
                return (
                  <div key={wo.id} className="kanban-card" style={{ cursor: 'default' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                      <strong style={{ fontSize: '12px', color: '#0891b2' }}>{wo.wo_number}</strong>
                      <span className={`badge ${wo.priority === 'Urgent' ? 'badge-danger' : wo.priority === 'High' ? 'badge-warning' : 'badge-neutral'}`}>
                        {wo.priority}
                      </span>
                    </div>
                    <div className="kanban-card-title">{wo.title}</div>
                    <div className="kanban-card-sub">{wo.customer_name}</div>
                    {wo.site_address && <div className="muted" style={{ fontSize: '11.5px' }}>{wo.site_address}</div>}
                    <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
                      <span>Tech: <strong>{wo.technician_name}</strong></span>
                      <span className="muted" style={{ whiteSpace: 'nowrap' }}>{wo.scheduled_date}</span>
                    </div>
                    {wo.stage === 'Completed' ? (
                      <div style={{ fontSize: '12px', paddingTop: '6px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#059669' }}>Signed: {wo.customer_signed_by}</span>
                        <strong>{formatMoney(wo.labor_total + wo.parts_total)}</strong>
                      </div>
                    ) : (
                      <div className="kanban-card-foot">
                        <span className="muted" style={{ fontSize: '11.5px' }}>Est {wo.est_hours}h</span>
                        {nextStage === 'Completed' ? (
                          <button type="button" className="btn btn-sm btn-success" onClick={() => openSignOff(wo)}>Sign Off &amp; Complete</button>
                        ) : nextStage ? (
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => void onStageChange(wo.id, nextStage)}>
                            {nextStage} →
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
              {cards.length === 0 && <div className="empty-state">No jobs in {stage}</div>}
            </div>
          );
        })}
      </div>

      {closingWo && (
        <div className="modal-backdrop" onClick={() => setClosingWo(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await onComplete(closingWo.id, {
                actual_hours: Number(actualHours) || closingWo.est_hours,
                customer_signed_by: signedBy,
                part_name: partName,
                part_qty: Number(partQty) || 0,
                part_price: Number(partPrice) || 0,
                notes,
              });
              setClosingWo(null);
            }}
          >
            <div className="modal-head">
              <h3>Complete &amp; Sign Off {closingWo.wo_number}</h3>
              <button type="button" className="btn btn-sm" onClick={() => setClosingWo(null)}>Cancel</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Actual Billable Hours *</label><input className="input" type="number" step="0.25" required value={actualHours} onChange={(e) => setActualHours(e.target.value)} /></div>
                <div className="field"><label>Customer Signed By *</label><input className="input" required placeholder="e.g. Store Manager Name" value={signedBy} onChange={(e) => setSignedBy(e.target.value)} /></div>
                <div className="field full"><label>Additional Part Used (Optional)</label><input className="input" placeholder="e.g. Ethernet Switch 8-Port" value={partName} onChange={(e) => setPartName(e.target.value)} /></div>
                <div className="field"><label>Part Qty</label><input className="input" type="number" min="0" value={partQty} onChange={(e) => setPartQty(e.target.value)} /></div>
                <div className="field"><label>Part Unit Price ($)</label><input className="input" type="number" min="0" step="0.01" value={partPrice} onChange={(e) => setPartPrice(e.target.value)} /></div>
                <div className="field full"><label>Field Completion Notes</label><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setClosingWo(null)}>Cancel</button>
              <button type="submit" className="btn btn-success">Record Sign-Off &amp; Bill</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
