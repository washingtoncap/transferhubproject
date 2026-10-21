'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, type OnboardingStatus } from '@/lib/api';
import { dateTime, humanize } from '@/lib/format';
import { Alert, Loading, PageHeader, StatusBadge, Table, Tabs } from '@/components/ui';
import { useData } from '@/components/session';
import { ScreeningBadge } from '../_shared/components';
import s from '../_shared/ops.module.css';

type Tab = 'queue' | 'approved' | 'all';

const QUEUE: OnboardingStatus[] = [
  'submitted',
  'vendor_checks',
  'compliance_review',
  'needs_information',
];

export default function OpsCustomersPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('queue');
  // One unfiltered load; the review queue spans four statuses and the API filters by one.
  const { data, error } = useData(() => api.ops.customers(), []);

  const rows = useMemo(() => {
    if (!data) return [];
    if (tab === 'queue') {
      return data
        .filter((c) => QUEUE.includes(c.onboardingStatus))
        .sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
    }
    if (tab === 'approved') return data.filter((c) => c.onboardingStatus === 'approved');
    return data;
  }, [data, tab]);

  const open = (id: string) => router.push(`/ops/customers/${encodeURIComponent(id)}`);

  return (
    <>
      <PageHeader
        title="Customers"
        description="KYC (individuals) and KYB (businesses) applications. Open a customer to review and decide."
      />
      <Tabs
        label="Customer filter"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'queue', label: 'Review queue' },
          { value: 'approved', label: 'Approved' },
          { value: 'all', label: 'All' },
        ]}
      />
      {error && (
        <Alert tone="error" title="Could not load customers">
          {error}
        </Alert>
      )}
      {!data && !error && <Loading />}
      {data && (
        <Table
          caption={
            tab === 'queue'
              ? `${rows.length} awaiting review, oldest first`
              : `${rows.length} customer${rows.length === 1 ? '' : 's'}`
          }
          head={[
            'Legal name',
            'Kind',
            'Role',
            'Reference',
            'Status',
            'Screening',
            'Risk',
            'Plan',
            'Owner',
            'Submitted',
          ]}
          empty={tab === 'queue' ? 'The review queue is empty.' : 'No customers.'}
        >
          {rows.map((c) => (
            <tr key={c.id} className={s.clickRow} onClick={() => open(c.id)}>
              <td>
                <a
                  className={s.rowLink}
                  href={`/ops/customers/${encodeURIComponent(c.id)}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {c.legalName}
                </a>
              </td>
              <td>{humanize(c.kind)}</td>
              <td>{humanize(c.customerRole)}</td>
              <td>
                <span className={s.code}>{c.referenceCode}</span>
              </td>
              <td>
                <StatusBadge status={c.onboardingStatus} />
              </td>
              <td>
                <ScreeningBadge result={c.screeningResult} />
              </td>
              <td>{c.riskRating ? humanize(c.riskRating) : '—'}</td>
              <td>{c.planCode ?? '—'}</td>
              <td>
                {c.owner ? (
                  <>
                    {c.owner.name}
                    <br />
                    <span className={s.muted}>{c.owner.email}</span>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td className={s.nowrap}>{c.submittedAt ? dateTime(c.submittedAt) : '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
