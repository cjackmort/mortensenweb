import { test, expect, type Page } from "@playwright/test";
import { BUILD, PLANS } from "@mortensenweb/plans";
import { PORTAL_URL } from "./env";
import * as step from "./steps";

/**
 * The welcome checkout from first sign-in to a client who has paid, against the
 * Stripe stand-in and a throwaway database. On demand:
 *
 *   npm run e2e:checkout --workspace apps/platform
 *
 * The flow is a list of steps from `steps.ts`. When the flow changes (decision
 * D1: the client sees the built preview first and pays the build at go-live),
 * this file is where the order changes and `steps.ts` is where a step does.
 */

const plan = PLANS.find((p) => p.key === "care")!;
const dollars = (cents: number) => (cents / 100).toFixed(2);

const SUBSCRIPTION_EVENTS = ["checkout.session.completed", "customer.subscription.created", "invoice.paid"];

test("a new client pays for the site and a plan and is let in", async ({ page }) => {
  await test.step("sign in with the temporary password and choose their own", () =>
    step.arriveAtWelcomePage(page, "build"));

  await test.step("before paying, nothing is unlocked and nothing is recorded", async () => {
    await step.expectPayItemDone(page, false);
    await step.expectChangeRequestsUnlocked(page, false);
  });

  const eventsBefore = (await step.eventsDelivered(page)).length;

  await test.step("choose the build and a plan, and go to Stripe", async () => {
    await page.goto("/dashboard/welcome?first=1");
    await step.choosePlan(page, plan.name);
    await step.continueToPayment(page);
    expect(await step.amountDueOnStripe(page)).toBe(dollars(BUILD.priceCents + plan.monthlyCents));
  });

  await test.step("pay, and Stripe tells the portal", async () => {
    await step.payOnStripe(page);
    const sent = (await step.eventsDelivered(page)).slice(eventsBefore);
    step.expectAllProcessed(sent, SUBSCRIPTION_EVENTS);
  });

  await test.step("the client is paid up and let in", async () => {
    await step.expectPayItemDone(page, true);
    await step.expectChangeRequestsUnlocked(page, true);
    await step.expectPaymentRecorded(page, dollars(BUILD.priceCents + plan.monthlyCents));
  });
});

test.describe("a plan paid while the build invoice is still open", () => {
  // One payment, then two questions about it. Kept as separate tests so the
  // one that is known to fail cannot also hide a break in getting there.
  test.describe.configure({ mode: "serial" });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ baseURL: PORTAL_URL });
    const eventsBefore = (await step.eventsDelivered(page)).length;

    await step.arriveAtWelcomePage(page, "invoice");
    await step.choosePlan(page, plan.name);
    await step.continueToPayment(page);
    expect(await step.amountDueOnStripe(page)).toBe(dollars(plan.monthlyCents));
    await step.payOnStripe(page);

    step.expectAllProcessed((await step.eventsDelivered(page)).slice(eventsBefore), SUBSCRIPTION_EVENTS);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("records the plan payment, and only that amount", async () => {
    await step.expectPaymentRecorded(page, dollars(plan.monthlyCents));
  });

  test("does not count the website as paid", async () => {
    // KNOWN BUG, roadmap P1.3: any invoice that collects money unlocks the
    // client (`applyPaidInvoice` → `unlockClientFeatures` whenever
    // `amount_paid` > 0), so paying $50 for a plan lets in a client who still
    // owes the $500 build. Both checks below should hold once the unlock is
    // tied to the build being paid. When they do, Playwright reports "expected
    // to fail, but passed": delete the `test.fail()` line then.
    test.fail();

    await step.expectChangeRequestsUnlocked(page, false);
    await step.expectPayItemDone(page, false);
  });
});
