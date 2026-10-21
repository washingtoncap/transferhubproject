'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { Alert, Button, Field, Loading, PageHeader, Select } from '@/components/ui';
import { useData } from '@/components/session';
import { AuditTable } from '../_shared/components';
import s from '../_shared/ops.module.css';

const OBJECT_TYPES = [
  'entity',
  'deposit_claim',
  'quote',
  'withdrawal',
  'seller_link',
  'subscription',
  'rate_policy',
  'session',
  'beneficiary',
];
const LIMITS = [50, 100, 200];

export default function OpsAuditPage() {
  const [objectType, setObjectType] = useState('');
  const [limit, setLimit] = useState(50);
  const { data, error, reload, loading } = useData(
    () => api.ops.audit({ limit, objectType: objectType || undefined }),
    [limit, objectType],
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every security- and money-relevant action, newest first. The log is append-only and cannot be edited or deleted."
        actions={
          <Button variant="secondary" onClick={() => void reload()} busy={loading && !!data}>
            Refresh
          </Button>
        }
      />
      <div className={s.toolbar}>
        <Field label="Object type">
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              value={objectType}
              onChange={(e) => setObjectType(e.target.value)}
            >
              <option value="">All object types</option>
              {OBJECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Show">
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {LIMITS.map((l) => (
                <option key={l} value={l}>
                  Latest {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {error && (
        <Alert tone="error" title="Could not load the audit log">
          {error}
        </Alert>
      )}
      {!data && !error && <Loading />}
      {data && (
        <AuditTable
          entries={data}
          caption={`${data.length} entr${data.length === 1 ? 'y' : 'ies'}${objectType ? ` for ${objectType}` : ''}`}
        />
      )}
    </>
  );
}
