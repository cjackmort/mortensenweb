import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_ALGO,
  PBKDF2_ITERATIONS,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  sha256Hex,
  verifyPassword,
} from "@/lib/auth/password";

describe("password hashing", () => {
  it("produces a PHC-style string recording algorithm and parameters", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith(`$${PASSWORD_ALGO}$i=${PBKDF2_ITERATIONS}$`)).toBe(
      true,
    );

    const parsed = parsePasswordHash(stored);
    expect(parsed).not.toBeNull();
    expect(parsed?.algo).toBe(PASSWORD_ALGO);
    expect(parsed?.iterations).toBe(PBKDF2_ITERATIONS);
    expect(parsed?.salt.length).toBe(16);
    expect(parsed?.hash.length).toBe(32);
  });

  it("verifies a correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", stored),
    ).resolves.toBe(true);
    await expect(
      verifyPassword("correct horse battery stapl", stored),
    ).resolves.toBe(false);
  });

  it("salts: the same password hashes differently every time", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
    // ...but both still verify.
    await expect(
      verifyPassword("correct horse battery staple", a),
    ).resolves.toBe(true);
    await expect(
      verifyPassword("correct horse battery staple", b),
    ).resolves.toBe(true);
  });

  it("rejects rather than throws on malformed or absent hashes", async () => {
    await expect(verifyPassword("anything", null)).resolves.toBe(false);
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
    await expect(verifyPassword("anything", "not-a-phc-string")).resolves.toBe(
      false,
    );
    await expect(verifyPassword("anything", "$md5$i=1$AAAA$AAAA")).resolves.toBe(
      false,
    );
  });

  it("refuses to hash a password below the minimum length", async () => {
    const tooShort = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    await expect(hashPassword(tooShort)).rejects.toThrow(/at least/i);
  });

  it("flags weaker stored parameters for rehash", async () => {
    const current = await hashPassword("correct horse battery staple");
    expect(needsRehash(current)).toBe(false);

    const weakened = current.replace(
      `i=${PBKDF2_ITERATIONS}`,
      "i=1000",
    );
    expect(needsRehash(weakened)).toBe(true);
    expect(needsRehash(null)).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
  });

  it("normalises unicode so equivalent inputs verify", async () => {
    // U+00E9 vs U+0065 U+0301 — visually identical, different bytes.
    const composed = "café-password-1234";
    const decomposed = "café-password-1234";
    const stored = await hashPassword(composed);
    await expect(verifyPassword(decomposed, stored)).resolves.toBe(true);
  });

  it("hashes deterministically for token storage", async () => {
    const a = await sha256Hex("token-value");
    const b = await sha256Hex("token-value");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(await sha256Hex("other")).not.toBe(a);
  });
});
