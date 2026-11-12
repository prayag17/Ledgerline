import type { RiskLimits } from './merchants.ts';

export type DeclineReason =
  | 'amount_limit_exceeded'
  | 'daily_limit_exceeded'
  | 'velocity_limit_exceeded'
  | 'insufficient_funds';

export type RiskContext = {
  amount: number;
  /** posted transfers from the source account inside the velocity window */
  recentCount: number;
  /** amount posted from the source account in the trailing 24h */
  trailingDayAmount: number;
  balance: number;
  allowNegative: boolean;
};

/** Pure decision function; the caller gathers the context under a lock on the source account. */
export function evaluateRisk(ctx: RiskContext, limits: RiskLimits): DeclineReason | null {
  if (ctx.amount > limits.maxTransferAmount) return 'amount_limit_exceeded';
  if (ctx.trailingDayAmount + ctx.amount > limits.dailyLimitAmount) return 'daily_limit_exceeded';
  if (ctx.recentCount + 1 > limits.velocityMaxCount) return 'velocity_limit_exceeded';
  if (!ctx.allowNegative && ctx.balance < ctx.amount) return 'insufficient_funds';
  return null;
}
