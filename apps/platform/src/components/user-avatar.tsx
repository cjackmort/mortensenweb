import { initialsFor, ownAvatarUrl } from "@/lib/profile/avatar";

/**
 * A person's picture, or their initials where they have none.
 *
 * The image is the signed-in person's own, served by `/dashboard/profile/avatar`
 * with the key's version in the URL, so a new upload is fetched and an old
 * cached one is not shown in its place.
 */
export function UserAvatar({
  user,
  size = "small",
}: {
  user: { name: string | null; email: string; avatarKey: string | null };
  size?: "small" | "large";
}) {
  const className = `user-avatar${size === "large" ? " is-large" : ""}`;
  if (user.avatarKey) {
    // eslint-disable-next-line @next/next/no-img-element -- a 256px square from our own origin; next/image would add nothing.
    return <img className={className} src={ownAvatarUrl(user.avatarKey)} alt="" width={size === "large" ? 96 : 30} height={size === "large" ? 96 : 30} />;
  }
  return (
    <span className={className} aria-hidden="true">
      {initialsFor(user.name, user.email)}
    </span>
  );
}
