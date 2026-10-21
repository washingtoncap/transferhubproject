# Sandbox testing guide

Everything here is simulated: customers, balances, the bank and its statements. No real money.

**Password for every account:** `Sandbox!2026`

**Two-step code:** after the password, click **Fill sandbox code** on the sign-in page (in the
sandbox the code is filled for you; a real deployment uses an authenticator app).

## Sign-ins

### Quick role sign-ins

| Email                     | Lands on                           | What it is                                                                    |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| `admin@transferhub.com`   | Admin console (`/ops`)             | Everything: KYC, deposits, payouts, finance, ledger, rates, audit, system     |
| `finance@transferhub.com` | Finance dashboard (`/ops/finance`) | Revenue, positions, ledger, reconciliation, payout approvals, rates           |
| `buyer@transferhub.com`   | Customer app                       | Buyer — Caribbean Imports Ltd, Plus plan (rate 8.2200)                        |
| `seller@transferhub.com`  | Customer app                       | Main seller — Island Remit Agents Ltd, Network plan (rate 8.0000), 2 children |

### Staff

| Email                                 | Role               | Use it to                                               |
| ------------------------------------- | ------------------ | ------------------------------------------------------- |
| `compliance@transparenttransfers.com` | Compliance         | Approve / reject / request information on new customers |
| `ops@transparenttransfers.com`        | Operations         | Simulate bank credits, approve withdrawals              |
| `finance@transparenttransfers.com`    | Finance + treasury | Second approver on large withdrawals; rate policy       |
| `kyle@transparenttransfers.com`       | Admin              | Founder account                                         |

### Customers

| Email                                 | Customer                 | Situation                                                                                          |
| ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `marcus@islandremit.tt`               | Island Remit Agents Ltd  | Main seller (same account as `seller@`); TT$40,000 withdrawal awaiting 2nd approval                |
| `priya@postraders.tt`                 | Port of Spain Traders    | Child seller under Island Remit at 7.7000                                                          |
| `devon@sandoagents.tt`                | Devon Persad             | Child seller under Island Remit at 7.7000                                                          |
| `daniel.ramdial@example.tt`           | Daniel Ramdial           | Individual seller, no plan (7.4000); pending network invitation                                    |
| `ana@caribimports.tt`                 | Caribbean Imports Ltd    | Buyer (same account as `buyer@`); US$3,000 withdrawal awaiting approval; TT$25,000 deposit pending |
| `sasha.mohammed@example.tt`           | Sasha Mohammed           | New buyer under compliance review — cannot transact yet                                            |
| `compliance.demo@globalmatch.example` | Global Match Trading LLC | Under review with a sanctions/PEP "possible match"                                                 |

## Ten-minute tour

1. **Buyer buys USD** — `buyer@` → Exchange → Buy US$100 → quote at 8.2200 = TT$822.00, valid
   90 seconds → Confirm exchange. Balances update immediately.
2. **Child seller pays the parent** — `priya@` → Exchange → Sell US$100 at 7.7000 → TT$770.00.
   Sign in as `seller@` → Seller network: margin earned rises by TT$30.00.
3. **Deposit that must clear** — `buyer@` → Fund → TTD 1,000 → note the reference. The balance shows
   it as _pending_, not available. Sign in as `ops@` → Deposits → **Simulate credit** on that row →
   Send. Back as the buyer: TT$1,000.00 is now available. Press **Send again (duplicate)** in ops:
   nothing changes — duplicates post once.
4. **Withdrawal with maker/checker** — `seller@` → Withdrawals → request a payout (fill the sandbox
   code). Funds show as _held_. `ops@` → Withdrawals → Approve; amounts ≥ US$5,000 equivalent need
   a second approver (`finance@`). Within ~10 seconds the simulated bank pays it: **Settled**.
   - Amount ending **.99** → the bank returns it → **Failed**, hold released.
   - Amount ending **.77** → the bank's reply is lost → **Status unknown** → resolved by a status
     query → **Settled**, paid exactly once.
5. **Compliance** — `compliance@` → Customers & KYC → Sasha Mohammed → Approve (risk rating +
   reason). Sasha can now fund and trade.
6. **Seller network** — `daniel.ramdial@` → Seller network → accept the invitation (consent
   required). His sales now use the 7.6000 child rate and pay Island Remit the difference.
7. **Finance** — `finance@` → Finance, then Ledger (chart of accounts, every journal with debits =
   credits, per-account ledgers), then Reconciliation: USD matched; TTD shows the deliberate
   TT$1,500.00 unmatched bank credit (reference INV-4471) for investigation.

## Starting the sandbox yourself

Requires Node 22, pnpm 10 and PostgreSQL 16 (see README).

```bash
cp .env.example .env        # point DATABASE_URL at an empty database
scripts/sandbox.sh start    # builds, migrates, loads demo data, starts API + worker + web
# open http://localhost:3000
scripts/sandbox.sh stop
```
