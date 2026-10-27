import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { UserAvatar } from "@/components/user-avatar";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getOwnBusinessProfile, getOwnProfile } from "@/db/repositories/client/profile";
import { PROFILE_FIELDS } from "@/lib/business-profile";
import { formatDateWithYear } from "@/lib/time";
import { BusinessForm, DetailsForm, PictureForm } from "./forms";

/**
 * The client's profile: who they are to the portal, and what their website
 * says about their business.
 *
 * Two things a client used to have to ask us to change — their sign-in email
 * when an owner changed, and the business details the agent is given on
 * every request. Both are theirs to edit here. Neither touches the live site
 * on its own: the details feed every future request, and a request still
 * gets a preview the client approves before it goes live.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your profile",
  robots: { index: false, follow: false },
};

export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  const [me, business] = await Promise.all([getOwnProfile(db, ctx), getOwnBusinessProfile(db, ctx)]);
  const details = business?.details ?? {};
  const filled = PROFILE_FIELDS.filter((f) => details[f.key]?.trim()).length;
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Your profile</h1>
        <span>You, and what your site says about your business</span>
      </div>

      <section className="panel" aria-labelledby="profile-you">
        <div className="panel-head">
          <h2 id="profile-you">You</h2>
        </div>
        <div className="panel-body">
          <div className="profile-identity">
            <UserAvatar user={me} size="large" />
            <div className="profile-identity-text">
              <strong>{me.name ?? me.email}</strong>
              <p className="muted">
                {me.email}
                {me.username && (
                  <>
                    {" "}
                    · signs in as <code>{me.username}</code>
                  </>
                )}
              </p>
            </div>
          </div>
          <PictureForm hasPicture={Boolean(me.avatarKey)} readOnly={readOnly} />
          <hr className="divider" />
          <DetailsForm name={me.name ?? ""} email={me.email} readOnly={readOnly} />
        </div>
      </section>

      <section className="panel" aria-labelledby="profile-business">
        <div className="panel-head">
          <h2 id="profile-business">Your business</h2>
          <span className="panel-sub">
            {filled === 0
              ? "Nothing filled in yet"
              : `${filled} of ${PROFILE_FIELDS.length} filled in`}
            {business?.updatedAt && ` · last saved ${formatDateWithYear(business.updatedAt)}`}
          </span>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0 }}>
            What your website says about you: the phone number calls go to, your hours, what you
            offer. We give these to every change we make for you, so you never have to repeat them.
            Saving here does not change the site by itself — when you want the site to match, send a
            request under <Link href="/dashboard/requests">Requests</Link> and you will see a
            preview to approve first.
          </p>
          <BusinessForm details={details} readOnly={readOnly} />
        </div>
      </section>
    </main>
  );
}
