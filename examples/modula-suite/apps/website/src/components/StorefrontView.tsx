import React, { useState } from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import type { StoreOrder, StoreProduct } from '../types';

interface StorefrontViewProps {
  products: StoreProduct[];
  orders: StoreOrder[];
  onCheckout: (payload: { customer_name: string; customer_email: string; promo_code: string; items: Array<{ product_id: number; qty: number }> }) => Promise<void>;
  onCreateProduct: (prod: { name: string; sku: string; category: string; price: number; stock: number; summary: string }) => Promise<void>;
  onOrderStatus: (id: number, status: string) => Promise<void>;
}

export const StorefrontView: React.FC<StorefrontViewProps> = ({
  products,
  orders,
  onCheckout,
  onCreateProduct,
  onOrderStatus,
}) => {
  const [cart, setCart] = useState<Record<number, number>>({});
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [showAddProd, setShowAddProd] = useState(false);
  const [prodForm, setProdForm] = useState({ name: '', sku: '', category: 'Hardware', price: '199', stock: '15', summary: '' });

  const cartEntries = Object.entries(cart)
    .map(([pid, qty]) => {
      const prod = products.find((p) => p.id === Number(pid));
      return prod && qty > 0 ? { prod, qty } : null;
    })
    .filter((x): x is { prod: StoreProduct; qty: number } => x !== null);

  const subtotal = cartEntries.reduce((sum, e) => sum + e.prod.price * e.qty, 0);
  const cleanPromo = promoCode.trim().toUpperCase();
  const discountRate = cleanPromo === 'MODULA10' ? 0.1 : cleanPromo === 'SAVE20' ? 0.2 : 0;
  const discount = subtotal * discountRate;
  const total = subtotal - discount;

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cartEntries.length === 0) return;
    await onCheckout({
      customer_name: customerName,
      customer_email: customerEmail,
      promo_code: cleanPromo,
      items: cartEntries.map((c) => ({ product_id: c.prod.id, qty: c.qty })),
    });
    setCart({});
    setCustomerName('');
    setCustomerEmail('');
    setPromoCode('');
  };

  return (
    <>
      <div className="toolbar">
        <strong style={{ fontSize: '13.5px' }}>eCommerce Catalog &amp; Fulfillment</strong>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowAddProd(true)}>+ Add Store Product</button>
      </div>

      <div className="split-2">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="card-grid">
            {products.map((p) => (
              <div key={p.id} className="panel">
                <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="badge badge-neutral">{p.category}</span>
                    <span className="muted" style={{ fontSize: '12px' }}>{p.stock} in stock</span>
                  </div>
                  <strong>{p.name}</strong>
                  <div className="muted" style={{ fontSize: '12px' }}>{p.summary}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                    <strong style={{ fontSize: '16px', fontVariantNumeric: 'tabular-nums' }}>{formatMoney(Number(p.price))}</strong>
                    <button type="button" className="btn btn-sm btn-primary" disabled={p.stock <= 0} onClick={() => setCart((prev) => ({ ...prev, [p.id]: (prev[p.id] || 0) + 1 }))}>
                      + Add to Cart
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="panel">
            <div className="panel-header"><h2>Orders &amp; Fulfillment</h2></div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Order</th><th>Customer</th><th>Items</th><th className="num">Total</th><th>Status</th><th>Update</th></tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td><strong>{o.order_number}</strong>{o.promo_code && <div className="muted" style={{ fontSize: '11px' }}>Promo: {o.promo_code}</div>}</td>
                      <td>{o.customer_name}</td>
                      <td>{o.items_summary}</td>
                      <td className="num"><strong>{formatMoney(Number(o.total))}</strong></td>
                      <td>
                        <span className={`badge ${o.status === 'Fulfilled' ? 'badge-success' : o.status === 'Shipped' ? 'badge-info' : o.status === 'Refunded' ? 'badge-danger' : 'badge-warning'}`}>
                          {o.status}
                        </span>
                      </td>
                      <td>
                        <select className="select" style={{ padding: '3px 6px', fontSize: '12px' }} value={o.status} onChange={(e) => void onOrderStatus(o.id, e.target.value)}>
                          {['Confirmed', 'Shipped', 'Fulfilled', 'Refunded'].map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <form className="panel" onSubmit={(e) => void handleCheckout(e)}>
          <div className="panel-header"><h2>Checkout Cart ({cartEntries.reduce((a, b) => a + b.qty, 0)})</h2></div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {cartEntries.length === 0 ? (
              <div className="empty-state">Add products from the storefront. Try promo codes <code>MODULA10</code> or <code>SAVE20</code>!</div>
            ) : (
              <>
                {cartEntries.map(({ prod, qty }) => (
                  <div key={prod.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', borderBottom: '1px solid var(--border)', paddingBottom: '6px' }}>
                    <span>{qty} × {prod.name}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <strong>{formatMoney(prod.price * qty)}</strong>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => setCart((prev) => { const n = { ...prev }; delete n[prod.id]; return n; })}>×</button>
                    </div>
                  </div>
                ))}
                <div className="field">
                  <label>Promo Code (try MODULA10 or SAVE20)</label>
                  <input className="input" value={promoCode} onChange={(e) => setPromoCode(e.target.value)} placeholder="MODULA10" />
                </div>
                {discount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#059669' }}>
                    <span>Discount ({cleanPromo})</span>
                    <strong>-{formatMoney(discount)}</strong>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '16px', fontWeight: 700 }}>
                  <span>Total</span>
                  <span>{formatMoney(total)}</span>
                </div>
                <div className="field"><label>Customer Name *</label><input className="input" required value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Alex Rivera" /></div>
                <div className="field"><label>Email</label><input className="input" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="alex@company.com" /></div>
                <button type="submit" className="btn btn-success">Place Order</button>
              </>
            )}
          </div>
        </form>
      </div>

      {showAddProd && (
        <div className="modal-backdrop" onClick={() => setShowAddProd(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await onCreateProduct({
                name: prodForm.name,
                sku: prodForm.sku,
                category: prodForm.category,
                price: Number(prodForm.price) || 0,
                stock: Number(prodForm.stock) || 1,
                summary: prodForm.summary,
              });
              setShowAddProd(false);
              setProdForm({ name: '', sku: '', category: 'Hardware', price: '199', stock: '15', summary: '' });
            }}
          >
            <div className="modal-head"><h3>Add Store Product</h3><button type="button" className="btn btn-sm" onClick={() => setShowAddProd(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Name *</label><input className="input" required value={prodForm.name} onChange={(e) => setProdForm({ ...prodForm, name: e.target.value })} /></div>
                <div className="field"><label>SKU *</label><input className="input" required value={prodForm.sku} onChange={(e) => setProdForm({ ...prodForm, sku: e.target.value })} /></div>
                <div className="field"><label>Category</label><input className="input" value={prodForm.category} onChange={(e) => setProdForm({ ...prodForm, category: e.target.value })} /></div>
                <div className="field"><label>Price ($)</label><input className="input" type="number" step="0.01" value={prodForm.price} onChange={(e) => setProdForm({ ...prodForm, price: e.target.value })} /></div>
                <div className="field"><label>Stock</label><input className="input" type="number" value={prodForm.stock} onChange={(e) => setProdForm({ ...prodForm, stock: e.target.value })} /></div>
                <div className="field full"><label>Summary</label><input className="input" value={prodForm.summary} onChange={(e) => setProdForm({ ...prodForm, summary: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowAddProd(false)}>Cancel</button><button type="submit" className="btn btn-primary">Add Product</button></div>
          </form>
        </div>
      )}
    </>
  );
};
