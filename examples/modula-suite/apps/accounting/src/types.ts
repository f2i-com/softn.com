export interface AccountingOverview {
  bankBalance: number;
  receivables: number;
  payables: number;
  revenue: number;
  expenses: number;
  netProfit: number;
  overdueCount: number;
  pendingExpenses: number;
  unreconciledBank: number;
}

export interface InvoiceLine {
  description: string;
  qty: number;
  unitPrice: number;
}

export interface Invoice {
  id: number;
  invoice_number: string;
  kind: 'customer' | 'vendor';
  party_name: string;
  issue_date: string;
  due_date: string;
  status: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  paid_amount: number;
  lines: InvoiceLine[];
}

export interface Expense {
  id: number;
  employee_name: string;
  category: string;
  description: string;
  amount: number;
  expense_date: string;
  status: string;
}

export interface BankTx {
  id: number;
  tx_date: string;
  bank_ref: string;
  counterparty: string;
  memo: string;
  amount: number;
  reconciled: number;
  matched_invoice_id: number | null;
  suggested: { id: number; invoice_number: string; party_name: string; balance_due: number } | null;
}

export interface Account {
  id: number;
  code: string;
  name: string;
  kind: string;
  balance: number;
}

export interface JournalEntry {
  id: number;
  entry_date: string;
  reference: string;
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  memo: string;
}

export interface FinancialReports {
  pnl: {
    revenues: Account[];
    expenses: Account[];
    totalRevenue: number;
    totalExpense: number;
    netIncome: number;
  };
  balanceSheet: {
    assets: Account[];
    liabilities: Account[];
    equity: Account[];
    totalAssets: number;
    totalLiabilities: number;
    retainedEarnings: number;
    totalLiabAndEquity: number;
  };
  agedReceivables: {
    current: number;
    days_1_30: number;
    days_31_60: number;
    days_60_plus: number;
  };
}

export function accountingStatusBadge(status: string): string {
  switch (status) {
    case 'Paid':
    case 'Reimbursed': return 'badge-success';
    case 'Overdue':
    case 'Rejected': return 'badge-danger';
    case 'Partial':
    case 'Approved': return 'badge-info';
    case 'Credited': return 'badge-accent';
    case 'Sent':
    case 'Submitted': return 'badge-warning';
    default: return 'badge-neutral';
  }
}
