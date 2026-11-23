export interface PosSession {
  id: number;
  register_name: string;
  cashier_name: string;
  opened_at: string;
  closed_at: string;
  opening_float: number;
  cash_sales: number;
  card_sales: number;
  status: 'Open' | 'Closed';
  notes: string;
}

export interface PosItem {
  id: number;
  sku: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  stock_qty: number;
  active: number;
}

export interface OrderLine {
  itemId: number;
  name: string;
  qty: number;
  price: number;
}

export interface PosOrder {
  id: number;
  order_number: string;
  session_id: number;
  customer_name: string;
  order_type: 'Counter' | 'Dine-In' | 'Takeaway';
  table_label: string;
  items: OrderLine[];
  subtotal: number;
  discount_pct: number;
  tax_amount: number;
  total: number;
  payment_method: 'Card' | 'Cash' | 'Split';
  amount_tendered: number;
  change_due: number;
  status: 'Paid' | 'Refunded';
  created_at: string;
}

export interface RentalAsset {
  id: number;
  asset_code: string;
  name: string;
  category: string;
  daily_rate: number;
  deposit_amount: number;
  total_qty: number;
  available_qty: number;
  condition_note: string;
}

export interface RentalBooking {
  id: number;
  booking_number: string;
  asset_id: number;
  asset_name: string;
  customer_name: string;
  qty: number;
  start_date: string;
  end_date: string;
  daily_rate: number;
  deposit_amount: number;
  total_amount: number;
  status: 'Reserved' | 'Picked Up' | 'Returned' | 'Cancelled';
  created_at: string;
}

export interface PosOverview {
  activeSession: PosSession | null;
  totalSales: number;
  orderCount: number;
  avgBasket: number;
  activeRentals: number;
  pickedUpUnits: number;
  rentalRevenue: number;
}
