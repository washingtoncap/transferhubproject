'use client';

import { useState } from 'react';
import { useData } from '@/components/session';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  Grid,
  Loading,
  Money,
  PageHeader,
  StatusBadge,
  Table,
  Tabs,
} from '@/components/ui';
import { api, type EntitySummary, type Plan, type SubscriptionOverview } from '@/lib/api';
import { date, money, rate } from '@/lib/format';
import { CustomerOnly, messageFor, NOT_APPROVED_COPY } from '../_lib/common';
import c from '../_lib/customer.module.css';

type Interval = 'monthly' | 'annual';

const ERRORS: Record<string, string> = {
  insufficient_available_funds:
    'Your available TTD balance is not enough to pay for this plan. Fund your TTD balance first.',
  not_approved: NOT_APPROVED_COPY,
};

export default function BillingPage() {
  return <CustomerOnly title="Plans & billing">{(e) => <Billing entity={e} />}</CustomerOnly>;
}

function Billing({ entity }: { entity: EntitySummary }) {
  const approved = entity.onboardingStatus === 'approved';
  const plans = useData(() => api.plans(), []);
  const overview = useData(() => api.subscription(entity.id), [entity.id]);
  const [interval, setBillingInterval] = useState<Interval>('monthly');
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const myPlans = (plans.data ?? []).filter((p) => p.audience === entity.customerRole);
  const ov = overview.data;
  const current = ov?.subscription && ov.subscription.status !== 'cancelled' ? ov : null;

  return (
    <>
      <PageHeader
        title="Plans & billing"
        description="Plans give you a better rate on USD up to a monthly rate-eligible volume. Plan fees are charged to your TTD balance."
      />
      <Alert tone="info">
        A subscription does not guarantee liquidity or higher limits. Card allowances are not active
        in this release.
      </Alert>
      {!approved && <Alert tone="warning">{NOT_APPROVED_COPY}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}

      <CurrentPlan
        entity={entity}
        overview={ov}
        loading={overview.loading && !ov}
        error={overview.error}
        onChange={async (msg) => {
          setMessage(msg);
          await overview.reload();
        }}
      />

      <div className={c.rowEnd} style={{ justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 20 }}>Available plans</h2>
        <Tabs<Interval>
          label="Billing interval"
          value={interval}
          onChange={setBillingInterval}
          options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'annual', label: 'Annual' },
          ]}
        />
      </div>
      <p className={c.small} style={{ marginBottom: 16 }}>
        Annual = 10 monthly payments.
      </p>

      {plans.error && <Alert tone="error">{plans.error}</Alert>}
      {plans.loading && !plans.data ? (
        <Loading label="Loading plans…" />
      ) : myPlans.length === 0 ? (
        <Alert tone="info">No plans are available for your account type.</Alert>
      ) : (
        <Grid min={250}>
          {myPlans.map((p) => {
            const isCurrent = current?.plan?.code === p.code;
            return (
              <div key={p.code} className={isCurrent ? c.planCurrent : undefined}>
                <PlanCard
                  plan={p}
                  role={entity.customerRole}
                  interval={interval}
                  isCurrent={isCurrent}
                  currentInterval={current?.subscription?.billingInterval ?? null}
                  selected={selected === p.code}
                  disabled={!approved}
                  onSelect={() => setSelected(p.code)}
                />
              </div>
            );
          })}
        </Grid>
      )}

      {selected && (
        <SubscribeForm
          entity={entity}
          plan={myPlans.find((p) => p.code === selected) ?? null}
          interval={interval}
          onCancel={() => setSelected(null)}
          onDone={async (msg) => {
            setSelected(null);
            setMessage(msg);
            await overview.reload();
          }}
        />
      )}

      <Card title="Invoices">
        {ov ? (
          <Table
            head={['Number', 'Description', 'Period', 'Amount', 'Status']}
            empty="No invoices yet."
          >
            {ov.invoices.map((i) => (
              <tr key={i.id}>
                <td className={c.mono}>{i.number}</td>
                <td>{i.description}</td>
                <td>
                  {date(i.periodStart)} – {date(i.periodEnd)}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Money minor={i.amountMinor} asset={i.currency} />
                </td>
                <td>
                  <StatusBadge status={i.status} />
                </td>
              </tr>
            ))}
          </Table>
        ) : overview.loading ? (
          <Loading />
        ) : (
          <p>No invoices.</p>
        )}
      </Card>
    </>
  );
}

function PlanCard({
  plan: p,
  role,
  interval,
  isCurrent,
  currentInterval,
  selected,
  disabled,
  onSelect,
}: {
  plan: Plan;
  role: EntitySummary['customerRole'];
  interval: Interval;
  isCurrent: boolean;
  currentInterval: Interval | null;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const sameAsCurrent = isCurrent && currentInterval === interval;
  return (
    <Card
      title={
        <span className={c.row}>
          {p.name}
          {isCurrent && <StatusBadge status="active" label="Current plan" />}
        </span>
      }
      footer={
        <Button
          type="button"
          variant={selected ? 'primary' : 'secondary'}
          disabled={disabled || sameAsCurrent}
          onClick={onSelect}
        >
          {sameAsCurrent
            ? 'Your current plan'
            : isCurrent
              ? `Switch to ${interval}`
              : `Choose ${p.name}`}
        </Button>
      }
    >
      <div className={c.price}>
        {money(interval === 'monthly' ? p.monthlyMinor : p.annualMinor, 'TTD')}
        <span className={c.muted} style={{ fontWeight: 400 }}>
          {' '}
          / {interval === 'monthly' ? 'month' : 'year'}
        </span>
      </div>
      <p className={c.small} style={{ marginBottom: 12 }}>
        {interval === 'monthly'
          ? `Or ${money(p.annualMinor, 'TTD')} a year`
          : `Instead of ${money(p.monthlyMinor * 12, 'TTD')} paid monthly`}
      </p>
      <DefinitionList
        items={[
          [
            'Rate',
            <span key="r" className="num">
              {rate(p.usdRateE4)} TTD per USD
            </span>,
          ],
          ['Monthly rate-eligible volume', money(p.volumeAllowanceUsdMinor, 'USD')],
          ...(role === 'seller'
            ? ([['Network children', String(p.childLimit)]] as Array<[string, string]>)
            : []),
          ['Staff seats', String(p.staffSeats)],
        ]}
      />
    </Card>
  );
}

function SubscribeForm({
  entity,
  plan,
  interval,
  onCancel,
  onDone,
}: {
  entity: EntitySummary;
  plan: Plan | null;
  interval: Interval;
  onCancel: () => void;
  onDone: (msg: string) => Promise<void>;
}) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!plan) return null;
  const price = money(interval === 'monthly' ? plan.monthlyMinor : plan.annualMinor, 'TTD');

  async function subscribe() {
    if (!plan || !consent) return;
    setBusy(true);
    setError(null);
    try {
      await api.subscribe(entity.id, {
        planCode: plan.code,
        billingInterval: interval,
        consent: true,
      });
      await onDone(
        `You are now on the ${plan.name} plan (${interval}). ${price} was charged to your TTD balance.`,
      );
    } catch (err) {
      setError(messageFor(err, ERRORS));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Confirm ${plan.name} (${interval})`} tone="lavender">
      {error && <Alert tone="error">{error}</Alert>}
      <p style={{ marginTop: 0 }}>
        {price} will be charged to your available TTD balance today, and again at the start of each{' '}
        {interval === 'monthly' ? 'month' : 'year'} until you cancel.
      </p>
      <label className={c.check}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I authorise TransferHub to charge {price} to my TTD balance.</span>
      </label>
      <div className={c.row}>
        <Button type="button" disabled={!consent} busy={busy} onClick={() => void subscribe()}>
          Subscribe and pay {price}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function CurrentPlan({
  entity,
  overview,
  loading,
  error,
  onChange,
}: {
  entity: EntitySummary;
  overview: SubscriptionOverview | null;
  loading: boolean;
  error: string | null;
  onChange: (msg: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (loading || !overview) return <Loading />;
  const { subscription: sub, plan, usage } = overview;

  async function cancel() {
    if (!window.confirm('Cancel your plan at the end of the current period?')) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.cancelSubscription(entity.id);
      await onChange('Your plan will end at the close of the current period.');
    } catch (err) {
      setActionError(messageFor(err, ERRORS));
    } finally {
      setBusy(false);
    }
  }

  const allowance = usage.allowanceUsdMinor;
  const pct = allowance ? Math.min(100, Math.round((usage.usdVolumeMinor / allowance) * 100)) : 0;

  return (
    <Card title="Current subscription">
      {actionError && <Alert tone="error">{actionError}</Alert>}
      {sub && plan && sub.status !== 'cancelled' ? (
        <Grid min={260}>
          <DefinitionList
            items={[
              ['Plan', plan.name],
              ['Status', <StatusBadge key="s" status={sub.status} />],
              ['Billing', sub.billingInterval === 'monthly' ? 'Monthly' : 'Annual'],
              [
                sub.status === 'cancel_at_period_end' ? 'Ends' : 'Renews',
                date(sub.currentPeriodEnd),
              ],
              ['Plan rate', `${rate(plan.usdRateE4)} TTD per USD`],
            ]}
          />
          <div>
            <p className={c.small}>Rate-eligible USD volume this month</p>
            {allowance ? (
              <>
                <div
                  className={c.meter}
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={allowance}
                  aria-valuenow={Math.min(usage.usdVolumeMinor, allowance)}
                  aria-label="Rate-eligible volume used"
                >
                  <div className={c.meterFill} style={{ width: `${pct}%` }} />
                </div>
                <p style={{ margin: 0 }} className="num">
                  {money(usage.usdVolumeMinor, 'USD')} of {money(allowance, 'USD')} ({pct}%)
                </p>
                <p className={c.small}>Trades above the allowance use the standard rate.</p>
              </>
            ) : (
              <p className="num">{money(usage.usdVolumeMinor, 'USD')}</p>
            )}
            {sub.status === 'active' && (
              <div style={{ marginTop: 12 }}>
                <Button type="button" variant="danger" busy={busy} onClick={() => void cancel()}>
                  Cancel at period end
                </Button>
              </div>
            )}
          </div>
        </Grid>
      ) : (
        <p style={{ margin: 0 }}>
          You have no active plan. Exchanges use the standard rate. This month you have traded{' '}
          <span className="num">{money(usage.usdVolumeMinor, 'USD')}</span>.
        </p>
      )}
    </Card>
  );
}
