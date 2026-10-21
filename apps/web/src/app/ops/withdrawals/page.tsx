'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { api, type OpsWithdrawal, type WithdrawalStatus } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Loading,
  Money,
  PageHeader,
  StatusBadge,
  Table,
  Tabs,
} from '@/components/ui';
import { errorMessage, useData } from '@/components/session';
import { useAutoRefresh } from '../_shared/hooks';
import s from '../_shared/ops.module.css';

type Tab = 'pending' | 'inflight' | 'settled' | 'failed' | 'all';

const TAB_STATUSES: Record<Exclude<Tab, 'all'>, WithdrawalStatus[]> = {
  pending: ['pending_approval'],
  inflight: ['approved', 'submitted', 'status_unknown'],
  settled: ['settled'],
  failed: ['failed', 'rejected'],
};

type Action = { id: string; kind: 'approve' | 'reject' };

function ActionForm({
  w,
  kind,
  onDone,
  onCancel,
}: {
  w: OpsWithdrawal;
  kind: 'approve' | 'reject';
  onDone: (w: OpsWithdrawal, kind: 'approve' | 'reject') => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = money(w.amountMinor, w.asset);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'reject' && !reason.trim()) {
      setError('A reason is required to reject a withdrawal.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated =
        kind === 'approve'
          ? await api.ops.approveWithdrawal(w.id, reason.trim() || undefined)
          : await api.ops.rejectWithdrawal(w.id, reason.trim());
      onDone(updated, kind);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={s.inlineForm} onSubmit={submit} noValidate>
      <Field
        label={kind === 'approve' ? 'Approval note (optional)' : 'Rejection reason (required)'}
        error={error}
      >
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
            maxLength={500}
          />
        )}
      </Field>
      <div className={s.actions}>
        <Button type="submit" variant={kind === 'approve' ? 'primary' : 'danger'} busy={busy}>
          {kind === 'approve' ? `Approve ${amount} withdrawal` : `Reject ${amount} withdrawal`}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function OpsWithdrawalsPage() {
  const [tab, setTab] = useState<Tab>('pending');
  // Load all and filter locally: several tabs span more than one status.
  const { data, error, reload } = useData(() => api.ops.withdrawals(), []);
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useAutoRefresh(() => {
    // Pause while an approve/reject form is open so the row does not shift under the user.
    if (!action) return reload();
  }, 5_000);

  const rows = useMemo(() => {
    if (!data) return [];
    if (tab === 'all') return data;
    const st = TAB_STATUSES[tab];
    return data.filter((w) => st.includes(w.status));
  }, [data, tab]);

  const pendingCount = data?.filter((w) => w.status === 'pending_approval').length ?? 0;

  return (
    <>
      <PageHeader
        title="Withdrawals"
        description="Maker/checker approval of customer payouts. Refreshes every 5 seconds."
      />
      <Alert tone="info" title="Maker/checker">
        Withdrawals of US$5,000 equivalent or more need two different approvers. You cannot approve
        twice.
      </Alert>
      <Card title="Sandbox payout simulator" tone="lavender">
        <ul className={s.small} style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Amounts ending in <strong className="num">.99</strong> are returned by the simulated
            bank: the withdrawal becomes <StatusBadge status="failed" /> and the customer’s hold is
            released.
          </li>
          <li>
            Amounts ending in <strong className="num">.77</strong> time out: the withdrawal shows{' '}
            <StatusBadge status="status_unknown" /> until a follow-up status query resolves it.
          </li>
          <li>Any other amount settles normally.</li>
        </ul>
      </Card>
      <div style={{ height: 16 }} />
      <Tabs
        label="Withdrawal status"
        value={tab}
        onChange={setTab}
        options={[
          {
            value: 'pending',
            label: `Pending approval${pendingCount ? ` (${pendingCount})` : ''}`,
          },
          { value: 'inflight', label: 'Approved / submitted' },
          { value: 'settled', label: 'Settled' },
          { value: 'failed', label: 'Failed / rejected' },
          { value: 'all', label: 'All' },
        ]}
      />
      {notice && (
        <Alert tone="success" title="Done">
          {notice}
        </Alert>
      )}
      {error && (
        <Alert tone="error" title="Could not load withdrawals">
          {error}
        </Alert>
      )}
      {!data && !error && <Loading />}
      {data && (
        <Table
          caption={`${rows.length} withdrawal${rows.length === 1 ? '' : 's'}`}
          head={[
            'Reference',
            'Customer',
            'Beneficiary',
            'Amount',
            'Status',
            'Approvals',
            'Requested by',
            'Created',
            'Actions',
          ]}
          empty="No withdrawals in this view."
        >
          {rows.map((w) => {
            const open = action?.id === w.id ? action : null;
            return (
              <tr key={w.id}>
                <td>
                  <code className={s.code}>{w.reference}</code>
                </td>
                <td>
                  <a
                    className={s.rowLink}
                    href={`/ops/customers/${encodeURIComponent(w.entity.id)}`}
                  >
                    {w.entity.legalName}
                  </a>
                </td>
                <td>
                  {w.beneficiary.label}
                  <div className={`${s.muted} ${s.nowrap}`}>
                    {w.beneficiary.bankName} · ••••{w.beneficiary.accountLast4}
                  </div>
                </td>
                <td>
                  <Money minor={w.amountMinor} asset={w.asset} />
                </td>
                <td>
                  <StatusBadge status={w.status} />
                  {w.failureReason && <div className={s.muted}>{w.failureReason}</div>}
                </td>
                <td>
                  <span className="num">
                    {w.approvals}/{w.requiredApprovals}
                  </span>
                  {w.approvers.length > 0 && (
                    <ul className={s.small} style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                      {w.approvers.map((a, i) => (
                        <li key={`${a.name}-${i}`}>
                          {a.name} — {a.decision === 'approve' ? 'approved' : 'rejected'}{' '}
                          <span className={s.muted}>{dateTime(a.at)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{w.requestedBy}</td>
                <td className={s.nowrap}>{dateTime(w.createdAt)}</td>
                <td>
                  {w.status === 'pending_approval' && w.canAct && !open && (
                    <div className={s.actions}>
                      <Button
                        onClick={() => {
                          setNotice(null);
                          setAction({ id: w.id, kind: 'approve' });
                        }}
                        aria-label={`Approve withdrawal ${w.reference}`}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          setNotice(null);
                          setAction({ id: w.id, kind: 'reject' });
                        }}
                        aria-label={`Reject withdrawal ${w.reference}`}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                  {w.status === 'pending_approval' && !w.canAct && (
                    <span className={s.muted}>You have already acted or cannot approve this.</span>
                  )}
                  {open && (
                    <ActionForm
                      w={w}
                      kind={open.kind}
                      onCancel={() => setAction(null)}
                      onDone={(u, kind) => {
                        setAction(null);
                        setNotice(
                          kind === 'approve'
                            ? `Approval recorded for ${u.reference} (${u.approvals}/${u.requiredApprovals}). Status: ${u.status.replace(/_/g, ' ')}.`
                            : `Withdrawal ${u.reference} rejected; the customer's hold is released.`,
                        );
                        void reload();
                      }}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
