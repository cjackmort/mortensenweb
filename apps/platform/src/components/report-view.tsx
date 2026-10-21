import Link from "next/link";
import type { ReactNode } from "react";
import { BarList } from "@/components/charts";
import { formatDate, formatDateWithYear } from "@/lib/time";
import type {
  ContactSection,
  EnquiriesSection,
  ExtraSection,
  HealthSection,
  MonthlyReportData,
  VisitorsSection,
} from "@/lib/reports/types";
import {
  CONTACT_LABELS,
  glance,
  headline,
  healthSentence,
  MISSING_MESSAGES,
  trend,
} from "@/lib/reports/wording";
import styles from "./report-view.module.css";

/**
 * One monthly report, as the client reads it.
 *
 * The admin preview renders this same component, so what the operator checks
 * before re-sending is exactly what the client will open. The headline comes
 * first and the detail after, because most clients will read the first line
 * and stop — and that line must already be true and complete.
 */
export function ReportView({
  data,
  builtAt,
  actions,
  inboxHref = "/dashboard/growth/leads",
}: {
  data: MonthlyReportData;
  builtAt: Date;
  /** Buttons under the headline (print, re-send). Hidden in print. */
  actions?: ReactNode;
  /** Where "open your leads inbox" goes; null hides it (admin preview). */
  inboxHref?: string | null;
}) {
  const site = data.site?.domain ?? data.site?.name ?? null;

  return (
    <article className={styles.report}>
      <header className={styles.head}>
        <p className={styles.kicker}>
          {data.businessName}
          {site && <> · {site}</>} · Monthly report
        </p>
        <h1 className={styles.title}>{data.label}</h1>
        <p className={styles.headline}>{headline(data)}</p>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>

      <Panel id="glance" title="At a glance">
        <dl className={styles.glance}>
          {glance(data).map((line) => (
            <Glance key={line.key} title={line.title} text={line.text} missing={line.missing} />
          ))}
        </dl>
      </Panel>

      <Visitors section={data.visitors} previousMonthName={data.previousMonthName} />
      <Contact section={data.contact} />
      {data.enquiries && (
        <Enquiries section={data.enquiries} previousMonthName={data.previousMonthName} inboxHref={inboxHref} />
      )}
      <Changes items={data.changes.items} />
      <Health section={data.health} />
      {data.extras.map((extra) => (
        <Extra key={extra.key} section={extra} />
      ))}

      <p className={styles.footnote}>
        Made on {formatDateWithYear(builtAt)}, from the figures as they stood then.
      </p>
    </article>
  );
}

function Glance({ title, text, missing }: { title: string; text: string; missing: boolean }) {
  return (
    <>
      <dt>{title}</dt>
      <dd className={missing ? styles.missing : undefined}>{text}</dd>
    </>
  );
}

function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="panel" aria-labelledby={`report-${id}`} id={id}>
      <div className="panel-head">
        <h2 id={`report-${id}`}>{title}</h2>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function Missing({ reason }: { reason: keyof typeof MISSING_MESSAGES }) {
  return <p className={styles.missingNote}>{MISSING_MESSAGES[reason]}</p>;
}

function Figure({ value, label, tone }: { value: string; label: string; tone?: "up" | "down" }) {
  return (
    <div className={styles.figure}>
      <span className={`${styles.figureValue}${tone ? ` ${styles[tone]}` : ""}`}>{value}</span>
      <span className={styles.figureLabel}>{label}</span>
    </div>
  );
}

function Visitors({ section, previousMonthName }: { section: VisitorsSection; previousMonthName: string }) {
  if (section.state === "missing") {
    return (
      <Panel id="visitors" title="Visitors">
        <Missing reason={section.reason} />
      </Panel>
    );
  }
  const change = trend(section.change);
  return (
    <Panel id="visitors" title="Visitors">
      <div className={styles.figures}>
        <Figure value={section.visitors.toLocaleString("en-US")} label="visitors" />
        {change && section.previousVisitors !== null && (
          <Figure
            value={change === "about the same" ? "About the same" : capitalise(change)}
            label={`on ${previousMonthName} (${section.previousVisitors.toLocaleString("en-US")})`}
            tone={change.startsWith("up") ? "up" : change.startsWith("down") ? "down" : undefined}
          />
        )}
        <Figure value={section.pageviews.toLocaleString("en-US")} label="pages viewed" />
      </div>
      <div className={styles.columns}>
        <div>
          <h3>Most viewed pages</h3>
          <BarList rows={section.topPages} unit="views" />
        </div>
        <div>
          <h3>Where visitors came from</h3>
          <BarList rows={section.sources} unit="visitors" />
        </div>
      </div>
    </Panel>
  );
}

function Contact({ section }: { section: ContactSection }) {
  return (
    <Panel id="contact" title="People reaching out">
      <p className={styles.explain}>
        Taps on the contact links on your site. A tap opens their phone or email app; we can&rsquo;t see
        whether a call or message followed.
      </p>
      {section.state === "missing" ? (
        <Missing reason={section.reason} />
      ) : (
        <ul className={styles.rows}>
          {section.rows.map((row) => (
            <li key={row.id}>
              <span>{CONTACT_LABELS[row.id].label}</span>
              <span className={styles.rowValue}>{row.count.toLocaleString("en-US")}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Enquiries({
  section,
  previousMonthName,
  inboxHref,
}: {
  section: EnquiriesSection;
  previousMonthName: string;
  inboxHref: string | null;
}) {
  return (
    <Panel id="enquiries" title="Enquiries">
      {section.state === "missing" ? (
        <Missing reason={section.reason} />
      ) : (
        <>
          <p className={styles.explain}>Messages from your website&rsquo;s contact form that reached your leads inbox.</p>
          <div className={styles.figures}>
            <Figure value={section.received.toLocaleString("en-US")} label="received" />
            {section.previous !== null && (
              <Figure value={section.previous.toLocaleString("en-US")} label={`in ${previousMonthName}`} />
            )}
            <Figure value={section.won.toLocaleString("en-US")} label="marked won" />
            <Figure value={section.awaitingReply.toLocaleString("en-US")} label="still marked new" />
          </div>
          {inboxHref && (
            <p className="no-print" style={{ margin: 0 }}>
              <Link href={inboxHref}>Open your leads inbox</Link>
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function Changes({ items }: { items: MonthlyReportData["changes"]["items"] }) {
  return (
    <Panel id="changes" title="Changes made">
      {items.length === 0 ? (
        <p className={styles.explain} style={{ marginBottom: 0 }}>
          No changes this month. Anything you&rsquo;d like changed, send it from Requests.
        </p>
      ) : (
        <ul className={styles.rows}>
          {items.map((item, index) => (
            <li key={`${item.completedAt}-${index}`}>
              <span>{item.title}</span>
              <span className={styles.when}>{formatDate(item.completedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Health({ section }: { section: HealthSection }) {
  return (
    <Panel id="health" title="Your website">
      {section.state === "missing" ? (
        <Missing reason={section.reason} />
      ) : (
        <>
          <p style={{ margin: 0, fontWeight: 600 }}>{healthSentence(section)}.</p>
          <p className={styles.explain} style={{ margin: "0.5rem 0 0" }}>
            {!section.live
              ? "Once your site is live, we check it's online several times a day."
              : section.stale
                ? "We haven't been able to confirm it since. If it isn't loading for you, reply to the report email."
                : "We check several times a day that your site loads."}
          </p>
        </>
      )}
    </Panel>
  );
}

function Extra({ section }: { section: ExtraSection }) {
  return (
    <Panel id={section.key} title={section.title}>
      {section.rows.length > 0 && (
        <ul className={styles.rows}>
          {section.rows.map((row) => (
            <li key={row.label}>
              <span>{row.label}</span>
              <span className={styles.rowValue}>{row.value}</span>
            </li>
          ))}
        </ul>
      )}
      {section.note && (
        <p className={section.state === "missing" ? styles.missingNote : styles.explain} style={{ margin: section.rows.length ? "0.75rem 0 0" : 0 }}>
          {section.note}
        </p>
      )}
    </Panel>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
