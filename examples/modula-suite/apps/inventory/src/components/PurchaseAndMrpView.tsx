import React from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import type { Bom, ManufacturingOrder, PurchaseOrder } from '../types';

function poBadge(status: string): string {
  if (status === 'Received' || status === 'Done') return 'badge-success';
  if (status === 'Confirmed') return 'badge-info';
  return 'badge-warning';
}

export const PurchaseOrdersView: React.FC<{
  pos: PurchaseOrder[];
  onConfirm: (id: number) => Promise<void>;
  onReceive: (id: number) => Promise<void>;
}> = ({ pos, onConfirm, onReceive }) => (
  <div className="panel">
    <div className="panel-header">
      <h2>Purchase Orders &amp; Atomic Receiving</h2>
      <span className="muted" style={{ fontSize: '12px' }}>Receiving increments SKU stock &amp; writes a double-entry Receipt atomically</span>
    </div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>PO #</th><th>Vendor</th><th>Product</th><th className="num">Qty</th><th className="num">Total</th><th>Expected</th><th>Status</th><th>Workflow</th></tr>
        </thead>
        <tbody>
          {pos.map((po) => (
            <tr key={po.id}>
              <td><strong>{po.po_number}</strong></td>
              <td>{po.vendor_name}</td>
              <td><code>{po.product_sku}</code> {po.product_name}</td>
              <td className="num">{po.qty}</td>
              <td className="num"><strong>{formatMoney(Number(po.total))}</strong></td>
              <td>{po.expected_date}</td>
              <td><span className={`badge ${poBadge(po.status)}`}>{po.status}</span></td>
              <td style={{ display: 'flex', gap: '6px' }}>
                {po.status === 'RFQ' && <button type="button" className="btn btn-sm btn-primary" onClick={() => void onConfirm(po.id)}>Confirm Order</button>}
                {po.status === 'Confirmed' && <button type="button" className="btn btn-sm btn-success" onClick={() => void onReceive(po.id)}>Receive Goods</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

export const MrpView: React.FC<{
  boms: Bom[];
  orders: ManufacturingOrder[];
  onProduce: (id: number) => Promise<void>;
}> = ({ boms, orders, onProduce }) => (
  <div className="split-2">
    <div className="panel">
      <div className="panel-header"><h2>Manufacturing Orders (MRP)</h2></div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>MO #</th><th>Finished Good</th><th className="num">Qty</th><th>Work Center</th><th>Status</th><th>Action</th></tr>
          </thead>
          <tbody>
            {orders.map((mo) => (
              <tr key={mo.id}>
                <td><strong>{mo.mo_number}</strong></td>
                <td><code>{mo.finished_sku}</code> {mo.finished_name}</td>
                <td className="num"><strong>{mo.qty_to_produce}</strong></td>
                <td>{mo.work_center}</td>
                <td><span className={`badge ${poBadge(mo.status)}`}>{mo.status}</span></td>
                <td>
                  {mo.status !== 'Done' ? (
                    <button type="button" className="btn btn-sm btn-success" onClick={() => void onProduce(mo.id)}>Produce &amp; Complete</button>
                  ) : (
                    <span className="muted" style={{ fontSize: '12px' }}>Built</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>

    <div className="panel">
      <div className="panel-header"><h2>Bills of Materials (BoMs)</h2></div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {boms.map((b) => (
          <div key={b.id} className="chatter-item">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{b.code} — {b.finished_name}</strong>
              <span className="badge badge-accent">{b.work_center}</span>
            </div>
            <div className="muted" style={{ fontSize: '12px' }}>Consumes per finished kit:</div>
            <ul style={{ margin: '2px 0 0', paddingLeft: '18px', fontSize: '12.5px' }}>
              {b.components.map((c) => <li key={c.sku}><code>{c.sku}</code> {c.name} × <strong>{c.qty}</strong></li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  </div>
);
