import { useEffect, useMemo, useState } from 'react';
import { createItem, deleteItem, listItems, updateItem, type InventoryItem } from './api';
import './styles.css';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

interface InputChangeEvent {
  target: { value: string };
}

export function App() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [sku, setSku] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [price, setPrice] = useState<string>('149.9900');
  const [qty, setQty] = useState<string>('1');
  const [priority, setPriority] = useState<string>('normal');
  const [error, setError] = useState<string>('');
  const [loaded, setLoaded] = useState<boolean>(false);

  const reload = async () => {
    try {
      const next = await listItems();
      setItems(next);
      setError('');
    } catch (err: unknown) {
      setError(errorMessage(err, 'Load error'));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const totalUnits = useMemo(
    () => items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    [items]
  );

  const handleCreate = async () => {
    setError('');
    try {
      await createItem({
        sku: sku.trim(),
        title: title.trim(),
        external_ref_id: '9007199254740995',
        unit_price: price.trim() || '0.00',
        quantity: Number(qty) || 0,
        priority,
        notes: null,
      });
      setSku('');
      setTitle('');
      await reload();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Create failed'));
    }
  };

  const handleBumpQty = async (item: InventoryItem) => {
    setError('');
    try {
      await updateItem(item.id, { quantity: Number(item.quantity) + 1, priority: 'high' });
      await reload();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Update failed'));
    }
  };

  const handleDelete = async (id: string) => {
    setError('');
    try {
      await deleteItem(id);
      await reload();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Delete failed'));
    }
  };

  return (
    <div className="crud-shell">
      <div className="crud-card">
        <h1 id="app-title">Inventory CRUD (React TSX + PHP Slim + SQLite)</h1>
        <p id="summary">
          {loaded ? `${items.length} items · ${totalUnits} total units` : 'Loading…'}
        </p>
        {error ? <div id="error-banner" className="error-banner">{error}</div> : null}
      </div>

      <div className="crud-card">
        <div className="crud-row">
          <input id="sku-input" placeholder="SKU" value={sku} onChange={(e: InputChangeEvent) => setSku(e.target.value)} />
          <input id="title-input" placeholder="Title" value={title} onChange={(e: InputChangeEvent) => setTitle(e.target.value)} />
          <input id="price-input" placeholder="Price" value={price} onChange={(e: InputChangeEvent) => setPrice(e.target.value)} />
          <input id="qty-input" placeholder="Qty" value={qty} onChange={(e: InputChangeEvent) => setQty(e.target.value)} />
          <select id="priority-select" value={priority} onChange={(e: InputChangeEvent) => setPriority(e.target.value)}>
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="high">high</option>
          </select>
          <button id="create-btn" type="button" onClick={handleCreate}>Add Item</button>
        </div>
      </div>

      <div className="crud-card">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Title</th>
              <th>Ext 64-bit ID</th>
              <th>Price</th>
              <th>Qty</th>
              <th>Priority</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="items-tbody">
            {items.map((item) => (
              <tr key={item.id} data-item-id={item.id} data-sku={item.sku}>
                <td>{item.sku}</td>
                <td>{item.title}</td>
                <td>{item.external_ref_id}</td>
                <td>{item.unit_price}</td>
                <td>{item.quantity}</td>
                <td>{item.priority}</td>
                <td>
                  <button
                    type="button"
                    data-action="bump"
                    data-id={item.id}
                    onClick={() => handleBumpQty(item)}
                  >
                    +1 Qty
                  </button>{' '}
                  <button
                    type="button"
                    className="danger"
                    data-action="delete"
                    data-id={item.id}
                    onClick={() => handleDelete(item.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
