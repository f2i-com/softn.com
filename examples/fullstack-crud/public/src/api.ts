export interface InventoryItem {
  id: string;
  sku: string;
  title: string;
  external_ref_id: string;
  unit_price: string;
  quantity: number;
  status: string;
  priority: string;
  notes: string | null;
  created_at?: string;
}

export async function listItems(query = ''): Promise<InventoryItem[]> {
  const qs = query ? `?q=${encodeURIComponent(query)}` : '';
  const res = await fetch(`/api/items${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load items');
  return data.items || [];
}

export async function createItem(input: {
  sku: string;
  title: string;
  external_ref_id?: string;
  unit_price: string;
  quantity: number;
  priority?: string;
  notes?: string | null;
}): Promise<InventoryItem> {
  const res = await fetch('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to create item');
  return data.item;
}

export async function updateItem(
  id: string,
  patch: Partial<Pick<InventoryItem, 'title' | 'unit_price' | 'quantity' | 'status' | 'priority' | 'notes'>>
): Promise<InventoryItem> {
  const res = await fetch(`/api/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update item');
  return data.item;
}

export async function deleteItem(id: string): Promise<void> {
  const res = await fetch(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to delete item');
}
