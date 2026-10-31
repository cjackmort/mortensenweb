/**
 * The checkout flow as steps a person would take, one small function each.
 *
 * The spec reads as a list of these, so a change to the flow — the client
 * seeing the built preview first and paying the build at go-live, say — is an
 * edit to the steps it touches here and a reordering there, not a rewrite.
 * Everything that knows a label, a path or a piece of copy lives in this file.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { CREDENTIALS_FILE, FAKE_STRIPE_URL } from "./env";

export interface Account {
  identifier: string;
  password: string;
}

export type SeededClient = "build" | "invoice" | "live" | "code";

export interface DeliveredEvent {
  id: string;
  type: string;
  status: number;
  outcome: string | null;
}

/** Sign-in details written by the seed. Read when needed, never logged. */
export function accountFor(client: SeededClient): Account {
  const accounts = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as Record<SeededClient, Account>;
  return accounts[client];
}

export const newPassword = (): string => `${randomBytes(12).toString("base64url")}-Aa1`;

// ---- Signing in --------------------------------------------------------------

export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(account.identifier);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The forced first-run step: replace the temporary password. Lands on the welcome page. */
export async function chooseOwnPassword(page: Page, account: Account): Promise<void> {
  await expect(page).toHaveURL(/\/change-password/);
  const chosen = newPassword();
  await page.locator("#currentPassword").fill(account.password);
  await page.locator("#newPassword").fill(chosen);
  await page.locator("#confirmPassword").fill(chosen);
  await page.locator("main button[type=submit], form button[type=submit]").first().click();
  await expect(page).toHaveURL(/\/dashboard\/welcome\?first=1/);
}

/** Everything up to the moment a new client sees the page that asks for money. */
export async function arriveAtWelcomePage(page: Page, client: SeededClient): Promise<void> {
  const account = accountFor(client);
  await signIn(page, account);
  await chooseOwnPassword(page, account);
  await expect(page.getByRole("heading", { name: "Welcome to your portal" })).toBeVisible();
}

// ---- The welcome page --------------------------------------------------------

export async function choosePlan(page: Page, planName: string): Promise<void> {
  const option = page.locator("label.welcome-option").filter({ has: page.getByText(planName, { exact: true }) });
  await option.click();
  await expect(option.getByRole("radio")).toBeChecked();
}

/** The welcome page's pay button, whatever it says, and on to Stripe. */
export async function continueToPayment(page: Page): Promise<void> {
  await page.locator("#welcome-checkout button[type=submit]").click();
  await page.waitForURL(`${FAKE_STRIPE_URL}/checkout/**`);
}

/** The built site comes first: its picture and a link to its Netlify address (decision D1). */
export async function expectPreviewShown(page: Page, client: SeededClient): Promise<void> {
  await expect(page.getByRole("heading", { name: "Your new website" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open your site" })).toHaveAttribute(
    "href",
    `https://welcome-${client}-e2e.netlify.app`,
  );
}

/** "Put it live — $500": paying for the build is what puts the site live. */
export async function putItLive(page: Page, dollars: string): Promise<void> {
  await page.getByRole("button", { name: `Put it live — $${dollars}` }).first().click();
  await page.waitForURL(`${FAKE_STRIPE_URL}/checkout/**`);
}

// ---- Stripe's page (the stand-in) --------------------------------------------

/** What Stripe's page says is due, in dollars, e.g. `550.00`. */
export async function amountDueOnStripe(page: Page): Promise<string> {
  await expect(page.getByText("Local stand-in for Stripe Checkout")).toBeVisible();
  const due = await page.getByRole("row", { name: /Due today/ }).innerText();
  return due.match(/\$([\d,.]+)/)![1]!;
}

/** A code typed on Stripe's page, as a client with a build code does. */
export async function applyPromotionCode(page: Page, code: string): Promise<void> {
  await page.getByLabel("Promotion code").fill(code);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(`Code ${code} applied.`)).toBeVisible();
}

/** Pay, and come back to the portal the way Stripe sends a client back. */
export async function payOnStripe(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Pay / }).click();
  await page.waitForURL(/\/dashboard\/get-started\?paid=1/);
}

export async function eventsDelivered(page: Page): Promise<DeliveredEvent[]> {
  const response = await page.request.get(`${FAKE_STRIPE_URL}/__fake/events`);
  return (await response.json()) as DeliveredEvent[];
}

// ---- What the client can see afterwards --------------------------------------

export async function expectPayItemDone(page: Page, done: boolean): Promise<void> {
  await page.goto("/dashboard/get-started");
  const item = page.locator("li.todo").filter({ hasText: "Pay for your website" });
  if (done) {
    await expect(item).toHaveClass(/todo--done/);
  } else {
    await expect(item).not.toHaveClass(/todo--done/);
  }
}

export async function expectChangeRequestsUnlocked(page: Page, unlocked: boolean): Promise<void> {
  await page.goto("/dashboard/requests");
  const lockedNotice = page.getByText("Change requests unlock once your first payment goes through.");
  if (unlocked) {
    await expect(page.getByRole("heading", { name: "Make a request" })).toBeVisible();
    await expect(lockedNotice).toHaveCount(0);
  } else {
    await expect(lockedNotice).toBeVisible();
  }
}

/**
 * The ledger on Billing — the `payments` table — holds exactly these rows, in
 * dollars, e.g. `["500.00", "50.00"]`: a first invoice with the build on it is
 * the build's row and the plan's. The card panel above it shows its own list
 * of Stripe receipts under an `h3`; the `h2` is the ledger.
 */
export async function expectPaymentsRecorded(page: Page, dollars: string[]): Promise<void> {
  await page.goto("/dashboard/billing");
  const ledger = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Payment history", level: 2 }) });
  await expect(ledger.getByText(`${dollars.length} recorded`)).toBeVisible();
  for (const amount of new Set(dollars)) {
    await expect(ledger.getByRole("row").filter({ hasText: `$${amount}` })).toHaveCount(
      dollars.filter((d) => d === amount).length,
    );
  }
}

/** Every event the stand-in sent since `before` reached the portal and was acted on. */
export function expectAllProcessed(events: DeliveredEvent[], types: string[]): void {
  expect(events.map((e) => e.type)).toEqual(types);
  for (const event of events) {
    expect(event, `${event.type} was answered ${event.status} (${event.outcome ?? "no outcome"})`).toMatchObject({
      status: 200,
      outcome: "processed",
    });
  }
}
