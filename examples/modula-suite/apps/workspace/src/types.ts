export interface VaultDocument {
  id: number;
  title: string;
  folder: string;
  doc_type: string;
  owner_name: string;
  version_label: string;
  tags: string;
  size_kb: number;
  content_text: string;
  updated_at: string;
}

export interface SignRequest {
  id: number;
  ref_code: string;
  document_id: number;
  document_title: string;
  signer_name: string;
  signer_email: string;
  status: 'Pending' | 'Signed' | 'Declined';
  signed_at: string;
  signature_text: string;
  audit_hash: string;
  requested_by: string;
  created_at: string;
}

export interface ApprovalRequest {
  id: number;
  ref_code: string;
  category: string;
  title: string;
  requester_name: string;
  amount: number;
  justification: string;
  approver_name: string;
  status: 'Pending' | 'Approved' | 'Refused';
  decision_note: string;
  created_at: string;
  decided_at: string;
}

export interface DiscussChannel {
  id: number;
  slug: string;
  name: string;
  kind: 'Public' | 'Private';
  topic: string;
  message_count?: number;
}

export interface ChannelMessage {
  id: number;
  channel_id: number;
  author_name: string;
  body: string;
  pinned: number;
  created_at: string;
}

export interface WorkspaceOverview {
  totalDocs: number;
  pendingSigns: number;
  signedCount: number;
  pendingApprovals: number;
  approvedAmount: number;
  totalMessages: number;
}
