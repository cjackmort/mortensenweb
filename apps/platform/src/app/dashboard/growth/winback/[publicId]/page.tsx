import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { getCampaign, sendingIdentity } from "@/db/repositories/client/winback-campaigns";
import { countReachable, listContacts } from "@/db/repositories/client/winback-contacts";
import { winbackSenderAddress } from "@/lib/winback/readiness";
import { businessTimeZone, formatDateTime, formatDateWithYear } from "@/lib/time";
import { MissingReason } from "../missing";
import { CampaignResults, CampaignStatusPill, EmailPreview } from "../parts";
import { CampaignEditor } from "./editor";
import { CancelCampaignForm } from "./cancel-form";
import "../winback.css";

/**
 * One win-back email: edited and approved while a draft, then read-only with
 * its results. The preview uses a real customer from the list, so the
 * greeting shows as it will arrive.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Win-back email",
  robots: { index: false, follow: false },
};

/** What the preview shows when the list is empty: obviously an example. */
const EXAMPLE = { email: "customer@example.com", name: "Alex Example" };

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ approved?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) notFound();

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "winback"))) redirect("/dashboard/growth?locked=winback#winback");

  const { publicId } = await params;
  let campaign;
  try {
    campaign = await getCampaign(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const [identity, reachable, firstPage] = await Promise.all([
    sendingIdentity(db, ctx),
    countReachable(db, ctx.organizationId),
    listContacts(db, ctx),
  ]);
  const sampleContact = firstPage.contacts.find((c) => !c.suppressed);
  const sample = sampleContact ? { email: sampleContact.email, name: sampleContact.name } : EXAMPLE;
  // Only for the preview line; approval refuses while it is unset.
  const senderAddress = winbackSenderAddress() ?? "not-set-up-yet";
  const justApproved = (await searchParams).approved === "1";

  return (
    <main className="shell">
      <p className="lead-back">
        <Link href="/dashboard/growth/winback">← Win-back emails</Link>
      </p>
      <div className="masthead">
        <h1>{campaign.name}</h1>
        <span>
          <CampaignStatusPill status={campaign.status} scheduledFor={campaign.scheduledFor} />
        </span>
      </div>

      {campaign.status === "draft" ? (
        <CampaignEditor
          publicId={campaign.publicId}
          initial={{
            name: campaign.name,
            subject: campaign.subject,
            body: campaign.body,
            offer: campaign.offer ?? "",
            offerExpiresOn: campaign.offerExpiresOn ?? "",
          }}
          identity={{ ...identity, senderAddress }}
          sample={sample}
          reachable={reachable}
          blocked={
            !identity.ready
              ? <MissingReason missing={identity.missing[0]!} />
              : reachable === 0
                ? "Add customers to your list before approving."
                : null
          }
          today={new Date().toLocaleDateString("en-CA", { timeZone: businessTimeZone() })}
          readOnly={ctx.impersonating}
        />
      ) : (
        <>
          {justApproved && campaign.status === "approved" && (
            <p className="notice notice-success" role="status">
              Approved.{" "}
              {campaign.scheduledFor
                ? `It goes out on ${formatDateWithYear(campaign.scheduledFor)}, from 9am.`
                : "It starts going out in the next few minutes."}
            </p>
          )}
          {campaign.status === "halted" && (
            <p className="notice notice-danger">
              Stopped by Mortensen Web Co.{campaign.haltReason ? `: ${campaign.haltReason}` : "."} Nobody else will get
              it. Get in touch if you have questions.
            </p>
          )}
          {campaign.status === "cancelled" && <p className="notice">Cancelled. Anyone not already emailed wasn&rsquo;t.</p>}

          <section className="panel">
            <div className="panel-head">
              <h2>{campaign.status === "approved" ? "Waiting to send" : "Results"}</h2>
            </div>
            <div className="panel-body">
              <p style={{ marginTop: 0 }}>
                Approved by {campaign.approvedByName ?? "you"}
                {campaign.approvedAt ? ` on ${formatDateTime(campaign.approvedAt)}` : ""}.{" "}
                {campaign.status === "approved" &&
                  (campaign.scheduledFor
                    ? `Goes out on ${formatDateWithYear(campaign.scheduledFor)}, from 9am, to everyone on your list then.`
                    : "Starting in the next few minutes.")}
                {campaign.sentAt ? ` Finished ${formatDateTime(campaign.sentAt)}.` : ""}
              </p>
              {(campaign.status === "approved" || campaign.status === "sending") && (
                <CancelCampaignForm publicId={campaign.publicId} sending={campaign.status === "sending"} readOnly={ctx.impersonating} />
              )}
            </div>
            {campaign.status !== "approved" && <CampaignResults stats={campaign.stats} replyTo={campaign.replyTo} />}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>The email</h2>
            </div>
            <div className="panel-body">
              <EmailPreview
                campaign={{
                  subject: campaign.subject,
                  body: campaign.body,
                  offer: campaign.offer,
                  offerExpiresOn: campaign.offerExpiresOn,
                  fromName: campaign.fromName ?? identity.fromName,
                  replyTo: campaign.replyTo ?? "",
                  postalAddress: campaign.postalAddress ?? "",
                }}
                sample={sample}
                senderAddress={senderAddress}
              />
            </div>
          </section>
        </>
      )}
    </main>
  );
}
