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
 * The flow is a list of steps from `steps.ts`. Decision D1 is the order: the
 * client sees the built preview first (with one free small change a month
 * until then, decision D7), and paying for the build is "Put it
 * live". A plan alone never pays for the build, and a build a 100%-off code
 * took to zero still does.
 */

const plan = PLANS.find((p) => p.key === "care")!;
const dollars = (cents: number) => (cents / 100).toFixed(2);
const whole = (cents: number) => String(cents / 100);

const SUBSCRIPTION_EVENTS = ["checkout.session.completed", "customer.subscription.created", "invoice.paid"];
const PAYMENT_EVENTS = ["checkout.session.completed"];

test("a new client sees their site, pays to put it live, and is let in", async ({ page }) => {
  await test.step("sign in with the temporary password and choose their own", () =>
    step.arriveAtWelcomePage(page, "live"));

  await test.step("the built site comes first, before anything is asked for", () =>
    step.expectPreviewShown(page, "live"));

  await test.step("before paying, small changes only and nothing is recorded", async () => {
    await step.expectPayItemDone(page, false);
    await step.expectChangeTier(page, "free");
  });

  await test.step("the month's free small change goes through, and a second waits (decision D7)", async () => {
    await step.sendSmallChange(page, "New phone number");
    await step.expectFreeChangeUsed(page);
  });

  const eventsBefore = (await step.eventsDelivered(page)).length;

  await test.step("put it live: the build alone, as one payment", async () => {
    await page.goto("/dashboard/welcome?first=1");
    await step.putItLive(page, whole(BUILD.priceCents));
    expect(await step.amountDueOnStripe(page)).toBe(dollars(BUILD.priceCents));
  });

  await test.step("pay, and Stripe tells the portal", async () => {
    await step.payOnStripe(page);
    step.expectAllProcessed((await step.eventsDelivered(page)).slice(eventsBefore), PAYMENT_EVENTS);
  });

  await test.step("the build is paid and the client is let in", async () => {
    await step.expectPayItemDone(page, true);
    await step.expectChangeTier(page, "plan");
    await step.expectPaymentsRecorded(page, [dollars(BUILD.priceCents)]);
  });
});

test("a new client pays for the site and a plan together, recorded as two payments", async ({ page }) => {
  await test.step("sign in with the temporary password and choose their own", () =>
    step.arriveAtWelcomePage(page, "build"));

  const eventsBefore = (await step.eventsDelivered(page)).length;

  await test.step("choose a plan beside the build, and go to Stripe", async () => {
    await step.choosePlan(page, plan.name);
    await step.putItLive(page, whole(BUILD.priceCents + plan.monthlyCents));
    expect(await step.amountDueOnStripe(page)).toBe(dollars(BUILD.priceCents + plan.monthlyCents));
  });

  await test.step("pay, and Stripe tells the portal", async () => {
    await step.payOnStripe(page);
    step.expectAllProcessed((await step.eventsDelivered(page)).slice(eventsBefore), SUBSCRIPTION_EVENTS);
  });

  await test.step("the build and the plan are each their own row, and the client is let in", async () => {
    await step.expectPayItemDone(page, true);
    await step.expectChangeTier(page, "plan");
    await step.expectPaymentsRecorded(page, [dollars(BUILD.priceCents), dollars(plan.monthlyCents)]);
  });
});

test("a 100%-off build code puts the site live for nothing", async ({ page }) => {
  await step.arriveAtWelcomePage(page, "code");
  const eventsBefore = (await step.eventsDelivered(page)).length;

  await test.step("the code takes the build to zero on Stripe's page", async () => {
    await step.putItLive(page, whole(BUILD.priceCents));
    await step.applyPromotionCode(page, "BUILD100");
    expect(await step.amountDueOnStripe(page)).toBe("0.00");
  });

  await test.step("it settles with nothing collected", async () => {
    await step.payOnStripe(page);
    step.expectAllProcessed((await step.eventsDelivered(page)).slice(eventsBefore), PAYMENT_EVENTS);
  });

  await test.step("the build counts as paid — not asked for $500 again — and the zero is what is recorded", async () => {
    await step.expectPayItemDone(page, true);
    await step.expectChangeTier(page, "plan");
    await step.expectPaymentsRecorded(page, ["0.00"]);
  });
});

test.describe("a plan paid while the build invoice is still open", () => {
  // One payment, then two questions about it. Kept as separate tests so a
  // failure in one cannot hide a break in getting there.
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
    await step.expectPaymentsRecorded(page, [dollars(plan.monthlyCents)]);
  });

  test("does not count the website as paid", async () => {
    // Roadmap P1.3: any invoice that collected money used to count as the
    // build, so $50 for a plan marked a client paid who still owed the $500.
    // The build stays owed: Get started still asks for it, and the site
    // cannot go live.
    await step.expectPayItemDone(page, false);
  });

  test("puts their changes on the plan they pay for (decision D7)", async () => {
    // A plan Stripe charges is a paid plan: its rules, not the free tier's,
    // even with the build still owed.
    await step.expectChangeTier(page, "plan");
  });
});
