'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useData } from '@/components/session';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  Field,
  Grid,
  Input,
  Loading,
  Money,
  PageHeader,
  StatusBadge,
  Table,
} from '@/components/ui';
import { api, ApiError, type EntitySummary, type Quote } from '@/lib/api';
import { dateTime, money, parseMoney, rate } from '@/lib/format';
import { CustomerOnly, messageFor, NOT_APPROVED_COPY, rateSourceLabel } from '../_lib/common';
import c from '../_lib/customer.module.css';

type Side = Quote['side'];

const SIDE_LABEL: Record<Side, string> = {
  buy_usd: 'Buy USD — pay TTD',
  sell_usd: 'Sell USD — receive TTD',
};

const ERRORS: Record<string, string> = {
  insufficient_available_funds:
    'You do not have enough available balance for this exchange. Pending deposits cannot be used until they clear.',
  quote_expired: 'This quote expired. Request a new quote to continue.',
  principal_inventory_insufficient:
    'We cannot fill this amount right now. Try a smaller amount or try again later.',
  not_approved: NOT_APPROVED_COPY,
};

export default function ExchangePage() {
  return <CustomerOnly title="Exchange">{(e) => <Exchange entity={e} />}</CustomerOnly>;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function Exchange({ entity }: { entity: EntitySummary }) {
  const approved = entity.onboardingStatus === 'approved';
  const balances = useData(() => api.balances(entity.id), [entity.id]);
  const trades = useData(
    () => (approved ? api.trades(entity.id) : Promise.resolve([] as Quote[])),
    [entity.id, approved],
  );

  const [side, setSide] = useState<Side>(entity.customerRole === 'seller' ? 'sell_usd' : 'buy_usd');
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [accepting, setAccepting] = useState(false);
  // One idempotency key per quote: a double click or a retry cannot trade twice.
  const keyRef = useRef<{ quoteId: string; key: string } | null>(null);

  const now = useNow(quote !== null && quote.status === 'open');
  const secondsLeft = quote
    ? Math.max(0, Math.floor((new Date(quote.expiresAt).getTime() - now) / 1000))
    : 0;
  const expired = quote !== null && (quote.status === 'expired' || secondsLeft <= 0);

  async function getQuote(e: FormEvent) {
    e.preventDefault();
    const minor = parseMoney(amount);
    if (minor === null) {
      setAmountError('Enter a USD amount greater than zero with up to 2 decimal places.');
      return;
    }
    setAmountError(null);
    setError(null);
    setSuccess(null);
    setQuoting(true);
    try {
      const q = await api.createQuote(entity.id, { side, usdMinor: minor });
      keyRef.current = { quoteId: q.id, key: crypto.randomUUID() };
      setQuote(q);
    } catch (err) {
      setQuote(null);
      setError(messageFor(err, ERRORS));
    } finally {
      setQuoting(false);
    }
  }

  async function accept() {
    if (!quote || expired || accepting) return;
    if (!keyRef.current || keyRef.current.quoteId !== quote.id) {
      keyRef.current = { quoteId: quote.id, key: crypto.randomUUID() };
    }
    setAccepting(true);
    setError(null);
    try {
      const done = await api.acceptQuote(entity.id, quote.id, keyRef.current.key);
      setSuccess(done);
      setQuote(null);
      setAmount('');
      await Promise.all([balances.reload(), trades.reload()]);
    } catch (err) {
      setError(messageFor(err, ERRORS));
      if (err instanceof ApiError && err.code === 'quote_expired') {
        setQuote({ ...quote, status: 'expired' });
      }
    } finally {
      setAccepting(false);
    }
  }

  const pays = quote
    ? quote.side === 'buy_usd'
      ? money(quote.ttdMinor, 'TTD')
      : money(quote.usdMinor, 'USD')
    : '';
  const receives = quote
    ? quote.side === 'buy_usd'
      ? money(quote.usdMinor, 'USD')
      : money(quote.ttdMinor, 'TTD')
    : '';

  return (
    <>
      <PageHeader
        title="Exchange"
        description="Exchange between your USD and TTD balances. Request a quote, review it, then confirm before it expires."
      />

      {!approved && (
        <Alert tone="warning" title="Verification required">
          {NOT_APPROVED_COPY} <a href="/settings">Go to Account & verification</a>
        </Alert>
      )}

      {success && (
        <Alert tone="success" title="Exchange complete">
          You exchanged{' '}
          {success.side === 'buy_usd'
            ? `${money(success.ttdMinor, 'TTD')} for ${money(success.usdMinor, 'USD')}`
            : `${money(success.usdMinor, 'USD')} for ${money(success.ttdMinor, 'TTD')}`}{' '}
          at {rate(success.rateE4)} TTD per USD. Your balances have been updated.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <Grid min={300}>
        <div className={c.stack}>
          <Card title="Request a quote">
            <form onSubmit={getQuote} noValidate>
              <fieldset className={c.fieldset}>
                <legend>What would you like to do?</legend>
                <div className={c.radioRow}>
                  {(['buy_usd', 'sell_usd'] as Side[]).map((s) => (
                    <label key={s} className={c.radio}>
                      <input
                        type="radio"
                        name="side"
                        value={s}
                        checked={side === s}
                        onChange={() => {
                          setSide(s);
                          setQuote(null);
                        }}
                        disabled={!approved}
                      />
                      {SIDE_LABEL[s]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field
                label="Amount in USD"
                error={amountError}
                hint={
                  side === 'buy_usd'
                    ? 'The US dollars you want to buy.'
                    : 'The US dollars you will sell.'
                }
              >
                {(id, describedBy) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    aria-describedby={describedBy}
                    aria-invalid={amountError ? true : undefined}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setQuote(null);
                    }}
                    disabled={!approved}
                  />
                )}
              </Field>
              <Button
                type="submit"
                variant={quote ? 'secondary' : 'primary'}
                busy={quoting}
                disabled={!approved || !amount}
              >
                {quote ? 'Get a new quote' : 'Get quote'}
              </Button>
            </form>
          </Card>

          {quote && (
            <section
              className={expired ? c.quoteExpired : c.quote}
              aria-labelledby="quote-title"
              aria-live="polite"
            >
              <h2 id="quote-title" style={{ fontSize: 18 }}>
                Your quote
              </h2>
              <DefinitionList
                items={[
                  [
                    'You pay',
                    <strong key="p" className="num">
                      {pays}
                    </strong>,
                  ],
                  [
                    'You receive',
                    <strong key="r" className="num">
                      {receives}
                    </strong>,
                  ],
                  [
                    'Rate',
                    <span key="x" className="num">
                      {rate(quote.rateE4)} TTD per USD
                    </span>,
                  ],
                  ['Rate source', rateSourceLabel(quote.rateSource, quote.parentLegalName)],
                  ['Fees', 'None'],
                ]}
              />
              {quote.parentMarginMinor > 0 && (
                <p className={c.small} style={{ marginTop: 12 }}>
                  Your network parent earns {money(quote.parentMarginMinor, 'TTD')} on this trade.
                  {quote.parentLegalName ? ` Parent: ${quote.parentLegalName}.` : ''} This is
                  informational and is already reflected in your rate.
                </p>
              )}
              <div style={{ marginTop: 16 }}>
                {expired ? (
                  <Alert tone="warning">This quote expired. Request a new quote to continue.</Alert>
                ) : (
                  <p className={c.countdown} role="timer" aria-live="off">
                    This quote expires in {Math.floor(secondsLeft / 60)}:
                    {String(secondsLeft % 60).padStart(2, '0')}
                  </p>
                )}
                <Button
                  type="button"
                  onClick={() => void accept()}
                  busy={accepting}
                  disabled={expired}
                >
                  Confirm exchange
                </Button>
              </div>
            </section>
          )}
        </div>

        <Card title="Available balances" tone="lavender">
          {balances.error && <Alert tone="error">{balances.error}</Alert>}
          {balances.loading && !balances.data ? (
            <Loading />
          ) : (
            <>
              <DefinitionList
                items={(balances.data ?? []).map((b) => [
                  `Available ${b.asset}`,
                  <strong key={b.asset} className="num">
                    {money(b.availableMinor, b.asset)}
                  </strong>,
                ])}
              />
              {(balances.data ?? []).some((b) => b.pendingDepositsMinor > 0) && (
                <div className={c.pending}>
                  Pending deposits (not yet available):{' '}
                  {(balances.data ?? [])
                    .filter((b) => b.pendingDepositsMinor > 0)
                    .map((b) => money(b.pendingDepositsMinor, b.asset))
                    .join(', ')}
                  . These cannot be exchanged until they clear.
                </div>
              )}
              {balances.data && balances.data.length === 0 && <p>No balances yet.</p>}
            </>
          )}
        </Card>
      </Grid>

      {approved && (
        <Card title="Your exchanges">
          {trades.error && <Alert tone="error">{trades.error}</Alert>}
          {trades.loading && !trades.data ? (
            <Loading />
          ) : (
            <Table
              head={['Date', 'Type', 'USD', 'TTD', 'Rate (TTD per USD)', 'Status']}
              empty="No exchanges yet."
            >
              {(trades.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>{dateTime(t.acceptedAt ?? t.createdAt)}</td>
                  <td>{t.side === 'buy_usd' ? 'Bought USD' : 'Sold USD'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Money minor={t.usdMinor} asset="USD" />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Money minor={t.ttdMinor} asset="TTD" />
                  </td>
                  <td className="num">{rate(t.rateE4)}</td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
