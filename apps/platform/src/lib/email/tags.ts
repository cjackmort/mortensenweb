/**
 * Resend tags on outgoing mail, and reading them back off a webhook.
 *
 * Resend echoes an email's tags on every event about it, which is how
 * `/api/webhooks/resend` knows whose bounce it is holding: `feature` picks the
 * handler (see `db/repositories/admin/delivery-events.ts`), and
 * `organization` says which business's suppression list it belongs on.
 * A feature may add its own tags beside them — win-back adds the recipient.
 *
 * Mail without a `feature` tag (password resets, lead replies) is not routed
 * anywhere: nothing of ours sends it in bulk, so there is no list to keep.
 */

export const FEATURE_TAG = "feature";
export const ORGANIZATION_TAG = "organization";

export type Tag = { name: string; value: string };

/** Resend accepts ASCII letters, digits, `_` and `-` in both, up to 256 characters. */
const SAFE = /^[A-Za-z0-9_-]{1,256}$/;

export function featureTags(feature: string, organizationId: string, extra: Record<string, string> = {}): Tag[] {
  const tags = [
    { name: FEATURE_TAG, value: feature },
    { name: ORGANIZATION_TAG, value: organizationId },
    ...Object.entries(extra).map(([name, value]) => ({ name, value })),
  ];
  for (const tag of tags) {
    if (!SAFE.test(tag.name) || !SAFE.test(tag.value)) {
      throw new Error(`Resend tag ${tag.name} has characters Resend refuses.`);
    }
  }
  return tags;
}

/** Tags off a webhook payload, which Resend sends as an object or a list. Unknown shapes read as none. */
export function readTags(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const { name, value } = (item ?? {}) as { name?: unknown; value?: unknown };
      if (typeof name === "string" && typeof value === "string") out[name] = value;
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") out[name] = value;
    }
  }
  return out;
}
