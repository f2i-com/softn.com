import React from 'react';
import { formatMoney, formatPercent } from '../../../../shared/ui/format';
import type { Product, StockMove, Vendor } from '../types';

export const ProductsView: React.FC<{
  products: Product[];
  onAdjust: (p: Product, delta: number) => Promise<void>;
  onQuickReorder: (p: Product) => Promise<void>;
}> = ({ products, onAdjust, onQuickReorder }) => (
  <div className="panel">
    <div className="panel-header"><h2>Warehouse Products &amp; Bin Locations</h2></div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>SKU</th><th>Product</th><th>Bin</th><th className="num">Cost / Sell</th><th className="num">Margin</th><th className="num">On Hand</th><th>Quick Actions</th></tr>
        </thead>
        <tbody>
          {products.map((p) => {
            const low = p.stock_on_hand <= p.reorder_point;
            const margin = p.sale_price > 0 ? ((p.sale_price - p.unit_cost) / p.sale_price) * 100 : 0;
            return (
              <tr key={p.id}>
                <td><code>{p.sku}</code></td>
                <td>
                  <div><strong>{p.name}</strong></div>
                  <div className="muted" style={{ fontSize: '11.5px' }}>{p.category} · {p.vendor_name}</div>
                </td>
                <td><span className="badge badge-neutral">{p.bin_location}</span></td>
                <td className="num">{formatMoney(Number(p.unit_cost))} / {formatMoney(Number(p.sale_price))}</td>
                <td className="num"><span className="badge badge-success">{formatPercent(margin)}</span></td>
                <td className="num"><span className={`badge ${low ? 'badge-danger' : 'badge-success'}`}>{p.stock_on_hand} {low ? `(min ${p.reorder_point})` : 'in stock'}</span></td>
                <td style={{ display: 'flex', gap: '5px' }}>
                  <button type="button" className="btn btn-sm" onClick={() => void onAdjust(p, -1)}>-1</button>
                  <button type="button" className="btn btn-sm" onClick={() => void onAdjust(p, 5)}>+5</button>
                  {low && <button type="button" className="btn btn-sm btn-primary" onClick={() => void onQuickReorder(p)}>Draft PO</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </div>
);

export const StockMovesView: React.FC<{ moves: StockMove[] }> = ({ moves }) => (
  <div className="panel">
    <div className="panel-header"><h2>Double-Entry Stock Moves Audit Ledger</h2></div>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>When</th><th>Reference</th><th>Type</th><th>Product</th><th>From Location</th><th>To Location</th><th className="num">Qty</th></tr>
        </thead>
        <tbody>
          {moves.map((m) => (
            <tr key={m.id}>
              <td>{m.moved_at}</td>
              <td><code>{m.reference}</code></td>
              <td><span className={`badge ${m.move_type === 'Receipt' || m.move_type === 'MRP Produce' ? 'badge-success' : m.move_type === 'Delivery' || m.move_type === 'MRP Consume' ? 'badge-info' : 'badge-warning'}`}>{m.move_type}</span></td>
              <td><strong>{m.product_sku}</strong> · {m.product_name}</td>
              <td>{m.source_loc}</td>
              <td>{m.dest_loc}</td>
              <td className="num"><strong>{m.qty}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

export const VendorsView: React.FC<{ vendors: Vendor[] }> = ({ vendors }) => (
  <div className="card-grid">
    {vendors.map((v) => (
      <div key={v.id} className="panel">
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{v.name}</strong>
            <span className="badge badge-accent">{v.terms}</span>
          </div>
          <div className="muted" style={{ fontSize: '12.5px' }}>Contact: {v.contact} · {v.email}</div>
          <div style={{ fontSize: '12.5px' }}>Lead time: <strong>{v.lead_days} days</strong></div>
        </div>
      </div>
    ))}
  </div>
);
