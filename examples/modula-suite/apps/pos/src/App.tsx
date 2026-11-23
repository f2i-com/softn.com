import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatMoney } from '../../../shared/ui/format';
import { OrdersAndSessionsView } from './components/OrdersAndSessionsView';
import { PosRegisterView } from './components/PosRegisterView';
import { RentalDeskView } from './components/RentalDeskView';
import type { PosItem, PosOrder, PosOverview, PosSession, RentalAsset, RentalBooking } from './types';

export function App() {
  const [tab, setTab] = useState<'register' | 'orders' | 'rental'>('register');
  const [overview, setOverview] = useState<PosOverview | null>(null);
  const [items, setItems] = useState<PosItem[]>([]);
  const [orders, setOrders] = useState<PosOrder[]>([]);
  const [sessions, setSessions] = useState<PosSession[]>([]);
  const [assets, setAssets] = useState<RentalAsset[]>([]);
  const [bookings, setBookings] = useState<RentalBooking[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showOpenShift, setShowOpenShift] = useState(false);
  const [shiftForm, setShiftForm] = useState({ register_name: 'Main Counter #1', cashier_name: 'Maya Lin', opening_float: '250' });

  const [showNewItem, setShowNewItem] = useState(false);
  const [itemForm, setItemForm] = useState({ sku: '', name: '', category: 'Retail', price: '29.00', cost: '12.00', stock_qty: '25' });

  const [showNewRental, setShowNewRental] = useState(false);
  const [rentalForm, setRentalForm] = useState({ asset_id: '1', customer_name: '', qty: '1', days: '3', start_date: '2026-11-24', end_date: '2026-11-27' });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, iRes, oRes, sRes, rRes, rt] = await Promise.all([
        apiFetch<PosOverview>('/api/overview'),
        apiFetch<{ items: PosItem[] }>('/api/items'),
        apiFetch<{ orders: PosOrder[] }>('/api/orders'),
        apiFetch<{ sessions: PosSession[] }>('/api/sessions'),
        apiFetch<{ assets: RentalAsset[]; bookings: RentalBooking[] }>('/api/rentals'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setItems(iRes.items);
      setOrders(oRes.orders);
      setSessions(sRes.sessions);
      setAssets(rRes.assets);
      setBookings(rRes.bookings);
      setRuntime(rt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#0284c7', ['--accent-soft' as string]: '#e0f2fe', ['--accent-ink' as string]: '#075985' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">PS</div>
          <div>
            <h1>Point of Sale &amp; Rental</h1>
            <div className="erp-brand-sub">Retail/Cafe Touch Register, Z-Reports &amp; Equipment Rental Desk</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="POS sections">
          <button type="button" className={`erp-tab ${tab === 'register' ? 'active' : ''}`} onClick={() => setTab('register')}>POS Register</button>
          <button type="button" className={`erp-tab ${tab === 'orders' ? 'active' : ''}`} onClick={() => setTab('orders')}>Orders &amp; Shifts ({orders.length})</button>
          <button type="button" className={`erp-tab ${tab === 'rental' ? 'active' : ''}`} onClick={() => setTab('rental')}>Equipment Rental ({bookings.length})</button>
        </nav>

        <div className="erp-actions">
          {tab === 'register' && <button type="button" className="btn" onClick={() => setShowNewItem(true)}>+ Catalog Item</button>}
          {tab === 'rental' && <button type="button" className="btn btn-primary" onClick={() => setShowNewRental(true)}>+ Rental Booking</button>}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Register Shift</span>
              <span className="kpi-value" style={{ color: overview.activeSession ? '#059669' : '#dc2626' }}>
                {overview.activeSession ? 'Open' : 'Closed'}
              </span>
              <span className="kpi-sub">{overview.activeSession ? `${overview.activeSession.register_name} · ${overview.activeSession.cashier_name}` : 'Open a shift to ring sales'}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Gross POS Sales</span>
              <span className="kpi-value" id="kpi-pos-sales">{formatMoney(overview.totalSales)}</span>
              <span className="kpi-sub">{overview.orderCount} paid receipts · avg {formatMoney(overview.avgBasket)}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Active Rental Contracts</span>
              <span className="kpi-value">{overview.activeRentals}</span>
              <span className="kpi-sub">{overview.pickedUpUnits} unit(s) currently checked out</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Rental Revenue</span>
              <span className="kpi-value" style={{ color: '#0284c7' }}>{formatMoney(overview.rentalRevenue)}</span>
              <span className="kpi-sub">{assets.length} equipment fleets managed</span>
            </div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Booting POS &amp; Rental from PHP + XDB SQLite...</div></div>
        ) : tab === 'register' ? (
          <PosRegisterView
            items={items}
            activeSession={overview?.activeSession ?? null}
            onOpenShiftModal={() => setShowOpenShift(true)}
            onCheckout={async (payload) => {
              const res = await apiFetch<{ order: PosOrder }>('/api/orders', { method: 'POST', body: payload });
              await loadAll();
              notify(`Receipt ${res.order.order_number} paid (${formatMoney(res.order.total)})`);
              return res.order;
            }}
          />
        ) : tab === 'orders' ? (
          <OrdersAndSessionsView
            orders={orders}
            sessions={sessions}
            onOpenShiftModal={() => setShowOpenShift(true)}
            onRefund={async (id) => {
              await apiFetch(`/api/orders/${id}/refund`, { method: 'POST' });
              await loadAll();
              notify('Order refunded & inventory restocked');
            }}
            onCloseSession={async (id) => {
              await apiFetch(`/api/sessions/${id}/close`, { method: 'POST', body: { notes: 'Closed via Z-Report' } });
              await loadAll();
              notify('POS shift closed & Z-Report saved');
            }}
          />
        ) : (
          <RentalDeskView
            assets={assets}
            bookings={bookings}
            onOpenNewBooking={() => setShowNewRental(true)}
            onUpdateStatus={async (id, status) => {
              await apiFetch(`/api/rentals/bookings/${id}/status`, { method: 'PATCH', body: { status } });
              await loadAll();
              notify(`Rental updated to ${status}`);
            }}
          />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Point of Sale &amp; Equipment Rental · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showOpenShift && (
        <div className="modal-backdrop" onClick={() => setShowOpenShift(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/sessions/open', { method: 'POST', body: { ...shiftForm, opening_float: Number(shiftForm.opening_float) || 0 } });
              setShowOpenShift(false);
              await loadAll();
              notify('POS shift opened');
            }}
          >
            <div className="modal-head"><h3>Open Register Shift</h3><button type="button" className="btn btn-sm" onClick={() => setShowOpenShift(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>Register Name</label><input className="input" required value={shiftForm.register_name} onChange={(e) => setShiftForm({ ...shiftForm, register_name: e.target.value })} /></div>
                <div className="field"><label>Cashier</label><input className="input" required value={shiftForm.cashier_name} onChange={(e) => setShiftForm({ ...shiftForm, cashier_name: e.target.value })} /></div>
                <div className="field full"><label>Opening Cash Float ($)</label><input className="input" type="number" step="0.01" value={shiftForm.opening_float} onChange={(e) => setShiftForm({ ...shiftForm, opening_float: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowOpenShift(false)}>Cancel</button><button type="submit" className="btn btn-primary">Open Shift</button></div>
          </form>
        </div>
      )}

      {showNewItem && (
        <div className="modal-backdrop" onClick={() => setShowNewItem(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/items', { method: 'POST', body: { ...itemForm, price: Number(itemForm.price) || 0, cost: Number(itemForm.cost) || 0, stock_qty: Number(itemForm.stock_qty) || 0 } });
              setShowNewItem(false);
              setItemForm({ sku: '', name: '', category: 'Retail', price: '29.00', cost: '12.00', stock_qty: '25' });
              await loadAll();
              notify('Catalog item added to POS');
            }}
          >
            <div className="modal-head"><h3>Add POS Catalog Item</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewItem(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>SKU *</label><input className="input" required value={itemForm.sku} onChange={(e) => setItemForm({ ...itemForm, sku: e.target.value })} /></div>
                <div className="field"><label>Category</label><select className="select" value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })}><option value="Hardware">Hardware</option><option value="Retail">Retail</option><option value="Cafe & Dining">Cafe &amp; Dining</option><option value="Accessories">Accessories</option></select></div>
                <div className="field full"><label>Item Name *</label><input className="input" required value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} /></div>
                <div className="field"><label>Price ($)</label><input className="input" type="number" step="0.01" value={itemForm.price} onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })} /></div>
                <div className="field"><label>Initial Stock</label><input className="input" type="number" value={itemForm.stock_qty} onChange={(e) => setItemForm({ ...itemForm, stock_qty: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewItem(false)}>Cancel</button><button type="submit" className="btn btn-primary">Save Item</button></div>
          </form>
        </div>
      )}

      {showNewRental && (
        <div className="modal-backdrop" onClick={() => setShowNewRental(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/rentals/bookings', { method: 'POST', body: { ...rentalForm, asset_id: Number(rentalForm.asset_id), qty: Number(rentalForm.qty) || 1, days: Number(rentalForm.days) || 1 } });
              setShowNewRental(false);
              setRentalForm({ asset_id: String(assets[0]?.id ?? 1), customer_name: '', qty: '1', days: '3', start_date: '2026-11-24', end_date: '2026-11-27' });
              await loadAll();
              notify('Rental booking reserved');
            }}
          >
            <div className="modal-head"><h3>New Equipment Rental</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewRental(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full">
                  <label>Equipment Asset *</label>
                  <select className="select" value={rentalForm.asset_id} onChange={(e) => setRentalForm({ ...rentalForm, asset_id: e.target.value })}>
                    {assets.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.available_qty} free · {formatMoney(a.daily_rate)}/day)</option>)}
                  </select>
                </div>
                <div className="field full"><label>Customer *</label><input className="input" required value={rentalForm.customer_name} onChange={(e) => setRentalForm({ ...rentalForm, customer_name: e.target.value })} /></div>
                <div className="field"><label>Quantity</label><input className="input" type="number" min="1" value={rentalForm.qty} onChange={(e) => setRentalForm({ ...rentalForm, qty: e.target.value })} /></div>
                <div className="field"><label>Rental Days</label><input className="input" type="number" min="1" value={rentalForm.days} onChange={(e) => setRentalForm({ ...rentalForm, days: e.target.value })} /></div>
                <div className="field"><label>Start Date</label><input className="input" type="date" value={rentalForm.start_date} onChange={(e) => setRentalForm({ ...rentalForm, start_date: e.target.value })} /></div>
                <div className="field"><label>Return Date</label><input className="input" type="date" value={rentalForm.end_date} onChange={(e) => setRentalForm({ ...rentalForm, end_date: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewRental(false)}>Cancel</button><button type="submit" className="btn btn-primary">Reserve Equipment</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
