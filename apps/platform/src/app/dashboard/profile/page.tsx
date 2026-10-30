import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getOwnBusinessProfile, getOwnProfile } from "@/db/repositories/client/profile";
import { UserAvatar } from "@/components/user-avatar";
import { CLIENT_PROFILE_FIELDS, focusedProfileField } from "@/lib/business-profile";
import { formatDateWithYear } from "@/lib/time";
import { AvatarEditor } from "./avatar-editor";
import { BusinessForm, DetailsForm } from "./forms";
import "./profile.css";

/**
 * The client's profile: who they are to the portal, and what their website
 * says about their business.
 *
 * Two things a client used to have to ask us to change — their sign-in email
 * when an owner changed, and the business details the agent is given on
 * every request. Both are theirs to edit here. Neither touches the live site
 * on its own: the details feed every future request, and a request still
 * gets a preview the client approves before it goes live.
 *
 * `?field=address` (see `profileFieldHref`) brings one business field into
 * view, for the pages that need it filled in — win-back's postal address.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your profile",
  robots: { index: false, follow: false },
};

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ field?: string | string[] }>;
}) {
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
  const [me, business, query] = await Promise.all([
    getOwnProfile(db, ctx),
    getOwnBusinessProfile(db, ctx),
    searchParams,
  ]);
  const details = business?.details ?? {};
  const filled = CLIENT_PROFILE_FIELDS.filter((f) => details[f.key]?.trim()).length;
  const total = CLIENT_PROFILE_FIELDS.length;
  const businessName = details.businessName?.trim();
  const readOnly = ctx.impersonating;

  return (
    <main className="shell profile-page">
      <div className="masthead">
        <h1>Your profile</h1>
        <span>You, and what your site says about your business</span>
      </div>

      <section className="panel profile-hero" aria-labelledby="profile-name">
        {/* Drawn here, on the server: the avatar helpers sit beside the
            sharp-based upload code, which must never reach the browser. */}
        <AvatarEditor hasPicture={Boolean(me.avatarKey)} readOnly={readOnly}>
          <UserAvatar user={me} size="large" />
        </AvatarEditor>
        <div className="profile-hero-text">
          <h2 id="profile-name">{me.name ?? me.email}</h2>
          {businessName && <p className="profile-hero-business">{businessName}</p>}
          <dl className="profile-hero-facts">
            {me.username && (
              <div>
                <dt>Signs in as</dt>
                <dd>{me.username}</dd>
              </div>
            )}
            <div>
              <dt>Email</dt>
              <dd>{me.email}</dd>
            </div>
          </dl>
          <div className="profile-meter">
            <p className="profile-meter-label">
              <span>Business details</span>
              <span>
                {filled} of {total} filled in
              </span>
            </p>
            <div className="profile-meter-track" aria-hidden="true">
              <span style={{ width: `${Math.round((filled / total) * 100)}%` }} />
            </div>
          </div>
        </div>
      </section>

      <section className="panel" id="profile-you" aria-labelledby="profile-you-title">
        <div className="panel-head">
          <h2 id="profile-you-title">Your details</h2>
          <span className="panel-sub">How we reach you, and how you sign in</span>
        </div>
        <div className="panel-body">
          <DetailsForm name={me.name ?? ""} email={me.email} readOnly={readOnly} />
        </div>
      </section>

      <section className="panel" id="profile-business" aria-labelledby="profile-business-title">
        <div className="panel-head">
          <h2 id="profile-business-title">Your business</h2>
          <span className="panel-sub">
            {business?.updatedAt ? `Last saved ${formatDateWithYear(business.updatedAt)}` : "Not saved yet"}
          </span>
        </div>
        <div className="panel-body">
          <p className="profile-intro">
            What your website says about you. We give these to every change we make for you, so you never have to
            repeat them. Saving here doesn&rsquo;t change your site by itself: when you want it to match, send a{" "}
            <Link href="/dashboard/requests">request</Link> and approve the preview.
          </p>
          <BusinessForm details={details} readOnly={readOnly} focusField={focusedProfileField(query.field)} />
        </div>
      </section>
    </main>
  );
}
