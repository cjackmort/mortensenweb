import { isEmailAddress } from "@/lib/growth/lead-reply";

/**
 * Who a review request is from: the business's name, where a customer's reply
 * goes, and the postal address for the footer — read from General
 * information, the same source lead replies use, with the same fallbacks.
 */

export interface ReviewIdentity {
  businessName: string;
  replyTo: string | null;
  postalAddress: string | null;
}

export function reviewIdentity(input: {
  organizationName: string | null;
  details: { businessName?: string; email?: string; address?: string } | null | undefined;
  /** The signed-in person's own address, when there is no business email. */
  fallbackEmail?: string | null;
}): ReviewIdentity {
  const profileName = input.details?.businessName?.trim();
  const profileEmail = input.details?.email?.trim();
  const address = input.details?.address?.replace(/\s*\n\s*/g, ", ").trim();

  return {
    businessName: profileName || input.organizationName?.trim() || "Your business",
    replyTo: isEmailAddress(profileEmail)
      ? profileEmail
      : isEmailAddress(input.fallbackEmail)
        ? input.fallbackEmail
        : null,
    postalAddress: address || null,
  };
}
