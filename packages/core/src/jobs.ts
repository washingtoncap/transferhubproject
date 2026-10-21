import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { PermanentJobError, type Runner } from '@transferhub/platform';
import { processStatementCredit } from './deposits';
import { type Asset, toNumber } from './money';
import { PARTNER_SOURCE, partnerCompletePayout } from './partner';
import {
  failWithdrawal,
  queryWithdrawalStatus,
  settleWithdrawal,
  submitWithdrawal,
} from './withdrawals';

/**
 * Processes one recorded partner event. Locks the inbox row, so two workers can never process the
 * same event; posting is additionally unique per statement line in the ledger.
 */
export async function processPartnerEvent(pool: Pool, inboxId: string): Promise<string> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      status: string;
      event_type: string;
      payload: { data: Record<string, unknown> };
      source: string;
    }>('SELECT status, event_type, payload, source FROM platform.inbox WHERE id = $1 FOR UPDATE', [
      inboxId,
    ]);
    const ev = rows[0];
    if (!ev) throw new PermanentJobError('Inbox event not found');
    if (ev.source !== PARTNER_SOURCE) throw new PermanentJobError('Not a partner event');
    if (ev.status !== 'received' && ev.status !== 'processing') return `skipped:${ev.status}`;
    const d = ev.payload.data;
    let outcome: string;
    switch (ev.event_type) {
      case 'statement.credit':
        outcome = await processStatementCredit(
          tx,
          {
            statementLineId: String(d.statementLineId),
            asset: d.asset as Asset,
            amountMinor: toNumber(d.amountMinor as number),
            reference: String(d.reference ?? ''),
          },
          inboxId,
        );
        break;
      case 'payout.paid':
        outcome = await settleWithdrawal(tx, {
          clientReference: String(d.clientReference),
          statementLineId: String(d.statementLineId),
          amountMinor: toNumber(d.amountMinor as number),
        });
        break;
      case 'payout.returned':
        outcome = await failWithdrawal(tx, {
          clientReference: String(d.clientReference),
          reason: String(d.reason ?? 'Returned by beneficiary bank'),
        });
        break;
      default:
        throw new PermanentJobError(`Unsupported partner event type ${ev.event_type}`);
    }
    await tx.query(
      `UPDATE platform.inbox SET status = 'processed', processed_at = now(), last_error = $2 WHERE id = $1`,
      [
        inboxId,
        outcome === 'unmatched'
          ? 'Unmatched: no pending deposit claim for this reference, currency and amount'
          : null,
      ],
    );
    return outcome;
  });
}

export function registerCoreJobs(
  runner: Runner,
  deps: { pool: Pool; partnerSecret: string },
): void {
  const { pool, partnerSecret } = deps;
  runner
    .onJob('partner.process_event', async ({ job, log }) => {
      const outcome = await processPartnerEvent(pool, String(job.payload.inboxId));
      log.info({ outcome }, 'partner event processed');
    })
    .onJob('withdrawal.submit', async ({ job, log }) => {
      const r = await submitWithdrawal(
        pool,
        String(job.payload.withdrawalId),
        Number(job.payload.attempt ?? 1),
      );
      log.info({ outcome: r }, 'withdrawal submit');
    })
    .onJob('withdrawal.query_status', async ({ job, log }) => {
      const r = await queryWithdrawalStatus(
        pool,
        String(job.payload.withdrawalId),
        Number(job.payload.attempt ?? 1),
      );
      log.info({ outcome: r }, 'withdrawal status query');
    })
    .onJob('sandbox.partner_complete_payout', async ({ job }) => {
      await partnerCompletePayout(pool, partnerSecret, String(job.payload.partnerReference));
    });
}
