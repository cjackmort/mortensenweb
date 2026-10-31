import { z } from "zod";
import { CONVERSION_STEPS } from "@/db/repositories/admin/conversion-steps";

/**
 * Request bodies for `/api/operator/*`.
 *
 * Strict: an unknown field is refused rather than ignored. The caller is an
 * agent, and `contactEmial` silently dropped would convert a client with no
 * email and report success.
 */

const line = (max: number) => z.string().trim().min(1).max(max);
const email = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Not an email address.");

export const createProspectBody = z.strictObject({
  businessName: z.string().trim().min(2).max(120),
  sourceWebsiteUrl: line(500).optional(),
  industry: line(200).optional(),
  location: line(200).optional(),
  serviceArea: line(200).optional(),
  tone: line(200).optional(),
  notes: line(4000).optional(),
  planKey: line(60).optional(),
  referenceRepo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "Use owner/name.")
    .optional(),
  contactName: line(200).optional(),
  contactEmail: email.optional(),
  contactPhone: line(40).optional(),
  consentNote: line(500).optional(),
  concept: z
    .strictObject({
      colourDirection: line(2000).optional(),
      features: line(4000).optional(),
      contentNotes: line(4000).optional(),
      body: line(4000).optional(),
    })
    .optional(),
  /** False records the potential client without scaffolding anything. */
  buildConcept: z.boolean().default(true),
  /** A second potential client with the same name is refused unless this is set. */
  allowDuplicate: z.boolean().default(false),
});

export type CreateProspectBody = z.infer<typeof createProspectBody>;

export const convertBody = z.strictObject({
  invite: z.boolean().default(false),
  contactName: line(200).optional(),
  contactEmail: email.optional(),
  booking: z.boolean().optional(),
  shop: z.boolean().optional(),
  rerun: z.array(z.enum(CONVERSION_STEPS)).max(CONVERSION_STEPS.length).default([]),
});

export type ConvertBody = z.infer<typeof convertBody>;
