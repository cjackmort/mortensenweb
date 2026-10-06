import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import {
  adminContextFrom,
  NotFoundError,
  type AdminContext,
} from "@/db/repositories/context";
import {
  getClientComp,
  getClientDetail,
  listOrganizationUsers,
} from "@/db/repositories/admin/clients";
import { listSitesWithAnalytics } from "@/db/repositories/admin/sites";
import { listClientPaymentRequests } from "@/db/repositories/admin/billing";
import { listBriefs } from "@/db/repositories/admin/briefs";
import { listActivePlans } from "@/db/repositories/admin/prospects";
import { getBusinessProfile } from "@/db/repositories/admin/business-profile";
import {
  getBillingPlan,
  listAssignablePlans,
  type BillingPlanView,
} from "@/db/repositories/admin/billing-plan";
import { PROFILE_FIELDS, profileEntries } from "@/lib/business-profile";
import { businessDate } from "@/lib/billing/period";
import { LAST_BILLING_DAY, ordinal } from "@/lib/billing/billing-day";
import { formatCurrency } from "@/lib/payments/venmo";
import { stripeConfigured, TEST_PLAN } from "@/lib/payments/stripe";
import { isOpen } from "@/lib/requests/status";
import { ActivateForm, ReissueForm } from "./credential-forms";
import { ProfilePanel } from "./profile-forms";
import { BillingSection } from "./billing-section";
import { WebsiteSection } from "./website-section";
import { AnalyticsSection } from "./analytics-section";
import { BriefsSection, RequestsSection } from "./work-sections";
import {
  SECTIONS,
  SectionGrid,
  SectionSwitcher,
  sectionFrom,
  type SectionKey,
  type SectionSummaries,
} from "./sections";

export const dynamic = "force-dynamic";

/**
 * One client, and the operator actions that belong to them.
 *
 * The overview is who they are and who can sign in, then a button per
 * setting; each setting opens on its own (`?section=…`) rather than as one
 * more card in a long scroll. See `sections.tsx`.
 *
 * Gated twice, like every admin surface: middleware keeps unauthenticated
 * visitors out, and `adminContextFrom` refuses a session that is not an active
 * admin. The second is the load-bearing one.
 *
 * A client that does not exist renders 404 rather than an error, matching the
 * repository's `NotFoundError` contract.
 */
export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const { publicId } = await params;
  const section = sectionFrom((await searchParams).section);
  const ctx = adminContextFrom(user);
  const db = await getDb();

  let detail;
  try {
    detail = await getClientDetail(ctx, db, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { client, organization, requests } = detail;
  const [portalUsers, siteRows, invoices, briefs, profile, billingPlan] = await Promise.all([
    listOrganizationUsers(ctx, db, organization.id),
    listSitesWithAnalytics(ctx, db, organization.id),
    listClientPaymentRequests(ctx, db, organization.id),
    listBriefs(ctx, db, organization.id),
    getBusinessProfile(db, organization.id),
    getBillingPlan(db, client.id),
  ]);

  const summaries = summarise({
    billingPlan,
    overdue: invoices.some((inv) => inv.status === "overdue"),
    filled: profileEntries(profile?.details).length,
    sites: siteRows,
    briefs,
    requests,
  });

  return (
    <main className="shell">
      <div className="masthead">
        <h1>
          {section ? (
            <>
              {organization.name}
              <span className="masthead-sub">{SECTIONS.find((s) => s.key === section)?.title}</span>
            </>
          ) : (
            organization.name
          )}
        </h1>
        <span className="muted">
          <Link href="/admin/clients">← All clients</Link>
        </span>
      </div>

      {client.isDemo && (
        <p className="notice">
          <span className="badge">Demo</span> This is seeded demo data, not a real client.
        </p>
      )}

      {section ? (
        <>
          <SectionSwitcher clientPublicId={client.publicId} current={section} />
          <Section
            ctx={ctx}
            section={section}
            clientPublicId={client.publicId}
            organizationName={organization.name}
            isInternal={client.isInternal}
            billingPlan={billingPlan}
            invoices={invoices}
            briefs={briefs}
            profile={profile}
            sites={siteRows}
            requests={requests}
          />
        </>
      ) : (
        <>
          <section className="card">
            <h2>Details</h2>
            <dl className="detail-grid">
              <dt>Contact</dt>
              <dd>{client.primaryContactName ?? "—"}</dd>
              <dt>Email</dt>
              <dd>{client.primaryContactEmail ?? "—"}</dd>
              <dt>Phone</dt>
              <dd>{client.phone ?? "—"}</dd>
              <dt>Industry</dt>
              <dd>{client.industry ?? "—"}</dd>
              <dt>Onboarding</dt>
              <dd>{client.onboardingStatus}</dd>
              <dt>Management</dt>
              <dd>
                {client.managementState}
                {client.managementState !== "managed" && (
                  <span className="muted"> — the site stays online; only our work is paused</span>
                )}
              </dd>
            </dl>
          </section>

          <PortalAccess
            clientPublicId={client.publicId}
            contactName={client.primaryContactName}
            contactEmail={client.primaryContactEmail}
            accounts={portalUsers}
          />

          <SectionGrid clientPublicId={client.publicId} summaries={summaries} />
        </>
      )}
    </main>
  );
}

type Accounts = Awaited<ReturnType<typeof listOrganizationUsers>>;

function PortalAccess({
  clientPublicId,
  contactName,
  contactEmail,
  accounts,
}: {
  clientPublicId: string;
  contactName: string | null;
  contactEmail: string | null;
  accounts: Accounts;
}) {
  if (accounts.length === 0) {
    return (
      <section className="card">
        <h2>Portal access</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          This client cannot sign in yet. Activating creates their account and issues a temporary
          password, shown once.
        </p>
        <div className="action-block">
          <ActivateForm
            clientPublicId={clientPublicId}
            defaultName={contactName}
            defaultEmail={contactEmail}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Portal access</h2>
      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Status</th>
              <th>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.publicId}>
                <td data-label="Username">
                  <code>{account.username ?? "—"}</code>
                </td>
                <td data-label="Email">{account.email}</td>
                <td data-label="Status">
                  {account.status !== "active"
                    ? account.status
                    : account.mustChangePassword
                      ? "Temporary password not yet used"
                      : "Active"}
                </td>
                <td data-label="Last sign-in">
                  {account.lastLoginAt ? account.lastLoginAt.toLocaleDateString("en-US") : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {accounts.map((account) => (
        <div key={account.publicId} className="action-block">
          <ReissueForm
            clientPublicId={clientPublicId}
            userPublicId={account.publicId}
            email={account.email}
          />
        </div>
      ))}
    </section>
  );
}

type Profile = Awaited<ReturnType<typeof getBusinessProfile>>;
type Sites = Awaited<ReturnType<typeof listSitesWithAnalytics>>;
type Invoices = Awaited<ReturnType<typeof listClientPaymentRequests>>;
type Briefs = Awaited<ReturnType<typeof listBriefs>>;
type Requests = Awaited<ReturnType<typeof getClientDetail>>["requests"];

/** The open section. Each loads only what it needs beyond the shared reads. */
async function Section(props: {
  ctx: AdminContext;
  section: SectionKey;
  clientPublicId: string;
  organizationName: string;
  isInternal: boolean;
  billingPlan: BillingPlanView | null;
  invoices: Invoices;
  briefs: Briefs;
  profile: Profile;
  sites: Sites;
  requests: Requests;
}) {
  const { section, clientPublicId, sites } = props;

  switch (section) {
    case "billing":
      return <Billing {...props} />;
    case "general":
      return (
        <section className="card" id="general-information">
          <div className="card-head">
            <h2>General information</h2>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            What the website says about the business. Filled in once, and given to the agent on
            every request and brief for this client, so nobody has to repeat the phone number or
            the hours.
          </p>
          <ProfilePanel
            clientPublicId={clientPublicId}
            details={props.profile?.details ?? {}}
            sites={sites.map((site) => ({ publicId: site.publicId, name: site.name }))}
            updatedAt={props.profile?.updatedAt.toISOString() ?? null}
            lastAppliedAt={props.profile?.lastAppliedAt?.toISOString() ?? null}
            siteUrl={
              props.profile?.details.website ??
              (sites[0]?.primaryDomain ? `https://${sites[0].primaryDomain}` : null)
            }
          />
        </section>
      );
    case "website":
      return (
        <WebsiteSection
          clientPublicId={clientPublicId}
          organizationName={props.organizationName}
          sites={sites}
          isInternal={props.isInternal}
        />
      );
    case "analytics":
      return <AnalyticsSection clientPublicId={clientPublicId} sites={sites} />;
    case "briefs":
      return (
        <BriefsSection
          clientPublicId={clientPublicId}
          sites={sites.map((site) => ({ publicId: site.publicId, name: site.name }))}
          briefs={props.briefs}
        />
      );
    case "requests":
      return <RequestsSection requests={props.requests} />;
  }
}

async function Billing(props: {
  ctx: AdminContext;
  clientPublicId: string;
  isInternal: boolean;
  billingPlan: BillingPlanView | null;
  invoices: Invoices;
}) {
  const db = await getDb();
  const [plans, compPlans, comp] = await Promise.all([
    listAssignablePlans(db),
    listActivePlans(db),
    getClientComp(props.ctx, db, props.clientPublicId),
  ]);

  // Today's date as the suggestion, so a client set up today pays today.
  const today = Number(businessDate().slice(8, 10));

  return (
    <BillingSection
      clientPublicId={props.clientPublicId}
      plan={props.billingPlan}
      plans={plans}
      defaultDay={today > LAST_BILLING_DAY ? 1 : today}
      cardPayments={stripeConfigured()}
      invoices={props.invoices}
      compPlans={compPlans
        .filter((plan) => plan.key !== TEST_PLAN.key)
        .map((plan) => ({
          key: plan.key,
          name: plan.name,
          includedChangesPerMonth: plan.includedChangesPerMonth,
        }))}
      comp={comp}
    />
  );
}

/** One line per button on the overview: where each setting stands. */
function summarise(input: {
  billingPlan: BillingPlanView | null;
  overdue: boolean;
  filled: number;
  sites: Sites;
  briefs: Briefs;
  requests: Requests;
}): SectionSummaries {
  const { billingPlan: plan, sites, briefs, requests } = input;
  const connected = sites.filter((site) => site.umamiWebsiteId).length;
  const open = requests.filter((request) => isOpen(request.status)).length;
  const drafts = briefs.filter((brief) => brief.status === "draft").length;
  const firstSite = sites[0];

  return {
    billing: plan
      ? {
          status: `${plan.planName ?? "Plan"}, ${formatCurrency(plan.monthlyPriceCents, plan.currency)} on the ${ordinal(plan.billingDay)}${plan.provider === "stripe" ? " · card" : ""}${input.overdue ? " · overdue" : ""}`,
          attention: input.overdue,
        }
      : { status: "No plan yet", attention: true },
    general: {
      status: `${input.filled} of ${PROFILE_FIELDS.length} filled in`,
      attention: input.filled === 0,
    },
    website: firstSite
      ? {
          status: `${firstSite.primaryDomain ?? firstSite.name} · ${firstSite.status}${sites.length > 1 ? ` · +${sites.length - 1} more` : ""}`,
        }
      : { status: "No site yet", attention: true },
    analytics:
      sites.length === 0
        ? { status: "Needs a site first" }
        : connected === sites.length
          ? { status: "Connected" }
          : { status: connected === 0 ? "Not connected" : `${connected} of ${sites.length} connected`, attention: true },
    briefs: {
      status: briefs.length === 0 ? "None yet" : `${briefs.length} written${drafts ? ` · ${drafts} draft` : ""}`,
    },
    requests: {
      status: requests.length === 0 ? "None yet" : `${open} in progress · ${requests.length} recent`,
    },
  };
}
