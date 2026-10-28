import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, businessProfiles, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { initialsFor, ownAvatarUrl } from "@/lib/profile/avatar";
import { parseDetailsForm } from "@/lib/profile/details";
import type { StorageDriver } from "@/lib/storage";
import {
  getOwnProfile,
  readOwnAvatar,
  removeOwnAvatar,
  saveOwnBusinessProfile,
  setOwnAvatar,
  updateOwnDetails,
} from "@/db/repositories/client/profile";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * A client editing their own profile.
 *
 * What would go wrong quietly: a sign-in email changed by whoever found a
 * phone unlocked; one client's business details landing on another's; a
 * replaced picture leaving the old file behind or the row pointing at a
 * deleted one; and an operator "viewing as" a client changing anything.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

const PASSWORD = "correct horse battery";

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex Roofing");
  await db
    .update(users)
    .set({ name: "Dana Acme", passwordHash: await hashPassword(PASSWORD) })
    .where(eq(users.id, acme.userId));
});

afterAll(async () => close());

function memoryStore(): StorageDriver & { keys: () => string[] } {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(input) {
      objects.set(input.key, input.bytes);
      return { key: input.key, size: input.bytes.byteLength, contentType: input.contentType };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "application/octet-stream" } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    keys: () => [...objects.keys()],
  };
}

async function auditActions(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.organizationId, organizationId));
  return rows.map((r) => r.action);
}

describe("the details form", () => {
  it("trims the name and lowercases the email, and refuses an email that is not one", () => {
    const fd = new FormData();
    fd.set("name", "  Dana Acme ");
    fd.set("email", " Dana@Acme.EXAMPLE ");
    fd.set("currentPassword", "x");
    const parsed = parseDetailsForm(fd);
    expect(parsed).toEqual({
      ok: true,
      input: { name: "Dana Acme", email: "dana@acme.example", currentPassword: "x" },
    });

    fd.set("email", "not an address");
    const refused = parseDetailsForm(fd);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.email).toBe("Enter an email address.");
  });
});

describe("changing name and email", () => {
  it("changes the name without asking for the password", async () => {
    const me = await getOwnProfile(db, acme.ctx);
    const result = await updateOwnDetails(db, acme.ctx, {
      name: "Dana A.",
      email: me.email,
      currentPassword: "",
    });
    expect(result).toEqual({ ok: true, changed: ["name"] });
    expect((await getOwnProfile(db, acme.ctx)).name).toBe("Dana A.");
  });

  it("refuses a new email without the current password, and with the wrong one", async () => {
    const me = await getOwnProfile(db, acme.ctx);
    const without = await updateOwnDetails(db, acme.ctx, {
      name: me.name ?? "",
      email: "new@acme.example",
      currentPassword: "",
    });
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.field).toBe("currentPassword");

    const wrong = await updateOwnDetails(db, acme.ctx, {
      name: me.name ?? "",
      email: "new@acme.example",
      currentPassword: "not it",
    });
    expect(wrong.ok).toBe(false);
    expect((await getOwnProfile(db, acme.ctx)).email).toBe(me.email);
  });

  it("changes the email with the right password, lowercased, and records where it moved", async () => {
    const me = await getOwnProfile(db, acme.ctx);
    const result = await updateOwnDetails(db, acme.ctx, {
      name: me.name ?? "",
      email: "Owner@Acme.Example",
      currentPassword: PASSWORD,
    });
    expect(result).toEqual({ ok: true, changed: ["email"] });
    expect((await getOwnProfile(db, acme.ctx)).email).toBe("owner@acme.example");

    const rows = await db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, "user.details_changed"));
    expect(rows.map((r) => r.metadata)).toContainEqual({
      changed: ["email"],
      emailFrom: me.email,
      emailTo: "owner@acme.example",
    });
  });

  it("refuses an email another account already uses", async () => {
    const other = await getOwnProfile(db, globex.ctx);
    const result = await updateOwnDetails(db, acme.ctx, {
      name: "Dana A.",
      email: other.email.toUpperCase(),
      currentPassword: PASSWORD,
    });
    expect(result).toEqual({
      ok: false,
      field: "email",
      message: "That email address is already in use.",
    });
  });

  it("refuses while an operator is viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "client", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(
      updateOwnDetails(db, viewing, { name: "X", email: "x@acme.example", currentPassword: PASSWORD }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("the picture", () => {
  it("is stored under the person's own key, replaced in place, and removed with its file", async () => {
    const store = memoryStore();
    const me = await getOwnProfile(db, acme.ctx);
    const picture = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp" as const };

    const first = await setOwnAvatar(db, acme.ctx, picture, { avatars: store, version: () => "0000aaaa" });
    expect(first.key).toBe(`u/${me.publicId}-0000aaaa.webp`);
    expect(store.keys()).toEqual([first.key]);
    expect((await getOwnProfile(db, acme.ctx)).avatarKey).toBe(first.key);
    expect(ownAvatarUrl(first.key)).toBe("/dashboard/profile/avatar?v=0000aaaa");

    const read = await readOwnAvatar(db, acme.ctx, { avatars: store });
    expect(read).toEqual({ bytes: picture.bytes, contentType: "image/webp" });

    const second = await setOwnAvatar(
      db,
      acme.ctx,
      { bytes: new Uint8Array([4]), contentType: "image/webp" },
      { avatars: store, version: () => "0000bbbb" },
    );
    expect(store.keys()).toEqual([second.key]);
    expect((await getOwnProfile(db, acme.ctx)).avatarKey).toBe(second.key);

    await removeOwnAvatar(db, acme.ctx, { avatars: store });
    expect(store.keys()).toEqual([]);
    expect((await getOwnProfile(db, acme.ctx)).avatarKey).toBeNull();
    expect(await readOwnAvatar(db, acme.ctx, { avatars: store })).toBeNull();

    expect(await auditActions(acme.organizationId)).toEqual(
      expect.arrayContaining(["user.avatar_changed", "user.avatar_removed"]),
    );
  });

  it("falls back to initials", () => {
    expect(initialsFor("Dana Acme", "d@x.test")).toBe("DA");
    expect(initialsFor("Dana Lee Acme", "d@x.test")).toBe("DA");
    expect(initialsFor("Dana", "d@x.test")).toBe("DA");
    expect(initialsFor("Dana Reyes (DEMO)", "d@x.test")).toBe("DR");
    expect(initialsFor(null, "owner@x.test")).toBe("O");
    expect(initialsFor("   ", "owner@x.test")).toBe("O");
  });
});

describe("the business's general information", () => {
  it("saves the client's own profile and flags the fields that route calls and leads", async () => {
    const outcome = await saveOwnBusinessProfile(db, acme.ctx, {
      businessName: "Acme Plumbing",
      phone: "801 555 0100",
      hours: "Mon–Fri 8am–5pm",
    });
    expect(outcome).toEqual({
      changed: ["businessName", "phone", "hours"],
      routingChanged: ["phone"],
    });

    const [row] = await db
      .select({ details: businessProfiles.details, updatedBy: businessProfiles.updatedBy })
      .from(businessProfiles)
      .where(eq(businessProfiles.organizationId, acme.organizationId));
    expect(row!.details).toEqual({
      businessName: "Acme Plumbing",
      phone: "801 555 0100",
      hours: "Mon–Fri 8am–5pm",
    });
    expect(row!.updatedBy).toBe(acme.userId);

    const [audit] = await db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, "business_profile.updated"));
    expect(audit!.metadata).toEqual({
      changed: ["businessName", "phone", "hours"],
      by: "client",
      routingChanged: ["phone"],
    });
  });

  it("replaces the whole profile, so a cleared field is gone, and says when nothing changed", async () => {
    const first = await saveOwnBusinessProfile(db, acme.ctx, { businessName: "Acme Plumbing" });
    expect(first.changed).toEqual(["phone", "hours"]);
    const again = await saveOwnBusinessProfile(db, acme.ctx, { businessName: "Acme Plumbing" });
    expect(again).toEqual({ changed: [], routingChanged: [] });
  });

  it("never touches another client's profile", async () => {
    await saveOwnBusinessProfile(db, globex.ctx, { businessName: "Globex Roofing" });
    const rows = await db.select({ organizationId: businessProfiles.organizationId, details: businessProfiles.details }).from(businessProfiles);
    expect(rows.find((r) => r.organizationId === acme.organizationId)!.details).toEqual({
      businessName: "Acme Plumbing",
    });
    expect(rows.find((r) => r.organizationId === globex.organizationId)!.details).toEqual({
      businessName: "Globex Roofing",
    });
  });

  it("refuses while an operator is viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "client", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(saveOwnBusinessProfile(db, viewing, { businessName: "Nope" })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
