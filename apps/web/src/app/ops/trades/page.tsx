'use client';

import { useMemo } from 'react';
import { api } from '@/lib/api';
import { dateTime, rate } from '@/lib/format';
import { Alert, Button, Loading, Money, PageHeader, Table } from '@/components/ui';
import { useData } from '@/components/session';
import { sideLabel } from '../_shared/hooks';
import s from '../_shared/ops.module.css';

export default function OpsTradesPage() {
  const { data, error, reload } = useData(() => api.ops.trades(), []);

  const totals = useMemo(
    () =>
      (data ?? []).reduce(
        (t, x) => ({
          usd: t.usd + x.usdMinor,
          ttd: t.ttd + x.ttdMinor,
          margin: t.margin + x.parentMarginMinor,
          share: t.share + x.platformShareMinor,
        }),
        { usd: 0, ttd: 0, margin: 0, share: 0 },
      ),
    [data],
  );

  return (
    <>
      <PageHeader
        title="Trades"
        description="Accepted FX trades. Rates are TT$ per US$."
        actions={
          <Button variant="secondary" onClick={() => void reload()}>
            Refresh
          </Button>
        }
      />
      {error && (
        <Alert tone="error" title="Could not load trades">
          {error}
        </Alert>
      )}
      {!data && !error && <Loading />}
      {data && (
        <Table
          caption={`${data.length} trade${data.length === 1 ? '' : 's'}`}
          head={[
            'Time',
            'Customer',
            'Side',
            'USD amount',
            'TTD amount',
            'Rate',
            'Rate source',
            'Parent margin',
            'Platform share',
          ]}
          empty="No trades yet."
        >
          {data.length > 0 && [
            ...data.map((t) => (
              <tr key={t.id}>
                <td className={s.nowrap}>{dateTime(t.acceptedAt)}</td>
                <td>
                  <a
                    className={s.rowLink}
                    href={`/ops/customers/${encodeURIComponent(t.entity.id)}`}
                  >
                    {t.entity.legalName}
                  </a>
                </td>
                <td className={s.nowrap}>{sideLabel(t.side)}</td>
                <td>
                  <Money minor={t.usdMinor} asset="USD" />
                </td>
                <td>
                  <Money minor={t.ttdMinor} asset="TTD" />
                </td>
                <td className="num">{rate(t.rateE4)}</td>
                <td>
                  <code className={s.code}>{t.rateSource}</code>
                </td>
                <td>
                  <Money minor={t.parentMarginMinor} asset="TTD" />
                </td>
                <td>
                  <Money minor={t.platformShareMinor} asset="TTD" />
                </td>
              </tr>
            )),
            <tr key="totals" className={s.totalsRow}>
              <td colSpan={3}>Totals ({data.length})</td>
              <td>
                <Money minor={totals.usd} asset="USD" />
              </td>
              <td>
                <Money minor={totals.ttd} asset="TTD" />
              </td>
              <td colSpan={2} />
              <td>
                <Money minor={totals.margin} asset="TTD" />
              </td>
              <td>
                <Money minor={totals.share} asset="TTD" />
              </td>
            </tr>,
          ]}
        </Table>
      )}
    </>
  );
}
