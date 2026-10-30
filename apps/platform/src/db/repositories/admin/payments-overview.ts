import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  organizations,
  paymentRequests,
  servicePlans,
  subscriptions,
} from "@/db/schema";
import { nextBillingDate } from "@/lib/billing/billing-day";
import { businessDate } from "@/lib/billing/period";
import { discountApplies, effectiveMonthlyCents } from "@/lib/payments/promos";
import type { AdminContext } from "../context";

/**
 * The payments page, as the operator reads it: every client and how they pay,
 * then everyone who owes money.
 *
 * The page this replaces split "Waiting on you" (clients who said they paid)
 * from "Overdue", and listed plans, monthly billing and subscriptions in three
 * different tables. It was correct and nobody could read it. This is one row
 * per client and one list of unpaid invoices; a client who said they paid is
 * on that list, marked, rather than in a section of their own, so they are
 * never lost and never chased (the dunning ladder still suppresses them).
 *
 * Plain queries reduced in JS: a handful of clients, an operator page, and
 * the rules (which plan wins, what counts as overdue) read better as code.
 */

/** How a client's money arrives. */
export type BillingMode =
  /** A processor charges their card each month: Stripe, or a Square mandate. */
  | "auto"
  /** A plan billed by hand: an invoice paid by Venmo, cash or check. */
  | "invoiced"
  /** Free, by the operator's choice (`clients.comp_plan_id`). */
  | "comp"
  /** No plan yet. */
  | "none";

/** Where a client stands, most urgent first. */
export type ClientStanding =
  | { kind: "says_paid" }
  | { kind: "overdue"; days: number }
  | { kind: "card_failing"; providerStatus: string }
  /** Days until due; 0 is today. */
  | { kind: "due"; days: number }
  | { kind: "comp" }
  /** On a hand-billed plan, never billed. */
  | { kind: "not_billed" }
  | { kind: "no_plan" }
  | { kind: "paid_up" };

export interface UnsettledInvoice {
  publicId: string;
  reference: string;
  amountCents: number;
  currency: string;
  dueOn: string | null;
  purpose: string;
  note: string | null;
  /** The client pressed "I've paid": we owe them a check, not a reminder. */
  saysPaid: boolean;
  saysPaidAt: Date | null;
  /** Negative before the due date; 0 with no due date. */
  daysOverdue: number;
  /** The operator last said "Not paid, still owed" on this invoice. */
  lastCheckedAt: Date | null;
}

export interface ClientMoneyRow {
  clientPublicId: string;
  organizationName: string;
  isDemo: boolean;
  mode: BillingMode;
  planName: string | null;
  /** What they pay a month now: the promo price while one runs. Null when free or planless. */
  priceCents: number | null;
  listPriceCents: number | null;
  discountLabel: string | null;
  currency: string;
  provider: string | null;
  cancelAtPeriodEnd: boolean;
  /**
   * The next money event: a card charge, an invoice falling due, the day the
   * next hand bill should go out, or the day a cancelled plan ends.
   */
  next: { on: string; kind: "charge" | "due" | "bill" | "ends" } | null;
  standing: ClientStanding;
  /** Every unpaid invoice, oldest due first. */
  unsettled: UnsettledInvoice[];
  /** A hand-billed client with no open monthly invoice: ready for the next. */
  canBill: boolean;
}

export type OverdueItem =
  | {
      kind: "invoice";
      clientPublicId: string;
      organizationName: string;
      invoice: UnsettledInvoice;
    }
  | {
      /** Stripe could not charge their card. Stripe retries; the operator may chase. */
      kind: "card";
      clientPublicId: string;
      organizationName: string;
      amountCents: number;
      currency: string;
      providerStatus: string;
    };

export interface PaymentsTotals {
  /** Owed and past due, not counting invoices the client says they paid. */
  overdueCents: number;
  overdueClients: number;
  saysPaidCount: number;
  /** What paying clients' plans bring in a month. Free, demo and internal excluded. */
  monthlyPlanCents: number;
  autoCount: number;
  invoicedCount: number;
  compCount: number;
}

export interface PaymentsOverview {
  clients: ClientMoneyRow[];
  overdue: OverdueItem[];
  totals: PaymentsTotals;
}

const UNSETTLED = ["open", "overdue", "awaiting_confirmation"] as const;

/** Stripe's words for a card it tried and could not charge. */
const CARD_FAILING: ReadonlySet<string> = new Set(["past_due", "unpaid", "incomplete"]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from one calendar date to another. */
function daysBetween(from: string, to: string): number {
  const at = (d: string) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((at(to) - at(from)) / MS_PER_DAY);
}

const compPlan = alias(servicePlans, "comp_plan_payments");

async function loadClients(db: Database) {
  return db
    .select({
      clientId: clients.id,
      clientPublicId: clients.publicId,
      organizationName: organizations.name,
      isDemo: clients.isDemo,
      compPlanId: clients.compPlanId,
      compPlanName: compPlan.name,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .leftJoin(compPlan, eq(compPlan.id, clients.compPlanId))
    // The agency's own site is a `clients` row so it can share the pipeline,
    // but nobody bills it — the same exclusion every client list applies.
    .where(and(isNull(clients.archivedAt), eq(clients.isInternal, false)))
    .orderBy(organizations.name);
}

async function loadPlans(db: Database, clientIds: string[]) {
  const rows = await db
    .select({
      clientId: subscriptions.clientId,
      planName: servicePlans.name,
      monthlyPriceCents: subscriptions.monthlyPriceCents,
      discountedPriceCents: subscriptions.discountedPriceCents,
      discountEndsAt: subscriptions.discountEndsAt,
      discountLabel: subscriptions.discountLabel,
      currency: subscriptions.currency,
      billingDay: subscriptions.billingDay,
      provider: subscriptions.provider,
      providerStatus: subscriptions.providerStatus,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    })
    .from(subscriptions)
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(and(eq(subscriptions.status, "active"), inArray(subscriptions.clientId, clientIds)));

  // A client can briefly hold two active plans — the hand-billed one and the
  // processor's one replacing it. The processor's wins: it is what they are
  // actually charged (the same rule as `listClientBillingStatus`).
  const byClient = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const seen = byClient.get(row.clientId);
    if (!seen || (row.provider && !seen.provider)) byClient.set(row.clientId, row);
  }
  return byClient;
}

async function loadInvoices(db: Database, clientIds: string[], today: string) {
  const rows = await db
    .select({
      clientId: paymentRequests.clientId,
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
      currency: paymentRequests.currency,
      dueOn: paymentRequests.dueOn,
      status: paymentRequests.status,
      purpose: paymentRequests.purpose,
      note: paymentRequests.note,
      initiatedAt: paymentRequests.initiatedAt,
    })
    .from(paymentRequests)
    .where(
      and(
        inArray(paymentRequests.clientId, clientIds),
        inArray(paymentRequests.status, [...UNSETTLED]),
      ),
    );

  const checks =
    rows.length === 0
      ? []
      : await db
          .select({
            entityId: auditLog.entityId,
            at: sql<Date>`max(${auditLog.createdAt})`.mapWith((v) => new Date(v)),
          })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "payment_request.checked"),
              inArray(
                auditLog.entityId,
                rows.map((r) => r.publicId),
              ),
            ),
          )
          .groupBy(auditLog.entityId);
  const checkedAt = new Map(checks.map((c) => [c.entityId, c.at]));

  const byClient = new Map<string, UnsettledInvoice[]>();
  for (const row of rows) {
    const invoice: UnsettledInvoice = {
      publicId: row.publicId,
      reference: row.reference,
      amountCents: row.amountCents,
      currency: row.currency,
      dueOn: row.dueOn,
      purpose: row.purpose,
      note: row.note,
      saysPaid: row.status === "awaiting_confirmation",
      saysPaidAt: row.status === "awaiting_confirmation" ? row.initiatedAt : null,
      daysOverdue: row.dueOn ? daysBetween(row.dueOn, today) : 0,
      lastCheckedAt: checkedAt.get(row.publicId) ?? null,
    };
    byClient.set(row.clientId, [...(byClient.get(row.clientId) ?? []), invoice]);
  }

  for (const [clientId, list] of byClient) {
    byClient.set(
      clientId,
      [...list].sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999")),
    );
  }
  return byClient;
}

/** Clients who have had a monthly invoice raised at least once. */
async function loadEverBilled(db: Database, clientIds: string[]): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ clientId: paymentRequests.clientId })
    .from(paymentRequests)
    .where(
      and(
        inArray(paymentRequests.clientId, clientIds),
        eq(paymentRequests.purpose, "subscription"),
      ),
    );
  return new Set(rows.map((r) => r.clientId));
}

type Plan = Awaited<ReturnType<typeof loadPlans>> extends Map<string, infer P> ? P : never;

function modeOf(compPlanId: string | null, plan: Plan | undefined): BillingMode {
  if (compPlanId) return "comp";
  if (!plan) return "none";
  return plan.provider ? "auto" : "invoiced";
}

function nextOf(
  mode: BillingMode,
  plan: Plan | undefined,
  unsettled: UnsettledInvoice[],
  today: string,
): ClientMoneyRow["next"] {
  if (mode === "comp" || mode === "none" || !plan) return null;

  if (mode === "auto") {
    const on = plan.currentPeriodEnd
      ? businessDate(plan.currentPeriodEnd)
      : nextBillingDate(plan.billingDay, today);
    return { on, kind: plan.cancelAtPeriodEnd ? "ends" : "charge" };
  }

  const due = unsettled.find((i) => i.dueOn && !i.saysPaid);
  if (due?.dueOn) return { on: due.dueOn, kind: "due" };
  return { on: nextBillingDate(plan.billingDay, today), kind: "bill" };
}

function standingOf(
  mode: BillingMode,
  plan: Plan | undefined,
  unsettled: UnsettledInvoice[],
  everBilled: boolean,
): ClientStanding {
  if (unsettled.some((i) => i.saysPaid)) return { kind: "says_paid" };

  const worst = Math.max(...unsettled.filter((i) => i.dueOn).map((i) => i.daysOverdue), -Infinity);
  if (worst >= 1) return { kind: "overdue", days: worst };

  if (mode === "auto" && plan?.providerStatus && CARD_FAILING.has(plan.providerStatus)) {
    return { kind: "card_failing", providerStatus: plan.providerStatus };
  }
  if (Number.isFinite(worst)) return { kind: "due", days: -worst };
  if (mode === "comp") return { kind: "comp" };
  if (mode === "none") return { kind: "no_plan" };
  if (mode === "invoiced" && !everBilled) return { kind: "not_billed" };
  return { kind: "paid_up" };
}

/** Says-they-paid first (they are waiting on us), then the longest overdue. */
function overdueOrder(a: OverdueItem, b: OverdueItem): number {
  const rank = (o: OverdueItem) => (o.kind === "card" ? 2 : o.invoice.saysPaid ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.kind === "invoice" && b.kind === "invoice") {
    return b.invoice.daysOverdue - a.invoice.daysOverdue;
  }
  return a.organizationName.localeCompare(b.organizationName);
}

export async function paymentsOverview(
  _ctx: AdminContext,
  db: Database,
  now: Date = new Date(),
): Promise<PaymentsOverview> {
  const today = businessDate(now);
  const clientRows = await loadClients(db);
  const ids = clientRows.map((c) => c.clientId);

  const empty: PaymentsTotals = {
    overdueCents: 0,
    overdueClients: 0,
    saysPaidCount: 0,
    monthlyPlanCents: 0,
    autoCount: 0,
    invoicedCount: 0,
    compCount: 0,
  };
  if (ids.length === 0) return { clients: [], overdue: [], totals: empty };

  const [plans, invoices, everBilled] = await Promise.all([
    loadPlans(db, ids),
    loadInvoices(db, ids, today),
    loadEverBilled(db, ids),
  ]);

  const rows: ClientMoneyRow[] = [];
  const overdue: OverdueItem[] = [];

  for (const c of clientRows) {
    const plan = plans.get(c.clientId);
    const unsettled = invoices.get(c.clientId) ?? [];
    const mode = modeOf(c.compPlanId, plan);
    const priced = mode === "auto" || mode === "invoiced";
    const standing = standingOf(mode, plan, unsettled, everBilled.has(c.clientId));

    rows.push({
      clientPublicId: c.clientPublicId,
      organizationName: c.organizationName,
      isDemo: c.isDemo,
      mode,
      planName: mode === "comp" ? c.compPlanName : (plan?.planName ?? null),
      priceCents: priced && plan ? effectiveMonthlyCents(plan, now) : null,
      listPriceCents: priced && plan ? plan.monthlyPriceCents : null,
      discountLabel: priced && plan && discountApplies(plan, now) ? plan.discountLabel : null,
      currency: plan?.currency ?? "USD",
      provider: plan?.provider ?? null,
      cancelAtPeriodEnd: plan?.cancelAtPeriodEnd ?? false,
      next: nextOf(mode, plan, unsettled, today),
      standing,
      unsettled,
      canBill:
        mode === "invoiced" &&
        !unsettled.some((i) => i.purpose === "subscription"),
    });

    for (const invoice of unsettled) {
      if (invoice.saysPaid || (invoice.dueOn && invoice.daysOverdue >= 1)) {
        overdue.push({
          kind: "invoice",
          clientPublicId: c.clientPublicId,
          organizationName: c.organizationName,
          invoice,
        });
      }
    }

    if (standing.kind === "card_failing" && plan) {
      overdue.push({
        kind: "card",
        clientPublicId: c.clientPublicId,
        organizationName: c.organizationName,
        amountCents: effectiveMonthlyCents(plan, now),
        currency: plan.currency,
        providerStatus: standing.providerStatus,
      });
    }
  }

  overdue.sort(overdueOrder);

  const owing = overdue.filter((o) => o.kind === "card" || !o.invoice.saysPaid);
  const paying = rows.filter((r) => !r.isDemo && (r.mode === "auto" || r.mode === "invoiced"));

  return {
    clients: rows,
    overdue,
    totals: {
      overdueCents: owing.reduce(
        (sum, o) => sum + (o.kind === "card" ? o.amountCents : o.invoice.amountCents),
        0,
      ),
      overdueClients: new Set(owing.map((o) => o.clientPublicId)).size,
      saysPaidCount: overdue.length - owing.length,
      monthlyPlanCents: paying.reduce((sum, r) => sum + (r.priceCents ?? 0), 0),
      autoCount: rows.filter((r) => r.mode === "auto").length,
      invoicedCount: rows.filter((r) => r.mode === "invoiced").length,
      compCount: rows.filter((r) => r.mode === "comp").length,
    },
  };
}
