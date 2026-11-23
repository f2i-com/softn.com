export interface InventoryOverview {
  skuCount: number;
  totalUnits: number;
  stockValuation: number;
  lowStockCount: number;
  openPos: number;
  openMos: number;
  movesCount: number;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  category: string;
  bin_location: string;
  vendor_name: string;
  unit_cost: number;
  sale_price: number;
  stock_on_hand: number;
  reorder_point: number;
}

export interface PurchaseOrder {
  id: number;
  po_number: string;
  vendor_name: string;
  product_id: number;
  product_sku: string;
  product_name: string;
  qty: number;
  unit_cost: number;
  total: number;
  status: string;
  expected_date: string;
}

export interface BomComponent {
  product_id: number;
  sku: string;
  name: string;
  qty: number;
}

export interface Bom {
  id: number;
  code: string;
  finished_product_id: number;
  finished_sku: string;
  finished_name: string;
  work_center: string;
  components: BomComponent[];
}

export interface ManufacturingOrder {
  id: number;
  mo_number: string;
  bom_id: number;
  finished_sku: string;
  finished_name: string;
  qty_to_produce: number;
  work_center: string;
  status: string;
  scheduled_date: string;
}

export interface StockMove {
  id: number;
  reference: string;
  product_sku: string;
  product_name: string;
  source_loc: string;
  dest_loc: string;
  qty: number;
  move_type: string;
  moved_at: string;
}

export interface Vendor {
  id: number;
  name: string;
  contact: string;
  email: string;
  lead_days: number;
  terms: string;
}
