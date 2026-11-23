import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type RuntimeInfo } from '../../../shared/ui/api';
import { formatCompactMoney, formatMoney, formatNumber } from '../../../shared/ui/format';
import { ProductsView, StockMovesView, VendorsView } from './components/ProductsAndMovesView';
import { MrpView, PurchaseOrdersView } from './components/PurchaseAndMrpView';
import type { Bom, InventoryOverview, ManufacturingOrder, Product, PurchaseOrder, StockMove, Vendor } from './types';

export function App() {
  const [tab, setTab] = useState<'products' | 'pos' | 'mrp' | 'moves' | 'vendors'>('products');
  const [search, setSearch] = useState('');
  const [overview, setOverview] = useState<InventoryOverview | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [boms, setBoms] = useState<Bom[]>([]);
  const [mos, setMos] = useState<ManufacturingOrder[]>([]);
  const [moves, setMoves] = useState<StockMove[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showNewProd, setShowNewProd] = useState(false);
  const [prodForm, setProdForm] = useState({ sku: '', name: '', category: 'Hardware', bin_location: 'WH/A2-01', vendor_name: 'Apex Hardware Imports', unit_cost: '45', sale_price: '99', stock_on_hand: '12', reorder_point: '6' });
  const [showNewPo, setShowNewPo] = useState(false);
  const [poProductId, setPoProductId] = useState('');
  const [poQty, setPoQty] = useState('20');
  const [showNewMo, setShowNewMo] = useState(false);
  const [moBomId, setMoBomId] = useState('1');
  const [moQty, setMoQty] = useState('2');
  const [showTransfer, setShowTransfer] = useState(false);
  const [trForm, setTrForm] = useState({ product_id: '1', kind: 'Delivery', qty: '2', dest_loc: 'Customers/Northstar' });
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [vendorForm, setVendorForm] = useState({ name: '', contact: '', email: '', lead_days: '5', terms: 'Net 30' });

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [ov, pRes, poRes, mrpRes, mRes, vRes, rt] = await Promise.all([
        apiFetch<InventoryOverview>('/api/overview'),
        apiFetch<{ products: Product[] }>('/api/products'),
        apiFetch<{ pos: PurchaseOrder[] }>('/api/pos'),
        apiFetch<{ boms: Bom[]; orders: ManufacturingOrder[] }>('/api/mrp'),
        apiFetch<{ moves: StockMove[] }>('/api/moves'),
        apiFetch<{ vendors: Vendor[] }>('/api/vendors'),
        apiFetch<RuntimeInfo>('/api/runtime'),
      ]);
      setOverview(ov);
      setProducts(pRes.products);
      setPos(poRes.pos);
      setBoms(mrpRes.boms);
      setMos(mrpRes.orders);
      setMoves(mRes.moves);
      setVendors(vRes.vendors);
      setRuntime(rt);
      if (!poProductId && pRes.products.length > 0) setPoProductId(String(pRes.products[0].id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [poProductId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const qLower = search.trim().toLowerCase();
  const visibleProducts = products.filter((p) => !qLower || p.sku.toLowerCase().includes(qLower) || p.name.toLowerCase().includes(qLower) || p.category.toLowerCase().includes(qLower));
  const lowStockItems = products.filter((p) => p.stock_on_hand <= p.reorder_point);

  const handleQuickReorder = async (product: Product) => {
    const qty = Math.max(10, product.reorder_point * 2);
    await apiFetch('/api/pos', { method: 'POST', body: { product_id: product.id, qty, vendor_name: product.vendor_name } });
    await loadAll();
    setTab('pos');
    notify(`Draft RFQ created for ${qty} × ${product.sku}`);
  };

  return (
    <div className="erp-app" style={{ ['--accent' as string]: '#d97706', ['--accent-soft' as string]: '#fef3c7', ['--accent-ink' as string]: '#92400e' }}>
      <header className="erp-topbar">
        <div className="erp-brand">
          <div className="erp-brand-dot">IN</div>
          <div>
            <h1>Inventory, Purchase &amp; MRP</h1>
            <div className="erp-brand-sub">Double-Entry Stock, Purchase Orders, Bills of Materials &amp; Manufacturing</div>
          </div>
        </div>

        <nav className="erp-tabs" aria-label="Inventory sections">
          <button type="button" className={`erp-tab ${tab === 'products' ? 'active' : ''}`} onClick={() => setTab('products')}>Products ({products.length})</button>
          <button type="button" className={`erp-tab ${tab === 'pos' ? 'active' : ''}`} onClick={() => setTab('pos')}>Purchase ({pos.length})</button>
          <button type="button" className={`erp-tab ${tab === 'mrp' ? 'active' : ''}`} onClick={() => setTab('mrp')}>MRP / BoM ({mos.length})</button>
          <button type="button" className={`erp-tab ${tab === 'moves' ? 'active' : ''}`} onClick={() => setTab('moves')}>Moves ({moves.length})</button>
          <button type="button" className={`erp-tab ${tab === 'vendors' ? 'active' : ''}`} onClick={() => setTab('vendors')}>Vendors ({vendors.length})</button>
        </nav>

        <div className="erp-actions">
          {tab === 'products' && (
            <>
              <input className="input" style={{ width: '130px' }} type="search" placeholder="Filter SKUs..." value={search} onChange={(e) => setSearch(e.target.value)} />
              <button type="button" className="btn" onClick={() => setShowTransfer(true)}>Transfer</button>
              <button type="button" className="btn btn-primary" onClick={() => setShowNewProd(true)}>+ SKU</button>
            </>
          )}
          {tab === 'pos' && <button type="button" className="btn btn-primary" onClick={() => setShowNewPo(true)}>+ Purchase Order</button>}
          {tab === 'mrp' && <button type="button" className="btn btn-primary" onClick={() => setShowNewMo(true)}>+ Manufacturing Order</button>}
          {tab === 'vendors' && <button type="button" className="btn btn-primary" onClick={() => setShowNewVendor(true)}>+ Vendor</button>}
        </div>
      </header>

      <main className="erp-main">
        {error && <div className="alert alert-danger"><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

        {lowStockItems.length > 0 && tab === 'products' && (
          <div className="alert alert-warning">
            <span><strong>{lowStockItems.length} item(s) below reorder threshold:</strong> {lowStockItems.map((i) => `${i.sku} (${i.stock_on_hand}/${i.reorder_point})`).join(', ')}</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void handleQuickReorder(lowStockItems[0])}>1-Click Draft PO ({lowStockItems[0].sku})</button>
          </div>
        )}

        {overview && (
          <section className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Stock Valuation</span><span className="kpi-value" id="kpi-valuation">{formatCompactMoney(overview.stockValuation)}</span><span className="kpi-sub">{formatNumber(overview.totalUnits)} units across {overview.skuCount} SKUs</span></div>
            <div className="kpi-card"><span className="kpi-label">Low Stock Alerts</span><span className="kpi-value" style={{ color: overview.lowStockCount > 0 ? '#dc2626' : '#059669' }}>{overview.lowStockCount}</span><span className="kpi-sub">At or below min reorder level</span></div>
            <div className="kpi-card"><span className="kpi-label">Open POs &amp; MRP Orders</span><span className="kpi-value">{overview.openPos} PO / {overview.openMos} MO</span><span className="kpi-sub">Inbound purchasing &amp; shop-floor builds</span></div>
            <div className="kpi-card"><span className="kpi-label">Audited Stock Moves</span><span className="kpi-value">{overview.movesCount}</span><span className="kpi-sub">Double-entry location ledger</span></div>
          </section>
        )}

        {loading ? (
          <div className="panel"><div className="empty-state">Loading warehouse ledger from PHP + XDB SQLite...</div></div>
        ) : tab === 'products' ? (
          <ProductsView
            products={visibleProducts}
            onAdjust={async (p, delta) => {
              await apiFetch(`/api/products/${p.id}/adjust`, { method: 'POST', body: { delta, reason: delta > 0 ? 'Quick Stock-In' : 'Quick Dispatch' } });
              await loadAll();
              notify(`${p.sku} adjusted by ${delta > 0 ? '+' : ''}${delta}`);
            }}
            onQuickReorder={handleQuickReorder}
          />
        ) : tab === 'pos' ? (
          <PurchaseOrdersView
            pos={pos}
            onConfirm={async (id) => { await apiFetch(`/api/pos/${id}/confirm`, { method: 'POST' }); await loadAll(); notify('PO confirmed'); }}
            onReceive={async (id) => { await apiFetch(`/api/pos/${id}/receive`, { method: 'POST' }); await loadAll(); notify('Goods received atomically'); }}
          />
        ) : tab === 'mrp' ? (
          <MrpView
            boms={boms}
            orders={mos}
            onProduce={async (id) => {
              try {
                await apiFetch(`/api/mrp/orders/${id}/produce`, { method: 'POST' });
                await loadAll();
                notify('MRP Order produced — components consumed & finished kits added!');
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        ) : tab === 'moves' ? (
          <StockMovesView moves={moves} />
        ) : (
          <VendorsView vendors={vendors} />
        )}
      </main>

      <footer className="erp-footer">
        <span>Modula Inventory, Purchase &amp; MRP · SoftN v2 React + PHP Container</span>
        {runtime && (
          <span className="runtime-pill">
            <span className="runtime-dot" />
            {runtime.mode === 'zipp-wasm' ? 'PHP 8 (ZIPP WASM)' : 'Standalone PHP'} · {runtime.database}
          </span>
        )}
      </footer>

      {showNewProd && (
        <div className="modal-backdrop" onClick={() => setShowNewProd(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/products', { method: 'POST', body: { ...prodForm, unit_cost: Number(prodForm.unit_cost) || 0, sale_price: Number(prodForm.sale_price) || 0, stock_on_hand: Number(prodForm.stock_on_hand) || 0, reorder_point: Number(prodForm.reorder_point) || 5 } });
              setShowNewProd(false);
              setProdForm({ sku: '', name: '', category: 'Hardware', bin_location: 'WH/A2-01', vendor_name: 'Apex Hardware Imports', unit_cost: '45', sale_price: '99', stock_on_hand: '12', reorder_point: '6' });
              await loadAll();
              notify('Product SKU added');
            }}
          >
            <div className="modal-head"><h3>New Product SKU</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewProd(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field"><label>SKU *</label><input className="input" required value={prodForm.sku} onChange={(e) => setProdForm({ ...prodForm, sku: e.target.value })} /></div>
                <div className="field"><label>Bin</label><input className="input" value={prodForm.bin_location} onChange={(e) => setProdForm({ ...prodForm, bin_location: e.target.value })} /></div>
                <div className="field full"><label>Name *</label><input className="input" required value={prodForm.name} onChange={(e) => setProdForm({ ...prodForm, name: e.target.value })} /></div>
                <div className="field"><label>Cost ($)</label><input className="input" type="number" step="0.01" value={prodForm.unit_cost} onChange={(e) => setProdForm({ ...prodForm, unit_cost: e.target.value })} /></div>
                <div className="field"><label>Price ($)</label><input className="input" type="number" step="0.01" value={prodForm.sale_price} onChange={(e) => setProdForm({ ...prodForm, sale_price: e.target.value })} /></div>
                <div className="field"><label>Stock</label><input className="input" type="number" value={prodForm.stock_on_hand} onChange={(e) => setProdForm({ ...prodForm, stock_on_hand: e.target.value })} /></div>
                <div className="field"><label>Reorder Pt</label><input className="input" type="number" value={prodForm.reorder_point} onChange={(e) => setProdForm({ ...prodForm, reorder_point: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewProd(false)}>Cancel</button><button type="submit" className="btn btn-primary">Add SKU</button></div>
          </form>
        </div>
      )}

      {showTransfer && (
        <div className="modal-backdrop" onClick={() => setShowTransfer(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await apiFetch('/api/transfers', { method: 'POST', body: { product_id: Number(trForm.product_id), kind: trForm.kind, qty: Number(trForm.qty) || 1, dest_loc: trForm.dest_loc } });
                setShowTransfer(false);
                await loadAll();
                notify(`${trForm.kind} logged`);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <div className="modal-head"><h3>Delivery or Bin Transfer</h3><button type="button" className="btn btn-sm" onClick={() => setShowTransfer(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Product</label><select className="select" value={trForm.product_id} onChange={(e) => setTrForm({ ...trForm, product_id: e.target.value })}>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name} ({p.stock_on_hand} avail)</option>)}</select></div>
                <div className="field"><label>Move Type</label><select className="select" value={trForm.kind} onChange={(e) => setTrForm({ ...trForm, kind: e.target.value, dest_loc: e.target.value === 'Delivery' ? 'Customers/Outbound' : 'WH/B3-01' })}><option value="Delivery">Customer Delivery</option><option value="Internal">Internal Bin Transfer</option></select></div>
                <div className="field"><label>Quantity</label><input className="input" type="number" min="1" value={trForm.qty} onChange={(e) => setTrForm({ ...trForm, qty: e.target.value })} /></div>
                <div className="field full"><label>Destination</label><input className="input" value={trForm.dest_loc} onChange={(e) => setTrForm({ ...trForm, dest_loc: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowTransfer(false)}>Cancel</button><button type="submit" className="btn btn-primary">Execute Move</button></div>
          </form>
        </div>
      )}

      {showNewPo && (
        <div className="modal-backdrop" onClick={() => setShowNewPo(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/pos', { method: 'POST', body: { product_id: Number(poProductId), qty: Number(poQty) || 10 } });
              setShowNewPo(false);
              await loadAll();
              notify('Purchase RFQ created');
            }}
          >
            <div className="modal-head"><h3>New Purchase Order</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewPo(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="field"><label>Product</label><select className="select" value={poProductId} onChange={(e) => setPoProductId(e.target.value)}>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name} ({formatMoney(Number(p.unit_cost))})</option>)}</select></div>
              <div className="field"><label>Quantity</label><input className="input" type="number" min="1" value={poQty} onChange={(e) => setPoQty(e.target.value)} /></div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewPo(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create RFQ</button></div>
          </form>
        </div>
      )}

      {showNewMo && (
        <div className="modal-backdrop" onClick={() => setShowNewMo(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/mrp/orders', { method: 'POST', body: { bom_id: Number(moBomId), qty_to_produce: Number(moQty) || 1 } });
              setShowNewMo(false);
              await loadAll();
              notify('Manufacturing Order planned');
            }}
          >
            <div className="modal-head"><h3>Plan Manufacturing Order</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewMo(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="field"><label>Bill of Materials</label><select className="select" value={moBomId} onChange={(e) => setMoBomId(e.target.value)}>{boms.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.finished_name}</option>)}</select></div>
              <div className="field"><label>Quantity</label><input className="input" type="number" min="1" value={moQty} onChange={(e) => setMoQty(e.target.value)} /></div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewMo(false)}>Cancel</button><button type="submit" className="btn btn-primary">Plan Order</button></div>
          </form>
        </div>
      )}

      {showNewVendor && (
        <div className="modal-backdrop" onClick={() => setShowNewVendor(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/vendors', { method: 'POST', body: { ...vendorForm, lead_days: Number(vendorForm.lead_days) || 5 } });
              setShowNewVendor(false);
              setVendorForm({ name: '', contact: '', email: '', lead_days: '5', terms: 'Net 30' });
              await loadAll();
              notify('Vendor added');
            }}
          >
            <div className="modal-head"><h3>Add Vendor</h3><button type="button" className="btn btn-sm" onClick={() => setShowNewVendor(false)}>Cancel</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full"><label>Name *</label><input className="input" required value={vendorForm.name} onChange={(e) => setVendorForm({ ...vendorForm, name: e.target.value })} /></div>
                <div className="field"><label>Contact</label><input className="input" value={vendorForm.contact} onChange={(e) => setVendorForm({ ...vendorForm, contact: e.target.value })} /></div>
                <div className="field"><label>Email</label><input className="input" type="email" value={vendorForm.email} onChange={(e) => setVendorForm({ ...vendorForm, email: e.target.value })} /></div>
                <div className="field"><label>Lead Days</label><input className="input" type="number" value={vendorForm.lead_days} onChange={(e) => setVendorForm({ ...vendorForm, lead_days: e.target.value })} /></div>
                <div className="field"><label>Terms</label><input className="input" value={vendorForm.terms} onChange={(e) => setVendorForm({ ...vendorForm, terms: e.target.value })} /></div>
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setShowNewVendor(false)}>Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
