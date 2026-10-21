'use client';

import { type FormEvent, useState } from 'react';
import { useData } from '@/components/session';
import {
  Alert,
  Button,
  Card,
  Field,
  Grid,
  Input,
  Loading,
  Money,
  PageHeader,
  Select,
  Stat,
  StatusBadge,
  Table,
} from '@/components/ui';
import {
  api,
  type EntityDetail,
  type EntitySummary,
  type Network,
  type NetworkInvitation,
  type NetworkLink,
} from '@/lib/api';
import { dateTime, money, parseMoney, parseRate, rate } from '@/lib/format';
import { CustomerOnly, messageFor, NOT_APPROVED_COPY } from '../_lib/common';
import c from '../_lib/customer.module.css';

const ERRORS: Record<string, string> = {
  not_approved: NOT_APPROVED_COPY,
  insufficient_available_funds: 'You do not have enough available TTD for this allocation.',
};

export default function NetworkPage() {
  return (
    <CustomerOnly title="Seller network">
      {(e) =>
        e.customerRole !== 'seller' ? (
          <>
            <PageHeader title="Seller network" />
            <Alert tone="info">The seller network is available to seller accounts only.</Alert>
          </>
        ) : (
          <SellerNetwork entity={e} />
        )
      }
    </CustomerOnly>
  );
}

function SellerNetwork({ entity }: { entity: EntitySummary }) {
  const detail = useData(() => api.entity(entity.id), [entity.id]);
  const invitations = useData(() => api.networkInvitations(entity.id), [entity.id]);

  return (
    <>
      <PageHeader
        title="Seller network"
        description="Main sellers can invite other sellers to sell under their rate and earn the difference on each trade."
      />
      {detail.error && <Alert tone="error">{detail.error}</Alert>}
      {detail.loading && !detail.data && <Loading />}

      {detail.data?.parent && (
        <Alert tone="info" title="You are part of a seller network">
          You sell under {detail.data.parent.legalName} at{' '}
          <span className="num">{rate(detail.data.parent.childRateE4)}</span> TTD per USD.
        </Alert>
      )}

      <Invitations
        entity={entity}
        invitations={invitations.data}
        error={invitations.error}
        loading={invitations.loading}
        onChange={async () => {
          await Promise.all([invitations.reload(), detail.reload()]);
        }}
      />

      {detail.data && !detail.data.parent && <ParentNetwork entity={entity} detail={detail.data} />}
    </>
  );
}

function Invitations({
  entity,
  invitations,
  error,
  loading,
  onChange,
}: {
  entity: EntitySummary;
  invitations: NetworkInvitation[] | null;
  error: string | null;
  loading: boolean;
  onChange: () => Promise<void>;
}) {
  const pending = (invitations ?? []).filter((i) => i.status === 'invited');
  if (loading && !invitations) return null;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (pending.length === 0) return null;
  return (
    <Card title="Invitations to join a network" tone="lavender">
      <div className={c.stack}>
        {pending.map((inv) => (
          <InvitationItem key={inv.id} entity={entity} inv={inv} onChange={onChange} />
        ))}
      </div>
    </Card>
  );
}

function InvitationItem({
  entity,
  inv,
  onChange,
}: {
  entity: EntitySummary;
  inv: NetworkInvitation;
  onChange: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function act(kind: 'accept' | 'decline') {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'accept') await api.acceptInvitation(entity.id, inv.id);
      else await api.declineInvitation(entity.id, inv.id);
      setDone(kind === 'accept' ? 'Invitation accepted.' : 'Invitation declined.');
      await onChange();
    } catch (err) {
      setError(messageFor(err, ERRORS));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={c.box}>
      {done && <Alert tone="success">{done}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <p style={{ marginTop: 0 }}>
        <strong>{inv.parent.legalName}</strong> invited you to sell under their network at{' '}
        <strong className="num">{rate(inv.childRateE4)}</strong> TTD per USD.
        <span className={c.small} style={{ display: 'block' }}>
          Invited {dateTime(inv.invitedAt)}
        </span>
      </p>
      {open ? (
        <>
          <div className={c.consent}>{inv.consentText}</div>
          <label className={c.check}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I have read and agree to the terms above.</span>
          </label>
          <div className={c.row}>
            <Button
              type="button"
              disabled={!agreed}
              busy={busy === 'accept'}
              onClick={() => void act('accept')}
            >
              Accept invitation
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Back
            </Button>
          </div>
        </>
      ) : (
        <div className={c.row}>
          <Button type="button" onClick={() => setOpen(true)}>
            Review and accept
          </Button>
          <Button
            type="button"
            variant="secondary"
            busy={busy === 'decline'}
            onClick={() => void act('decline')}
          >
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}

function ParentNetwork({ entity, detail }: { entity: EntitySummary; detail: EntityDetail }) {
  const network = useData(() => api.network(entity.id), [entity.id]);
  const n = network.data;
  if (network.error) return <Alert tone="error">{network.error}</Alert>;
  if (!n) return <Loading label="Loading your network…" />;

  if (n.childLimit === 0 && n.links.length === 0) {
    return (
      <Card title="Build your own seller network" tone="lavender">
        <p style={{ margin: 0 }}>
          Your current plan does not include child sellers. With a seller Network plan you can
          invite other sellers, set their rate between the floor of {rate(n.childFloorE4)} and your
          plan rate, and earn the difference on every US dollar they sell.{' '}
          <a href="/billing">Compare plans</a>.
        </p>
      </Card>
    );
  }

  const activeLinks = n.links.filter((l) => l.status === 'active');
  const exampleChild =
    activeLinks[0]?.childRateE4 ?? Math.max(n.childFloorE4, n.parentRateE4 - 3000);
  const exampleUsd = 100000; // US$1,000.00
  const childTtd = Math.round((exampleUsd * exampleChild) / 10000);
  const parentTtd = Math.round((exampleUsd * (n.parentRateE4 - exampleChild)) / 10000);

  return (
    <>
      <Grid min={180}>
        <Card>
          <Stat
            label="Active children"
            value={`${n.activeChildren} / ${n.childLimit}`}
            sub={detail.plan ? `${detail.plan.name} plan limit` : 'Plan limit'}
          />
        </Card>
        <Card>
          <Stat label="Total margin earned" value={money(n.earnings.totalMarginMinor, 'TTD')} />
        </Card>
        <Card>
          <Stat label="Last 30 days" value={money(n.earnings.last30DaysMarginMinor, 'TTD')} />
        </Card>
        <Card>
          <Stat
            label="Your rate"
            value={rate(n.parentRateE4)}
            sub={`TTD per USD · child floor ${rate(n.childFloorE4)}`}
          />
        </Card>
      </Grid>

      <Card title="How network margin works" tone="lavender">
        <p style={{ marginTop: 0 }}>
          Each child sells USD at the rate you set for them, which must be at or below your rate and
          at or above the floor of {rate(n.childFloorE4)} TTD per USD. You earn the difference.
        </p>
        <p style={{ marginBottom: 0 }}>
          At your rate {rate(n.parentRateE4)} and a child rate of {rate(exampleChild)}, when a child
          sells {money(exampleUsd, 'USD')}: the child receives {money(childTtd, 'TTD')}, you receive{' '}
          {money(parentTtd, 'TTD')}.
        </p>
      </Card>

      <Card title="Your children">
        <Table
          head={[
            'Child',
            'Reference',
            'Status',
            'Child rate (TTD per USD)',
            'Margin earned',
            'Child volume',
            '',
          ]}
          empty="No children yet. Invite a seller below."
        >
          {n.links.map((l) => (
            <LinkRow key={l.id} entity={entity} link={l} network={n} onChange={network.reload} />
          ))}
        </Table>
      </Card>

      <Grid min={300}>
        <InviteForm entity={entity} network={n} onDone={network.reload} />
        <AllocationForm entity={entity} links={activeLinks} onDone={network.reload} />
      </Grid>
    </>
  );
}

function validateChildRate(input: string, n: Network): { e4: number | null; error: string | null } {
  const e4 = parseRate(input);
  if (e4 === null) return { e4: null, error: 'Enter a rate with up to 4 decimals, e.g. 7.7000.' };
  if (e4 > n.parentRateE4)
    return { e4: null, error: `Must be at or below your rate of ${rate(n.parentRateE4)}.` };
  if (e4 < n.childFloorE4)
    return { e4: null, error: `Must be at or above the floor of ${rate(n.childFloorE4)}.` };
  return { e4, error: null };
}

function LinkRow({
  entity,
  link: l,
  network,
  onChange,
}: {
  entity: EntitySummary;
  link: NetworkLink;
  network: Network;
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(rate(l.childRateE4));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = l.status === 'active' || l.status === 'invited';

  async function save() {
    const v = validateChildRate(value, network);
    if (v.e4 === null) {
      setError(v.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setChildRate(entity.id, l.id, v.e4);
      setEditing(false);
      await onChange();
    } catch (err) {
      setError(messageFor(err, ERRORS));
    } finally {
      setBusy(false);
    }
  }

  async function detach() {
    if (
      !window.confirm(
        `Detach ${l.child.legalName} from your network? They will return to the standard rate.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.detachChild(entity.id, l.id);
      await onChange();
    } catch (err) {
      setError(messageFor(err, ERRORS));
    } finally {
      setBusy(false);
    }
  }

  const inputId = `rate-${l.id}`;
  return (
    <tr>
      <td>{l.child.legalName}</td>
      <td className={c.mono}>{l.child.referenceCode}</td>
      <td>
        <StatusBadge status={l.status} />
      </td>
      <td>
        {editing ? (
          <div>
            <div className={c.inlineRate}>
              <label htmlFor={inputId} className="visually-hidden">
                Child rate for {l.child.legalName}
              </label>
              <Input
                id={inputId}
                inputMode="decimal"
                value={value}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${inputId}-err` : undefined}
                onChange={(e) => setValue(e.target.value)}
              />
              <Button type="button" variant="secondary" busy={busy} onClick={() => void save()}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  setValue(rate(l.childRateE4));
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className={c.row}>
            <span className="num">{rate(l.childRateE4)}</span>
            {editable && (
              <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
                Change<span className="visually-hidden"> rate for {l.child.legalName}</span>
              </Button>
            )}
          </div>
        )}
        {error && (
          <p id={`${inputId}-err`} role="alert" className={c.inlineError}>
            {error}
          </p>
        )}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <Money minor={l.marginEarnedMinor} asset="TTD" />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <Money minor={l.childVolumeUsdMinor} asset="USD" />
      </td>
      <td>
        {editable && (
          <Button type="button" variant="danger" disabled={busy} onClick={() => void detach()}>
            Detach<span className="visually-hidden"> {l.child.legalName}</span>
          </Button>
        )}
      </td>
    </tr>
  );
}

function InviteForm({
  entity,
  network,
  onDone,
}: {
  entity: EntitySummary;
  network: Network;
  onDone: () => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [childRate, setChildRate] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<NetworkLink | null>(null);
  const [busy, setBusy] = useState(false);
  const atLimit = network.activeChildren >= network.childLimit;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const ref = code.trim().toUpperCase();
    if (!/^TH[A-Z0-9]{6}$/.test(ref))
      next.code = 'Enter a reference code like THPOS7K2 (TH + 6 letters or digits).';
    const v = validateChildRate(childRate, network);
    if (v.error) next.rate = v.error;
    setErrors(next);
    if (Object.keys(next).length > 0 || v.e4 === null) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const link = await api.inviteChild(entity.id, { childReferenceCode: ref, childRateE4: v.e4 });
      setDone(link);
      setCode('');
      setChildRate('');
      await onDone();
    } catch (err) {
      setError(messageFor(err, ERRORS));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Invite a seller">
      {atLimit && (
        <Alert tone="warning">
          You have reached your plan&apos;s limit of {network.childLimit} active children.{' '}
          <a href="/billing">See plans</a>
        </Alert>
      )}
      {done && <Alert tone="success">Invitation sent to {done.child.legalName}.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <form onSubmit={submit} noValidate>
        <Field
          label="Seller reference code"
          error={errors.code}
          hint="Ask the seller for the reference code shown on their Account & verification page."
        >
          {(id, describedBy) => (
            <Input
              id={id}
              value={code}
              maxLength={8}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={errors.code ? true : undefined}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field
          label="Child rate (TTD per USD)"
          error={errors.rate}
          hint={`Between ${rate(network.childFloorE4)} and ${rate(network.parentRateE4)}.`}
        >
          {(id, describedBy) => (
            <Input
              id={id}
              inputMode="decimal"
              value={childRate}
              aria-describedby={describedBy}
              aria-invalid={errors.rate ? true : undefined}
              onChange={(e) => setChildRate(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" busy={busy} disabled={atLimit}>
          Send invitation
        </Button>
      </form>
    </Card>
  );
}

function AllocationForm({
  entity,
  links,
  onDone,
}: {
  entity: EntitySummary;
  links: NetworkLink[];
  onDone: () => Promise<void>;
}) {
  const [childId, setChildId] = useState('');
  const [amount, setAmount] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const minor = parseMoney(amount);
    const child = links.find((l) => l.child.id === childId);
    if (!child) next.child = 'Choose an active child.';
    if (minor === null) next.amount = 'Enter a TTD amount greater than zero with up to 2 decimals.';
    setErrors(next);
    if (!child || minor === null) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.allocate(entity.id, { childEntityId: child.child.id, amountMinor: minor });
      setDone(`${money(minor, 'TTD')} allocated to ${child.child.legalName}.`);
      setAmount('');
      await onDone();
    } catch (err) {
      setError(messageFor(err, ERRORS));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Allocate TTD to a child" tone="lavender">
      <p style={{ marginTop: 0 }}>
        This moves your own available TTD to the child. It is not an FX trade and earns no margin.
      </p>
      {done && <Alert tone="success">{done}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {links.length === 0 ? (
        <p className={c.small}>You need at least one active child to allocate funds.</p>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label="Child" error={errors.child}>
            {(id, describedBy) => (
              <Select
                id={id}
                value={childId}
                aria-describedby={describedBy}
                onChange={(e) => setChildId(e.target.value)}
              >
                <option value="">Choose an active child</option>
                {links.map((l) => (
                  <option key={l.id} value={l.child.id}>
                    {l.child.legalName} ({l.child.referenceCode})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Amount (TTD)" error={errors.amount}>
            {(id, describedBy) => (
              <Input
                id={id}
                inputMode="decimal"
                value={amount}
                aria-describedby={describedBy}
                aria-invalid={errors.amount ? true : undefined}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" busy={busy}>
            Allocate TTD
          </Button>
        </form>
      )}
    </Card>
  );
}
