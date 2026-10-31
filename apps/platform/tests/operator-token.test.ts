import { afterEach, describe, expect, it } from "vitest";
import { bearerToken, checkOperatorToken } from "@/lib/auth/operator-token";
import { sha256Hex } from "@/lib/auth/password";

/**
 * The operator API's token check, on its own. The portal holds only the
 * token's SHA-256; anything that is not exactly that token is refused, and an
 * unconfigured or malformed hash refuses everything.
 */

const TOKEN = "op_test_8f0c2b9a6d4e1f3a5c7b9d0e2f4a6c8b0d2e4f6a";

function headers(value?: string): Headers {
  return new Headers(value === undefined ? {} : { authorization: value });
}

afterEach(() => {
  delete process.env.OPERATOR_API_TOKEN_SHA256;
});

describe("checkOperatorToken", () => {
  it("accepts the token whose hash is configured, in either case of hex", async () => {
    process.env.OPERATOR_API_TOKEN_SHA256 = (await sha256Hex(TOKEN)).toUpperCase();
    expect(await checkOperatorToken(headers(`Bearer ${TOKEN}`))).toBe("ok");
  });

  it("refuses everything when the hash is unset or not a SHA-256", async () => {
    expect(await checkOperatorToken(headers(`Bearer ${TOKEN}`))).toBe("not_configured");
    process.env.OPERATOR_API_TOKEN_SHA256 = TOKEN;
    expect(await checkOperatorToken(headers(`Bearer ${TOKEN}`))).toBe("not_configured");
  });

  it("refuses a missing, short or wrong token", async () => {
    process.env.OPERATOR_API_TOKEN_SHA256 = await sha256Hex(TOKEN);
    expect(await checkOperatorToken(headers())).toBe("missing");
    expect(await checkOperatorToken(headers("Basic abc"))).toBe("missing");
    expect(await checkOperatorToken(headers("Bearer short"))).toBe("invalid");
    expect(await checkOperatorToken(headers(`Bearer ${TOKEN.slice(0, -1)}0`))).toBe("invalid");
  });

  it("does not accept the hash itself as the token", async () => {
    const hash = await sha256Hex(TOKEN);
    process.env.OPERATOR_API_TOKEN_SHA256 = hash;
    expect(await checkOperatorToken(headers(`Bearer ${hash}`))).toBe("invalid");
  });
});

describe("bearerToken", () => {
  it("reads one token and nothing else", () => {
    expect(bearerToken(headers(`bearer ${TOKEN}`))).toBe(TOKEN);
    expect(bearerToken(headers(`Bearer ${TOKEN} extra`))).toBeNull();
  });
});
