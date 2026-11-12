export type TransferRow = {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  amount: number;
  currency: string;
  status: 'posted' | 'declined';
  decline_reason: string | null;
  description: string | null;
  created_at: Date;
};

export function serializeTransfer(r: TransferRow) {
  return {
    id: r.id,
    object: 'transfer',
    status: r.status,
    source_account_id: r.source_account_id,
    destination_account_id: r.destination_account_id,
    amount: r.amount,
    currency: r.currency,
    description: r.description,
    decline_reason: r.decline_reason,
    created_at: r.created_at.toISOString(),
  };
}

export type SerializedTransfer = ReturnType<typeof serializeTransfer>;
