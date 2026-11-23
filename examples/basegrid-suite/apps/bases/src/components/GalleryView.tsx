import React from 'react';
import { formatDateShort, formatMoney, getPillTheme } from '../../../../shared/ui/format';
import { getRecordTitle, resolveFieldValue, type WorkspaceIndex } from '../formula';
import type { FieldMeta, RecordRow } from '../types';

interface GalleryViewProps {
  fields: FieldMeta[];
  records: RecordRow[];
  idx: WorkspaceIndex;
  statusField: FieldMeta | null;
  coverField: FieldMeta | null;
  onOpenRecord: (record: RecordRow) => void;
}

const COVER_GRADIENTS = [
  'linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)',
  'linear-gradient(135deg, #ea580c 0%, #db2777 100%)',
  'linear-gradient(135deg, #0d9488 0%, #0284c7 100%)',
  'linear-gradient(135deg, #4f46e5 0%, #0ea5e9 100%)',
  'linear-gradient(135deg, #059669 0%, #10b981 100%)',
  'linear-gradient(135deg, #d97706 0%, #ef4444 100%)',
];

export const GalleryView: React.FC<GalleryViewProps> = ({
  fields,
  records,
  idx,
  statusField,
  coverField,
  onOpenRecord,
}) => {
  const detailFields = fields
    .filter((f) => !f.is_primary && f.field_type !== 'attachment' && f.id !== statusField?.id)
    .slice(0, 4);

  return (
    <div className="gallery-grid">
      {records.map((rec, i) => {
        const title = getRecordTitle(rec, idx);
        const status = statusField ? String(resolveFieldValue(rec, statusField, idx) ?? '') : '';
        const coverVal = coverField ? String(resolveFieldValue(rec, coverField, idx) ?? '') : '';
        const bg = coverVal.startsWith('linear-gradient') ? coverVal : COVER_GRADIENTS[i % COVER_GRADIENTS.length];
        const statusTheme = getPillTheme(status);

        return (
          <div key={rec.id} className="gallery-card" onClick={() => onOpenRecord(rec)}>
            <div className="gallery-cover" style={{ background: bg }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Record #{rec.id}
                </span>
                {status && (
                  <span
                    className="pill"
                    style={{
                      background: 'rgba(255,255,255,0.94)',
                      color: statusTheme.fg,
                      fontSize: 11,
                    }}
                  >
                    <span className="pill-dot" style={{ background: statusTheme.dot }} />
                    {status}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.25 }}>
                {title}
              </div>
            </div>

            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9 }}>
              {detailFields.map((f) => {
                const raw = resolveFieldValue(rec, f, idx);
                if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
                  return null;
                }
                let rendered: React.ReactNode = String(raw);
                if (f.field_type === 'currency') rendered = <strong>{formatMoney(Number(raw) || 0, f.options.symbol || '$')}</strong>;
                else if (f.field_type === 'date') rendered = formatDateShort(String(raw));
                else if (f.field_type === 'rating') rendered = <span style={{ color: '#f59e0b' }}>{'★'.repeat(Math.min(5, Number(raw) || 0))}</span>;
                else if (f.field_type === 'single_select') {
                  const pt = getPillTheme(String(raw));
                  rendered = <span className="pill" style={{ background: pt.bg, color: pt.fg }}>{String(raw)}</span>;
                } else if (f.field_type === 'multi_select' && Array.isArray(raw)) {
                  rendered = (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {raw.map((x) => {
                        const pt = getPillTheme(String(x));
                        return <span key={String(x)} className="pill" style={{ background: pt.bg, color: pt.fg, fontSize: 10.5 }}>{String(x)}</span>;
                      })}
                    </div>
                  );
                } else if (f.field_type === 'link' && Array.isArray(raw)) {
                  rendered = raw
                    .map((id) => {
                      const target = idx.recordsById.get(Number(id));
                      return target ? getRecordTitle(target, idx) : `#${id}`;
                    })
                    .join(', ');
                } else if (f.field_type === 'lookup' && Array.isArray(raw)) {
                  rendered = raw.join(', ');
                }
                return (
                  <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                    <span style={{ color: 'var(--ink-muted)', flexShrink: 0 }}>{f.name}</span>
                    <span style={{ color: 'var(--ink)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {rendered}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
