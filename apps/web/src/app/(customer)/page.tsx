'use client';

import { useData } from '@/components/session';
import {
  Alert,
  Card,
  DefinitionList,
  Grid,
  Loading,
  Money,
  PageHeader,
  StatusBadge,
  Table,
} from '@/components/ui';
import { api, type Balance, type EntityDetail, type EntitySummary } from '@/lib/api';
import { dateTime, humanize, money, rate } from '@/lib/format';
import { CustomerOnly, RESTRICTED_COPY } from './_lib/common';
import c from './_lib/customer.module.css';

export default function OverviewPage() {
  return <CustomerOnly title="Overview">{(entity) => <Overview entity={entity} />}</CustomerOnly>;
}

function Overview({ entity }: { entity: EntitySummary }) {
  const detail = useData(() => api.entity(entity.id), [entity.id]);
  const balances = useData(() => api.balances(entity.id), [entity.id]);
  const activity = useData(() => api.activity(entity.id, 8), [entity.id]);
  const approved = entity.onboardingStatus === 'approved';

  return (
    <>
      <PageHeader
        title="Overview"
        description={`${entity.legalName} · ${humanize(entity.customerRole)} account · Reference ${entity.referenceCode}`}
      />

      {!approved && <VerificationCard entity={entity} detail={detail.data} />}

      <h2 className={c.assetLabel}>Balances</h2>
      {balances.error && <Alert tone="error">{balances.error}</Alert>}
      {balances.loading && !balances.data ? (
        <Loading label="Loading balances…" />
      ) : balances.data && balances.data.length === 0 ? (
        <Alert tone="info">No balances yet. Fund your account to get started.</Alert>
      ) : (
        <Grid min={260}>
          {(balances.data ?? []).map((b) => (
            <BalanceCard key={b.asset} balance={b} />
          ))}
        </Grid>
      )}

      <Grid min={260}>
        <Card title="Quick actions">
          <div className={c.row}>
            <a className={c.actionLink} href="/fund">
              Fund
            </a>
            <a className={c.actionLink} href="/exchange">
              Exchange
            </a>
            <a className={c.actionLink} href="/withdrawals">
              Withdraw
            </a>
          </div>
          {!approved && (
            <p className={c.small} style={{ marginTop: 12 }}>
              Funding, exchange and withdrawals open once your account is verified.
            </p>
          )}
        </Card>
        <PlanCard detail={detail.data} loading={detail.loading} error={detail.error} />
      </Grid>

      <Card title="Recent activity" footer={<a href="/statements">View full statements</a>}>
        {activity.error && <Alert tone="error">{activity.error}</Alert>}
        {activity.loading && !activity.data ? (
          <Loading />
        ) : (
          <Table
            caption="Last 8 ledger entries, Port of Spain time"
            head={['Date', 'Description', 'Amount']}
            empty="No activity yet."
          >
            {(activity.data ?? []).map((a) => (
              <tr key={a.postingId}>
                <td>{dateTime(a.at)}</td>
                <td>
                  {a.memo}
                  <div className={c.small}>{humanize(a.lineType)}</div>
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Money minor={a.amountMinor} asset={a.asset} signed />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

function BalanceCard({ balance: b }: { balance: Balance }) {
  return (
    <Card>
      <p className={c.assetLabel}>{b.asset === 'USD' ? 'US dollars (USD)' : 'TT dollars (TTD)'}</p>
      <p className={c.small}>Available</p>
      <div className={c.big}>{money(b.availableMinor, b.asset)}</div>
      <div style={{ marginTop: 12 }}>
        <DefinitionList
          items={[
            ['Ledger', <Money key="l" minor={b.ledgerMinor} asset={b.asset} />],
            ['Held for withdrawals', <Money key="h" minor={b.heldMinor} asset={b.asset} />],
          ]}
        />
      </div>
      {b.pendingDepositsMinor > 0 && (
        <div className={c.pending}>
          Pending deposits (not yet available)
          <strong>{money(b.pendingDepositsMinor, b.asset)}</strong>
          Awaiting partner clearance. Not spendable yet.
        </div>
      )}
    </Card>
  );
}

function PlanCard({
  detail,
  loading,
  error,
}: {
  detail: EntityDetail | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card title="Your plan" footer={<a href="/billing">Plans & billing</a>}>
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !detail ? (
        <Loading />
      ) : detail ? (
        <>
          {detail.plan ? (
            <DefinitionList
              items={[
                ['Plan', detail.plan.name],
                [
                  'Status',
                  detail.subscription ? (
                    <StatusBadge status={detail.subscription.status} />
                  ) : (
                    'No subscription'
                  ),
                ],
                ['Plan rate', `${rate(detail.plan.usdRateE4)} TTD per USD`],
              ]}
            />
          ) : (
            <p>You are on the standard rate with no plan.</p>
          )}
          {detail.parent && (
            <p style={{ marginTop: 12 }}>
              Your rate: <strong className="num">{rate(detail.parent.childRateE4)}</strong> TTD per
              USD, set by {detail.parent.legalName}.
            </p>
          )}
        </>
      ) : null}
    </Card>
  );
}

function VerificationCard({
  entity,
  detail,
}: {
  entity: EntitySummary;
  detail: EntityDetail | null;
}) {
  const st = entity.onboardingStatus;
  if (st === 'rejected' || st === 'restricted' || st === 'closed') {
    return (
      <Alert tone="warning" title="Account status">
        {RESTRICTED_COPY}
      </Alert>
    );
  }
  const profileDone = st !== 'draft' && st !== 'needs_information';
  const reviewing = st === 'submitted' || st === 'vendor_checks' || st === 'compliance_review';
  return (
    <Card title="Verify your account" tone="lavender">
      <p style={{ marginTop: 0 }}>
        We need to verify your account before you can fund, exchange or withdraw.{' '}
        <StatusBadge status={st} />
      </p>
      <ol className={c.checklist}>
        <li>
          <span className={profileDone ? c.checkDone : c.checkMark} aria-hidden="true">
            {profileDone ? '✓' : '1'}
          </span>
          <div>
            <strong>Complete your profile</strong>{' '}
            <span className="visually-hidden">{profileDone ? '(done)' : '(to do)'}</span>
            {st === 'draft' && (
              <div>
                <a href="/settings">Complete your profile and submit it for verification</a>
              </div>
            )}
            {st === 'needs_information' && (
              <div>
                We need more information
                {detail?.reviewReason ? `: ${detail.reviewReason}` : '.'}{' '}
                <a href="/settings">Update your profile</a>
              </div>
            )}
          </div>
        </li>
        <li>
          <span className={c.checkMark} aria-hidden="true">
            2
          </span>
          <div>
            <strong>Verification review</strong>
            <div className={c.small}>
              {reviewing
                ? 'Under review. We will update this page when the review is complete.'
                : 'Starts when you submit your profile.'}
            </div>
          </div>
        </li>
      </ol>
    </Card>
  );
}
