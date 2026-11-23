import { useState } from 'react';
import { formatMoney } from '../../../../shared/ui/format';
import type { OrderLine, PosItem, PosOrder, PosSession } from '../types';

interface PosRegisterViewProps {
  items: PosItem[];
  activeSession: PosSession | null;
  onCheckout: (payload: {
    customer_name: string;
    order_type: 'Counter' | 'Dine-In' | 'Takeaway';
    table_label: string;
    discount_pct: number;
    payment_method: 'Card' | 'Cash' | 'Split';
    amount_tendered: number;
    items: Array<{ itemId: number; qty: number }>;
  }) => Promise<PosOrder>;
  onOpenShiftModal: () => void;
}

export function PosRegisterView({
  items,
  activeSession,
  onCheckout,
  onOpenShiftModal,
}: PosRegisterViewProps) {
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<OrderLine[]>([]);
  const [customerName, setCustomerName] = useState('Walk-in Customer');
  const [orderType, setOrderType] = useState<'Counter' | 'Dine-In' | 'Takeaway'>('Counter');
  const [tableLabel, setTableLabel] = useState('Table 1');
  const [discountPct, setDiscountPct] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState<'Card' | 'Cash' | 'Split'>('Card');
  const [cashTendered, setCashTendered] = useState('');
  const [receipt, setReceipt] = useState<PosOrder | null>(null);
  const [busy, setBusy] = useState(false);

  const categories = ['All', ...Array.from(new Set(items.map((i) => i.category)))];
  const visibleItems = items.filter((item) => {
    const matchCat = category === 'All' || item.category === category;
    const q = search.trim().toLowerCase();
    const matchQ = !q || item.name.toLowerCase().includes(q) || item.sku.toLowerCase().includes(q);
    return matchCat && matchQ;
  });

  const addToCart = (item: PosItem) => {
    if (item.stock_qty <= 0) return;
    setCart((prev) => {
      const existing = prev.find((l) => l.itemId === item.id);
      if (existing) {
        if (existing.qty >= item.stock_qty) return prev;
        return prev.map((l) => (l.itemId === item.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, { itemId: item.id, name: item.name, qty: 1, price: item.price }];
    });
  };

  const updateQty = (itemId: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => (l.itemId === itemId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0)
    );
  };

  const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
  const disc = Math.max(0, Math.min(50, Number(discountPct) || 0));
  const afterDisc = subtotal * (1 - disc / 100);
  const tax = afterDisc * 0.1;
  const total = afterDisc + tax;
  const tendered = paymentMethod === 'Cash' ? Number(cashTendered) || total : total;
  const changeDue = paymentMethod === 'Cash' ? Math.max(0, tendered - total) : 0;

  const submitSale = async () => {
    if (!activeSession || cart.length === 0) return;
    setBusy(true);
    try {
      const order = await onCheckout({
        customer_name: customerName.trim() || 'Walk-in Customer',
        order_type: orderType,
        table_label: orderType === 'Dine-In' ? tableLabel : '',
        discount_pct: disc,
        payment_method: paymentMethod,
        amount_tendered: tendered,
        items: cart.map((c) => ({ itemId: c.itemId, qty: c.qty })),
      });
      setCart([]);
      setDiscountPct('0');
      setCashTendered('');
      setReceipt(order);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {!activeSession && (
        <div className="alert alert-warning">
          <span>No POS register shift is currently open. Open a cash drawer shift before ringing sales.</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={onOpenShiftModal}>Open Register Shift</button>
        </div>
      )}

      <div className="split-2" style={{ gridTemplateColumns: 'minmax(360px, 1.4fr) minmax(320px, 1fr)' }}>
        <div className="panel">
          <div className="panel-header">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`btn btn-sm ${category === cat ? 'btn-primary' : ''}`}
                  onClick={() => setCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
            <input
              className="input"
              type="search"
              placeholder="Scan SKU or search..."
              style={{ width: '175px' }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="panel-body">
            <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))' }}>
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="kanban-card"
                  style={{ textAlign: 'left', opacity: item.stock_qty <= 0 ? 0.5 : 1 }}
                  disabled={item.stock_qty <= 0}
                  onClick={() => addToCart(item)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: '6px' }}>
                    <span className="badge badge-neutral">{item.category}</span>
                    <span style={{ fontSize: '11.5px', color: item.stock_qty <= 5 ? '#dc2626' : '#6b7280' }}>
                      {item.stock_qty} in stock
                    </span>
                  </div>
                  <div className="kanban-card-title">{item.name}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: '11px' }}>{item.sku}</span>
                    <strong style={{ fontSize: '15px', color: '#0284c7' }}>{formatMoney(item.price)}</strong>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Active Order Ticket</h2>
            {cart.length > 0 && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setCart([])}>Clear</button>
            )}
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="form-grid">
              <div className="field">
                <label>Customer</label>
                <input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </div>
              <div className="field">
                <label>Service Mode</label>
                <select className="select" value={orderType} onChange={(e) => setOrderType(e.target.value as 'Counter' | 'Dine-In' | 'Takeaway')}>
                  <option value="Counter">Retail Counter</option>
                  <option value="Dine-In">Restaurant Dine-In</option>
                  <option value="Takeaway">Takeaway</option>
                </select>
              </div>
              {orderType === 'Dine-In' && (
                <div className="field full">
                  <label>Floor Table</label>
                  <select className="select" value={tableLabel} onChange={(e) => setTableLabel(e.target.value)}>
                    {['Table 1', 'Table 2', 'Table 3', 'Table 4', 'Patio A', 'Bar Counter'].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {cart.length === 0 ? (
              <div className="empty-state" style={{ border: '1px dashed var(--border-strong)', borderRadius: '8px' }}>
                Tap products on the left to build a retail or hospitality ticket.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {cart.map((line) => (
                  <div key={line.itemId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '13px' }}>{line.name}</div>
                      <div className="muted" style={{ fontSize: '11.5px' }}>{formatMoney(line.price)} each</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button type="button" className="btn btn-sm" onClick={() => updateQty(line.itemId, -1)}>−</button>
                      <strong style={{ minWidth: '20px', textAlign: 'center' }}>{line.qty}</strong>
                      <button type="button" className="btn btn-sm" onClick={() => updateQty(line.itemId, 1)}>+</button>
                      <strong style={{ minWidth: '64px', textAlign: 'right' }}>{formatMoney(line.price * line.qty)}</strong>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Discount (%)</span>
                <input className="input" type="number" min="0" max="50" style={{ width: '74px', textAlign: 'right' }} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Subtotal</span><span>{formatMoney(subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax (10%)</span><span>{formatMoney(tax)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '17px', fontWeight: 800 }}>
                <span>Total Due</span><span>{formatMoney(total)}</span>
              </div>
            </div>

            <div className="form-grid">
              <div className="field">
                <label>Payment</label>
                <select className="select" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as 'Card' | 'Cash' | 'Split')}>
                  <option value="Card">Card / Tap</option>
                  <option value="Cash">Cash Drawer</option>
                  <option value="Split">50/50 Split</option>
                </select>
              </div>
              {paymentMethod === 'Cash' && (
                <div className="field">
                  <label>Cash Tendered ($)</label>
                  <input className="input" type="number" step="0.01" placeholder={total.toFixed(2)} value={cashTendered} onChange={(e) => setCashTendered(e.target.value)} />
                </div>
              )}
            </div>

            {paymentMethod === 'Cash' && cart.length > 0 && (
              <div className="alert alert-success">
                <span>Change due to customer</span>
                <strong>{formatMoney(changeDue)}</strong>
              </div>
            )}

            <button
              id="pos-charge-btn"
              type="button"
              className="btn btn-primary"
              style={{ padding: '11px', fontSize: '14px' }}
              disabled={!activeSession || cart.length === 0 || busy}
              onClick={() => void submitSale()}
            >
              {busy ? 'Processing...' : `Charge ${formatMoney(total)} (${paymentMethod})`}
            </button>
          </div>
        </div>
      </div>

      {receipt && (
        <div className="modal-backdrop" onClick={() => setReceipt(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Receipt {receipt.order_number}</h3>
              <button type="button" className="btn btn-sm" onClick={() => setReceipt(null)}>Close</button>
            </div>
            <div className="modal-body">
              <div style={{ textAlign: 'center', borderBottom: '1px dashed var(--border-strong)', paddingBottom: '10px' }}>
                <strong>Modula Retail &amp; Cafe POS</strong>
                <div className="muted" style={{ fontSize: '12px' }}>
                  {receipt.created_at} · {receipt.order_type}{receipt.table_label ? ` (${receipt.table_label})` : ''}
                </div>
                <div className="muted" style={{ fontSize: '12px' }}>Customer: {receipt.customer_name}</div>
              </div>
              {receipt.items.map((l, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                  <span>{l.qty} × {l.name}</span>
                  <strong>{formatMoney(l.qty * l.price)}</strong>
                </div>
              ))}
              <div style={{ borderTop: '1px dashed var(--border-strong)', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Subtotal</span><span>{formatMoney(receipt.subtotal)}</span></div>
                {receipt.discount_pct > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Discount ({receipt.discount_pct}%)</span><span>Applied</span></div>}
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax (10%)</span><span>{formatMoney(receipt.tax_amount)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '16px', fontWeight: 800 }}><span>Paid ({receipt.payment_method})</span><span>{formatMoney(receipt.total)}</span></div>
                {receipt.change_due > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', color: '#059669' }}><span>Change Returned</span><strong>{formatMoney(receipt.change_due)}</strong></div>}
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-primary" onClick={() => setReceipt(null)}>Done · Next Sale</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
