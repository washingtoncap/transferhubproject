import styles from './page.module.css';

export default function OverviewPage() {
  return (
    <>
      <h1>Overview</h1>
      <p className={styles.lead}>
        This is the TransferHub platform foundation. Accounts, funding, exchange and the seller
        network are built on top of it in the next buckets.
      </p>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="c1">
          <h3 id="c1">Every action recorded</h3>
          <p>An append-only audit log that no one, including administrators, can edit or delete.</p>
        </section>
        <section className={styles.card} aria-labelledby="c2">
          <h3 id="c2">No double processing</h3>
          <p>Retried requests and repeated partner events are recognised and handled once.</p>
        </section>
        <section className={styles.card} aria-labelledby="c3">
          <h3 id="c3">Reliable background work</h3>
          <p>Jobs survive restarts, retry safely and are never picked up by two workers at once.</p>
        </section>
      </div>

      <section className={styles.panel} aria-labelledby="roadmap">
        <h2 id="roadmap">Build sequence</h2>
        <ol>
          <li>
            Platform foundation <span className={styles.done}>— in place</span>
          </li>
          <li>Identity and access: sign-up, MFA, individual and business accounts</li>
          <li>Ledger core: who owns what, holds and double-spend protection</li>
          <li>Funding and withdrawals</li>
          <li>Exchange and pricing</li>
          <li>Seller network</li>
          <li>Subscriptions and billing</li>
          <li>Operations console</li>
        </ol>
      </section>
    </>
  );
}
