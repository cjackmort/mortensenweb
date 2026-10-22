import { describe, expect, it, vi } from "vitest";
import { parseReviewLink, reviewUrlForPlace } from "@/lib/reviews/review-link";
import { normalizeEmail, normalizePhone, firstName } from "@/lib/reviews/contact";
import {
  DEFAULT_TEMPLATE,
  renderTemplate,
  validateTemplate,
} from "@/lib/reviews/template";
import { signReviewToken, verifyReviewToken } from "@/lib/reviews/tokens";
import { buildReviewEmail, buildReviewSms } from "@/lib/reviews/message";
import { isWithinSendingHours } from "@/lib/reviews/sending-hours";
import { getPlaceSummary, placesConfigured, searchPlaces } from "@/lib/reviews/places";
import { sendSms, smsConfigured } from "@/lib/reviews/sms";
import { createRateLimiter } from "@/lib/reviews/rate-limit";

const PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const WRITE_REVIEW = `https://search.google.com/local/writereview?placeid=${PLACE}`;

describe("parseReviewLink", () => {
  it("builds the review link from a bare place id", () => {
    expect(parseReviewLink(`  ${PLACE} `)).toEqual({ ok: true, placeId: PLACE, reviewUrl: WRITE_REVIEW });
    expect(reviewUrlForPlace(PLACE)).toBe(WRITE_REVIEW);
  });

  it("keeps the place id from a pasted write-review link", () => {
    expect(parseReviewLink(WRITE_REVIEW)).toEqual({ ok: true, placeId: PLACE, reviewUrl: WRITE_REVIEW });
    expect(parseReviewLink(`http://search.google.com/local/writereview?placeid=${PLACE}&hl=en`)).toEqual({
      ok: true,
      placeId: PLACE,
      reviewUrl: WRITE_REVIEW,
    });
  });

  it("accepts the short link from Google Business Profile's Ask for reviews", () => {
    expect(parseReviewLink("https://g.page/r/CabcdEFGhij1EBM/review")).toEqual({
      ok: true,
      placeId: null,
      reviewUrl: "https://g.page/r/CabcdEFGhij1EBM/review",
    });
  });

  it("explains that a Maps listing link is not the review form", () => {
    for (const input of [
      "https://maps.app.goo.gl/AbCdEf123",
      "https://www.google.com/maps/place/Acme+Plumbing/@40.5,-111.9,17z",
    ]) {
      const result = parseReviewLink(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/Ask for reviews/);
    }
  });

  it("refuses anything that is not a Google review link", () => {
    for (const input of [
      "",
      "https://evil.example/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4",
      "https://search.google.com.evil.example/local/writereview?placeid=x",
      "javascript:alert(1)",
      "https://g.page/r/abc/edit",
      "not a place id",
      "ChIJ<script>",
      "https://search.google.com/local/writereview",
    ]) {
      expect(parseReviewLink(input).ok).toBe(false);
    }
  });
});

describe("contact details", () => {
  it("lowercases and checks an email", () => {
    expect(normalizeEmail(" Dana@Example.TEST ")).toBe("dana@example.test");
    expect(normalizeEmail("dana@")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });

  it("turns a US number however it is typed into E.164", () => {
    for (const input of ["(801) 555-0123", "801-555-0123", "801.555.0123", "+1 801 555 0123", "18015550123"]) {
      expect(normalizePhone(input)).toBe("+18015550123");
    }
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses a number that cannot be texted", () => {
    expect(normalizePhone("555-0123")).toBeNull();
    expect(normalizePhone("call me")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("greets someone by the first word of their name", () => {
    expect(firstName("Dana Reyes")).toBe("Dana");
    expect(firstName("  Dana  ")).toBe("Dana");
  });
});

describe("the message template", () => {
  it("fills in the customer and the business", () => {
    expect(
      renderTemplate("Hi {first_name} ({name}), thanks from {business}.", {
        name: "Dana Reyes",
        business: "Acme Plumbing",
      }),
    ).toBe("Hi Dana (Dana Reyes), thanks from Acme Plumbing.");
  });

  it("passes its own default", () => {
    expect(validateTemplate(DEFAULT_TEMPLATE)).toEqual({ ok: true });
  });

  it("refuses a placeholder it does not know", () => {
    const result = validateTemplate({ ...DEFAULT_TEMPLATE, body: "Hi {email}" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("{email}");
  });

  it("refuses an empty or overlong message", () => {
    expect(validateTemplate({ ...DEFAULT_TEMPLATE, subject: "  " }).ok).toBe(false);
    expect(validateTemplate({ ...DEFAULT_TEMPLATE, body: "x".repeat(2001) }).ok).toBe(false);
  });

  it("refuses review gating: asking only happy customers, or for a star rating", () => {
    for (const body of [
      "If you were happy with our work, please leave a review.",
      "If you're satisfied, we'd love a review!",
      "Please leave us 5 stars on Google.",
      "A five-star review would mean the world.",
      "Not happy? Call us first before leaving a review.",
    ]) {
      const result = validateTemplate({ ...DEFAULT_TEMPLATE, body });
      expect(result.ok, body).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/honest review/);
    }
  });

  it("refuses offering anything in return for a review", () => {
    for (const reminderBody of [
      "Leave a review and get 10% off your next visit.",
      "Reviewers get a $20 gift card.",
      "Review us to be entered to win a free cleaning.",
    ]) {
      expect(validateTemplate({ ...DEFAULT_TEMPLATE, reminderBody }).ok, reminderBody).toBe(false);
    }
  });

  it("does not trip on ordinary friendly wording", () => {
    const body =
      "Hi {first_name},\n\nThanks for having us out. We're happy we could help. If you have a minute, an honest review on Google helps neighbours find us.\n\n{business}";
    expect(validateTemplate({ ...DEFAULT_TEMPLATE, body })).toEqual({ ok: true });
  });
});

describe("review link tokens", () => {
  const env = { AUTH_SECRET: "a".repeat(32) };

  it("round-trips a request id for its purpose", async () => {
    const token = await signReviewToken("01HZX3K4R6S7T8V9W0XYZABCDE", "click", env);
    expect(token).toMatch(/^[0-9A-Z]{26}\.[A-Za-z0-9_-]{22}$/);
    expect(await verifyReviewToken(token!, "click", env)).toBe("01HZX3K4R6S7T8V9W0XYZABCDE");
  });

  it("refuses a token signed for the other purpose, or altered", async () => {
    const token = (await signReviewToken("01HZX3K4R6S7T8V9W0XYZABCDE", "click", env))!;
    expect(await verifyReviewToken(token, "stop", env)).toBeNull();
    const [id, sig] = token.split(".");
    expect(await verifyReviewToken(`01HZX3K4R6S7T8V9W0XYZABCDF.${sig}`, "click", env)).toBeNull();
    expect(await verifyReviewToken(`${id}.${sig!.slice(0, -1)}A`, "click", env)).toBeNull();
    expect(await verifyReviewToken("garbage", "click", env)).toBeNull();
  });

  it("mints nothing without a signing secret", async () => {
    expect(await signReviewToken("01HZX3K4R6S7T8V9W0XYZABCDE", "click", {})).toBeNull();
    expect(await verifyReviewToken("01HZX3K4R6S7T8V9W0XYZABCDE.AAAAAAAAAAAAAAAAAAAAAA", "click", {})).toBeNull();
  });
});

describe("the review request email", () => {
  const input = {
    to: "dana@example.test",
    customerName: "Dana Reyes",
    businessName: 'Acme "Best" Plumbing',
    senderAddress: "reviews@mortensenweb.example",
    replyTo: "office@acme.example",
    postalAddress: "12 Main St, Riverton, UT",
    template: { subject: "Would you review {business}?", body: "Hi {first_name},\n\n<b>Thanks</b> for choosing {business}." },
    reviewLink: "https://portal.example/review/TOKEN",
    stopLink: "https://portal.example/review/STOP/stop",
    unsubscribePost: "https://portal.example/review/STOP/unsubscribe",
  };

  it("comes from the business's name at our address, and answers go to the business", () => {
    const email = buildReviewEmail(input);
    expect(email.from).toBe('"Acme Best Plumbing" <reviews@mortensenweb.example>');
    expect(email.replyTo).toBe("office@acme.example");
    expect(email.subject).toBe('Would you review Acme "Best" Plumbing?');
    expect(email.bcc).toBeUndefined();
  });

  it("carries the tracked link, a one-click unsubscribe and the business's address", () => {
    const email = buildReviewEmail(input);
    expect(email.text).toContain("https://portal.example/review/TOKEN");
    expect(email.text).toContain("https://portal.example/review/STOP/stop");
    expect(email.text).toContain("12 Main St, Riverton, UT");
    expect(email.html).toContain('href="https://portal.example/review/TOKEN"');
    expect(email.headers).toEqual({
      "List-Unsubscribe": "<https://portal.example/review/STOP/unsubscribe>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("escapes what the business wrote", () => {
    const email = buildReviewEmail(input);
    expect(email.html).toContain("&lt;b&gt;Thanks&lt;/b&gt;");
    expect(email.html).not.toContain("<b>Thanks</b>");
  });

  it("keeps a header-breaking subject on one line", () => {
    const email = buildReviewEmail({ ...input, template: { ...input.template, subject: "Hi\r\nBcc: x@y.z" } });
    expect(email.subject).not.toMatch(/[\r\n]/);
  });
});

describe("the review request text", () => {
  it("names the business, carries the link and says how to stop", () => {
    const text = buildReviewSms({
      customerName: "Dana Reyes",
      businessName: "Acme Plumbing",
      reviewLink: "https://portal.example/review/TOKEN",
      reminder: false,
    });
    expect(text).toMatch(/^Acme Plumbing: Hi Dana/);
    expect(text).toContain("https://portal.example/review/TOKEN");
    expect(text).toMatch(/Reply STOP to opt out\.$/);
  });
});

describe("sending hours", () => {
  it("sends reminders between 9am and 8pm where the business is", () => {
    // 15:00 UTC is 9:00 in Denver in October (MDT, UTC-6).
    expect(isWithinSendingHours(new Date("2026-10-20T15:00:00Z"), "America/Denver")).toBe(true);
    expect(isWithinSendingHours(new Date("2026-10-20T14:59:00Z"), "America/Denver")).toBe(false);
    expect(isWithinSendingHours(new Date("2026-10-21T01:59:00Z"), "America/Denver")).toBe(true);
    expect(isWithinSendingHours(new Date("2026-10-21T02:00:00Z"), "America/Denver")).toBe(false);
  });
});

describe("the Places API", () => {
  it("is off without a key, and says so rather than guessing", async () => {
    expect(placesConfigured({})).toBe(false);
    const fetch = vi.fn();
    expect(await searchPlaces("Acme Plumbing Riverton", { env: {}, fetch })).toEqual({ ok: false, reason: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("searches by name and town, asking only for the fields it shows", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        places: [
          { id: PLACE, displayName: { text: "Acme Plumbing" }, formattedAddress: "12 Main St, Riverton, UT 84065, USA" },
        ],
      }),
    );
    const result = await searchPlaces("Acme Plumbing Riverton", { env: { GOOGLE_PLACES_API_KEY: "k" }, fetch });
    expect(result).toEqual({
      ok: true,
      places: [{ placeId: PLACE, name: "Acme Plumbing", address: "12 Main St, Riverton, UT 84065, USA" }],
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("k");
    expect(headers["X-Goog-FieldMask"]).toBe("places.id,places.displayName,places.formattedAddress");
    expect(JSON.parse(String(init.body))).toMatchObject({ textQuery: "Acme Plumbing Riverton" });
  });

  it("reads a place's rating and review count", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ id: PLACE, displayName: { text: "Acme Plumbing" }, rating: 4.8, userRatingCount: 112 }),
    );
    expect(await getPlaceSummary(PLACE, { env: { GOOGLE_PLACES_API_KEY: "k" }, fetch })).toEqual({
      ok: true,
      place: { placeId: PLACE, name: "Acme Plumbing", rating: 4.8, reviewCount: 112 },
    });
    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://places.googleapis.com/v1/places/${PLACE}`);
  });

  it("reports a refused or unreachable Places API as a failure, not as no reviews", async () => {
    const refused = vi.fn(async () => new Response("{}", { status: 403 }));
    expect(await getPlaceSummary(PLACE, { env: { GOOGLE_PLACES_API_KEY: "k" }, fetch: refused })).toEqual({
      ok: false,
      reason: "failed",
    });
    const down = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await getPlaceSummary(PLACE, { env: { GOOGLE_PLACES_API_KEY: "k" }, fetch: down })).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});

describe("texting through Twilio", () => {
  const env = {
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "secret",
    TWILIO_FROM_NUMBER: "+18015550000",
  };

  it("is off unless the account, token and a sender are all set", () => {
    expect(smsConfigured({})).toBe(false);
    expect(smsConfigured({ TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "x" })).toBe(false);
    expect(smsConfigured(env)).toBe(true);
    expect(smsConfigured({ TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "x", TWILIO_MESSAGING_SERVICE_SID: "MG1" })).toBe(true);
  });

  it("does not send when it is off", async () => {
    const fetch = vi.fn();
    expect(await sendSms({ to: "+18015550123", body: "hi" }, { env: {}, fetch })).toEqual({ status: "skipped" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the message with the account's credentials", async () => {
    const fetch = vi.fn(async () => Response.json({ sid: "SM1" }, { status: 201 }));
    expect(await sendSms({ to: "+18015550123", body: "hi" }, { env, fetch })).toEqual({ status: "sent", id: "SM1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("AC123:secret")}`);
    const body = new URLSearchParams(String(init.body));
    expect(body.get("To")).toBe("+18015550123");
    expect(body.get("From")).toBe("+18015550000");
  });

  it("recognises a number that replied STOP", async () => {
    const fetch = vi.fn(async () => Response.json({ code: 21610, message: "unsubscribed" }, { status: 400 }));
    expect(await sendSms({ to: "+18015550123", body: "hi" }, { env, fetch })).toEqual({ status: "opted_out" });
  });

  it("reports any other refusal as a failure", async () => {
    const fetch = vi.fn(async () => Response.json({ code: 21211, message: "invalid" }, { status: 400 }));
    expect(await sendSms({ to: "+18015550123", body: "hi" }, { env, fetch })).toEqual({
      status: "failed",
      error: "Twilio responded 400 (21211)",
    });
  });
});

describe("the link rate limiter", () => {
  it("allows a burst up to the limit, then refuses until the window passes", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    const t0 = 1_000_000;
    expect([1, 2, 3].map(() => limiter.allow("1.2.3.4", t0))).toEqual([true, true, true]);
    expect(limiter.allow("1.2.3.4", t0 + 1)).toBe(false);
    expect(limiter.allow("5.6.7.8", t0 + 1)).toBe(true);
    expect(limiter.allow("1.2.3.4", t0 + 60_001)).toBe(true);
  });

  it("does not grow without bound", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 10 });
    for (let i = 0; i < 50; i += 1) limiter.allow(`ip-${i}`, 0);
    expect(limiter.size()).toBeLessThanOrEqual(10);
  });
});
