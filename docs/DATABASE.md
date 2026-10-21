# Database and ledger reference

PostgreSQL 16. Four schemas, created by the versioned migrations in `packages/db/migrations`
(`0001_platform_foundation.sql`, `0002_fiat_prototype.sql`). All timestamps are `timestamptz`
stored in UTC. All money is `bigint` minor units (cents); FX rates are integers in ten-thousandths
of TTD per USD (8.2200 → `82200`). No floating point touches money.

| Schema     | Holds                                                                                                     | Who writes                              |
| ---------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `platform` | Audit log, outbox, inbox, background jobs, idempotency keys                                               | Shared platform library                 |
| `app`      | Users, sessions, customers, memberships, plans, FX quotes, deposits, withdrawals, seller network, billing | Business services (`packages/core`)     |
| `ledger`   | Double-entry subledger: accounts, journals, postings, holds                                               | Posting routines only                   |
| `sandbox`  | Simulated fiat partner: its own bank statement and payout desk                                            | Partner simulator (never in production) |

## The ledger

### Accounts (`ledger.accounts`)

| Account                           | Type               | Normal side | Meaning                                                                     |
| --------------------------------- | ------------------ | ----------- | --------------------------------------------------------------------------- |
| `system:provider_cash:USD/TTD`    | `provider_cash`    | Debit       | Cash the fiat partner holds for TransferHub's customers and principal       |
| `system:fx_principal:USD/TTD`     | `fx_principal`     | Credit      | The liquidity principal's own inventory (kept separate from customer money) |
| `system:platform_revenue:USD/TTD` | `platform_revenue` | Credit      | TransferHub's earned revenue: subscriptions and contracted FX share         |
| `customer:<entity>:USD/TTD`       | `customer`         | Credit      | What TransferHub owes each customer, one per currency                       |

The identity that reconciliation checks every day, per currency:

```
cash at partner = customer balances + principal inventory + TransferHub revenue
```

### Journals and postings

- `ledger.journals` — one row per business event (`kind` + `source_type` + `source_id` is unique,
  so a replayed event can never post twice).
- `ledger.postings` — the lines. Signed amounts: **positive = debit, negative = credit**.
- A deferred constraint trigger checks at COMMIT that every journal has at least two lines and that
  its lines sum to zero **in every currency**. An unbalanced journal cannot be saved by any code
  path, including manual SQL.
- Journals and postings are **append-only** (update, delete and truncate are rejected by trigger for
  every role). Corrections are new reversal journals.
- `ledger.holds` reserve part of a customer balance for a pending withdrawal.
  `available = balance − active holds`. A resolved hold cannot change.

### What each journal kind posts

| Kind                  | Debit                        | Credit                                                                                |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `opening_float`       | Cash at partner              | Principal inventory                                                                   |
| `deposit_cleared`     | Cash at partner              | Customer                                                                              |
| `fx_trade` (sell USD) | Customer USD · Principal TTD | Principal USD · Customer TTD (child rate) · Parent TTD (margin) · Revenue TTD (share) |
| `fx_trade` (buy USD)  | Customer TTD · Principal USD | Principal TTD (net of share) · Revenue TTD (share) · Customer USD                     |
| `allocation`          | Parent TTD                   | Child TTD                                                                             |
| `subscription_charge` | Customer TTD                 | Revenue TTD                                                                           |
| `withdrawal_settled`  | Customer                     | Cash at partner                                                                       |

Worked example (TH-REQ SEL-03): a child seller at 7.7000 under a parent at 8.0000 sells US$1,000.

| Account             | Debit       | Credit      |
| ------------------- | ----------- | ----------- |
| Child USD           | US$1,000.00 |             |
| Principal USD       |             | US$1,000.00 |
| Principal TTD       | TT$8,060.00 |             |
| Child TTD           |             | TT$7,700.00 |
| Parent TTD          |             | TT$300.00   |
| TransferHub revenue |             | TT$60.00    |

TransferHub's TT$60.00 (0.06 per USD, the TH-FIN base-case assumption) is paid by the principal,
not the customer. The parent's TT$300.00 is owed to the parent — it is not TransferHub revenue.

## Business tables (`app`)

| Table                                 | Purpose and key rules                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `users`                               | People. Staff carry `staff_roles` (operations, compliance, finance, treasury, admin).                    |
| `sessions`                            | Only a SHA-256 of each session token is stored; MFA completion recorded per session.                     |
| `entities`                            | Customers (individual or business; buyer or seller) with onboarding status and KYC profile.              |
| `memberships`                         | User ↔ customer with role owner/admin/approver/viewer. Every request is checked against it.              |
| `plans`                               | Tariff hypotheses from TH-MVP. `annual = 10 × monthly` is a CHECK constraint.                            |
| `rate_policy`                         | Standard rates, child floor, platform share, quote lifetime, dual-approval threshold.                    |
| `subscriptions`, `invoices`           | One live subscription per customer (unique index).                                                       |
| `seller_links`                        | Parent ↔ child. One parent per child; one level only (trigger); active requires consent.                 |
| `quotes`                              | Quote = price + expiry; accepted quote = trade, linked to its journal. Child rate ≤ parent rate (CHECK). |
| `deposit_claims`                      | Customer notice of an incoming transfer. Cleared only with a journal AND partner evidence (CHECK).       |
| `beneficiaries`                       | Payout accounts. Only the last four digits are stored.                                                   |
| `withdrawals`, `withdrawal_approvals` | Payout requests, holds and maker/checker approvals (one decision per staff member, append-only).         |

## Platform tables (`platform`)

| Table              | Purpose                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `audit_log`        | Append-only record of every action; per-row SHA-256; approver ≠ actor enforced.                 |
| `outbox`           | Events written in the same transaction as the change they describe.                             |
| `inbox`            | Partner webhooks, recorded once per authentic event id; forged events kept but never processed. |
| `jobs`             | Background work with leases, retries and dead-lettering.                                        |
| `idempotency_keys` | Stored responses for financial commands; same key + different body is refused.                  |

## Inspecting the data yourself

```bash
psql "$DATABASE_URL"
-- balances by account
SELECT * FROM ledger.balances ORDER BY type, code;
-- trial balance (must be zero in each currency)
SELECT asset, sum(amount_minor) FROM ledger.postings GROUP BY asset;
-- one journal with its lines
SELECT j.kind, j.memo, a.name, p.amount_minor FROM ledger.journals j
  JOIN ledger.postings p ON p.journal_id = j.id JOIN ledger.accounts a ON a.id = p.account_id
 ORDER BY j.created_at DESC LIMIT 20;
```

The same views are in the operations console under **Ledger** (finance, treasury and admin).
