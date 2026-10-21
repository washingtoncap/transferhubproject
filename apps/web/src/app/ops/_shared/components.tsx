'use client';

import type { AuditEntry, OpsCustomer } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { StatusBadge, Table } from '@/components/ui';
import s from './ops.module.css';

export function ScreeningBadge({ result }: { result: OpsCustomer['screeningResult'] }) {
  if (result === 'possible_match')
    return <StatusBadge status="needs_information" label="Possible match" />;
  if (result === 'clear') return <StatusBadge status="ok" label="Clear" />;
  return <StatusBadge status="draft" label="Not screened" />;
}

export function actorLabel(a: AuditEntry): string {
  return a.actorName ?? `${a.actorType}:${a.actorId}`;
}

export function AuditTable({
  entries,
  caption,
  showObject = true,
}: {
  entries: AuditEntry[];
  caption?: string;
  showObject?: boolean;
}) {
  const head = ['Time', 'Actor', 'Action'];
  if (showObject) head.push('Object');
  head.push('Reason', 'Approver', 'Request ID');
  return (
    <Table caption={caption} head={head} empty="No audit entries.">
      {entries.map((a) => (
        <tr key={a.id}>
          <td className={s.nowrap}>{dateTime(a.occurredAt)}</td>
          <td>
            {actorLabel(a)}
            {a.actorName && <div className={s.muted}>{a.actorType}</div>}
          </td>
          <td>
            <code className={s.code}>{a.action}</code>
          </td>
          {showObject && (
            <td>
              <span className={s.nowrap}>{a.objectType}</span>
              {a.objectId && <div className={`${s.muted} ${s.small}`}>{a.objectId}</div>}
            </td>
          )}
          <td>{a.reason ?? '—'}</td>
          <td className={s.small}>{a.approverId ?? '—'}</td>
          <td>{a.requestId ? <code className={s.code}>{a.requestId}</code> : '—'}</td>
        </tr>
      ))}
    </Table>
  );
}
