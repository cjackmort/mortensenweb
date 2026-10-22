import type { BusinessDetails } from "@/lib/business-profile";

/**
 * The win-back emails the portal proposes: one per season or occasion that
 * fits the trade, written from General information and nothing else.
 *
 * The rule every template here is held to: **say nothing about the business
 * that the profile did not say.** No year founded, no review count, no
 * licence, no discount. The opening paragraph is about the customer's season
 * (cold weather is coming), never about the business's record; the business
 * appears only as its name, its phone, its booking link, and one of its own
 * listed services. An offer is the client's to write — a draft never invents
 * one, because an approved email quoting a price is a promise.
 *
 * Templates are plain code rather than a model call: the same profile always
 * gives the same draft, a test can hold every one of them to the rule, and
 * there is nothing to configure or pay for.
 */

export type BusinessType =
  | "hvac"
  | "plumbing"
  | "cleaning"
  | "landscaping"
  | "pest"
  | "roofing"
  | "auto"
  | "beauty"
  | "pets"
  | "photography"
  | "lessons"
  | "general";

/** Checked in order: the first trade with a matching word wins. */
const TRADE_WORDS: Array<[BusinessType, RegExp]> = [
  ["hvac", /\b(hvac|heating|furnace|air[- ]condition\w*|a\/c|cooling|heat pump)\b/i],
  ["plumbing", /\b(plumb\w*|water heater|drain\w*|sewer)\b/i],
  ["pest", /\b(pest|extermina\w*|termite\w*|rodent\w*)\b/i],
  ["roofing", /\b(roof\w*|gutter\w*)\b/i],
  ["cleaning", /\b(carpet\w*|upholster\w*|clean\w*|maid\w*|janitorial|window washing)\b/i],
  ["landscaping", /\b(landscap\w*|lawn\w*|yard\w*|sprinkler\w*|irrigation|tree service|snow removal)\b/i],
  ["auto", /\b(detail\w*|auto\w*|car wash|mechanic\w*|tires?)\b/i],
  ["beauty", /\b(salon|hair\w*|barber\w*|nails?|spa|lash\w*|brow\w*|esthetic\w*|massage)\b/i],
  ["pets", /\b(pet|pets|dog\w*|groom\w*|kennel\w*|boarding)\b/i],
  ["photography", /\b(photo\w*)\b/i],
  ["lessons", /\b(dance|studio|lessons?|fitness|gym|yoga|cheer\w*|tutor\w*|martial arts|music school)\b/i],
];

export function businessTypeOf(input: {
  industry: string | null | undefined;
  details: BusinessDetails | null | undefined;
}): BusinessType {
  const d = input.details ?? {};
  // The operator's label first: it was chosen on purpose. Then what the
  // business says about itself.
  const sources = [input.industry ?? "", [d.tagline, d.services, d.about, d.businessName].filter(Boolean).join("\n")];
  for (const text of sources) {
    if (!text) continue;
    const hit = TRADE_WORDS.find(([, words]) => words.test(text));
    if (hit) return hit[0];
  }
  return "general";
}

export interface Occasion {
  key: string;
  /** For every trade when absent. */
  types?: BusinessType[];
  /** Months it is offered in, 1-12. Absent: all year. */
  months?: number[];
  /** What the client sees on the suggestion card. */
  label: string;
  /** One line on the card: why now. */
  why: string;
  subject: string;
  /** The season, from the customer's side. No facts about the business. */
  opening: string;
  /**
   * Words that find the matching service in the profile's list. Only this
   * occasion's own topic: a generic word like "tune-up" would put a furnace
   * service into an A/C email.
   */
  serviceWords?: RegExp;
  /** "the furnace" — what the call to action is about when no service matches. */
  topic: string;
}

export const OCCASIONS: readonly Occasion[] = [
  {
    key: "hvac-furnace",
    types: ["hvac"],
    months: [8, 9, 10, 11],
    label: "Furnace check before winter",
    why: "The first cold night is when furnaces that weren't checked stop working.",
    subject: "Is your furnace ready for the first cold night?",
    opening:
      "Cold weather is on the way. A furnace that hasn't been looked at since last winter is the one most likely to quit on the first cold night, when everyone is calling for help at once.",
    serviceWords: /furnace|heating|heat pump/i,
    topic: "your furnace",
  },
  {
    key: "hvac-ac",
    types: ["hvac"],
    months: [3, 4, 5, 6],
    label: "A/C tune-up before the heat",
    why: "Booking before the first hot week beats waiting behind every breakdown call.",
    subject: "Get your A/C checked before the first hot week",
    opening:
      "Summer is coming. Air conditioners that sat all winter tend to show their problems in the first hot week, when everyone needs a repair at the same time.",
    serviceWords: /a\/c|air[- ]?condition|cooling/i,
    topic: "your A/C",
  },
  {
    key: "plumbing-freeze",
    types: ["plumbing"],
    months: [9, 10, 11, 12],
    label: "Before the freeze",
    why: "Frozen pipes and tired water heaters are winter's most common emergencies.",
    subject: "A quick plumbing check before it freezes",
    opening:
      "Freezing nights are coming. Outdoor taps, exposed pipes and an older water heater are the usual winter emergencies, and they are much cheaper to deal with before they fail.",
    serviceWords: /water heater|winteriz|inspection|pipe/i,
    topic: "your plumbing",
  },
  {
    key: "plumbing-spring",
    types: ["plumbing"],
    months: [3, 4, 5],
    label: "Spring plumbing check",
    why: "Winter leaves leaks and slow drains behind.",
    subject: "Anything leaking after winter?",
    opening:
      "Winter is over, and it often leaves something behind: a slow drain, a drip under the sink, an outdoor tap that doesn't shut off properly.",
    serviceWords: /drain|leak|inspection|water heater/i,
    topic: "your plumbing",
  },
  {
    key: "cleaning-holidays",
    types: ["cleaning"],
    months: [10, 11, 12],
    label: "Clean before the holidays",
    why: "Holiday guests are the most common reason people book a clean.",
    subject: "Guests coming for the holidays?",
    opening:
      "The holidays are close. If you have family or friends coming over, now is a good time to get the house ready, before the calendar fills up.",
    serviceWords: /carpet|clean|upholster/i,
    topic: "a clean",
  },
  {
    key: "cleaning-spring",
    types: ["cleaning"],
    months: [3, 4, 5],
    label: "Spring clean",
    why: "Winter's mud and salt end up in carpets and floors.",
    subject: "Time for a spring clean?",
    opening:
      "Winter tracks a lot into a house: mud, salt and everything else that comes in on boots. Spring is the time most people get it cleaned out.",
    serviceWords: /carpet|clean|upholster/i,
    topic: "a spring clean",
  },
  {
    key: "landscaping-spring",
    types: ["landscaping"],
    months: [2, 3, 4],
    label: "Spring start-up",
    why: "Spring schedules fill early.",
    subject: "Getting your yard ready for spring",
    opening:
      "Spring is nearly here. Sprinklers need starting up, beds need clearing, and the schedule fills up quickly once the weather turns.",
    serviceWords: /spring|start-?up|sprinkler|mow|lawn|aerat/i,
    topic: "your yard",
  },
  {
    key: "landscaping-fall",
    types: ["landscaping"],
    months: [9, 10, 11],
    label: "Fall clean-up and winterizing",
    why: "Sprinklers left full can crack in the first freeze.",
    subject: "Before the first freeze: your yard and sprinklers",
    opening:
      "The first freeze is coming. Sprinkler lines left full of water can crack, and leaves left on the lawn over winter make for a patchy spring.",
    serviceWords: /fall|winteriz|blow-?out|leaf|leaves/i,
    topic: "your yard",
  },
  {
    key: "pest-spring",
    types: ["pest"],
    months: [3, 4, 5],
    label: "Spring pest prevention",
    why: "Insects are most active as the weather warms.",
    subject: "Stop the bugs before they move in",
    opening:
      "As it warms up, ants, spiders and wasps start looking for a way in. Treating early in the season is easier than dealing with them once they are settled.",
    serviceWords: /spray|treat|prevent|quarter|general/i,
    topic: "pest prevention",
  },
  {
    key: "pest-fall",
    types: ["pest"],
    months: [9, 10, 11],
    label: "Keep mice out this winter",
    why: "Rodents move indoors when it gets cold.",
    subject: "Keep mice out this winter",
    opening:
      "When the nights get cold, mice and other rodents start looking for somewhere warm. Sealing up and treating before they get in is far easier than afterwards.",
    serviceWords: /rodent|mice|mouse|exclusion|treat/i,
    topic: "rodent prevention",
  },
  {
    key: "roofing-fall",
    types: ["roofing"],
    months: [9, 10, 11],
    label: "Roof and gutters before winter",
    why: "Snow and ice find every weak spot.",
    subject: "Is your roof ready for snow?",
    opening:
      "Snow and ice are coming. Blocked gutters and loose shingles are what turn a heavy storm into a leak, and they are much easier to deal with before the weather turns.",
    serviceWords: /gutter|inspect|repair|roof/i,
    topic: "your roof",
  },
  {
    key: "roofing-spring",
    types: ["roofing"],
    months: [3, 4, 5],
    label: "Spring roof check",
    why: "Winter damage is easiest to fix before the spring rain.",
    subject: "Did winter leave anything on your roof?",
    opening:
      "Winter is hard on a roof. A missing shingle or a bent gutter is a small fix now and a bigger one after the spring rain finds it.",
    serviceWords: /gutter|inspect|repair|roof/i,
    topic: "your roof",
  },
  {
    key: "auto-winter",
    types: ["auto"],
    months: [10, 11, 12],
    label: "Ready for winter driving",
    why: "Salt and slush are hard on a car.",
    subject: "Get your car ready for winter",
    opening:
      "Winter roads mean salt, slush and cold starts. A little care before it starts saves a lot of wear by spring.",
    serviceWords: /detail|wax|ceramic|winter|tire|oil|protect/i,
    topic: "your car",
  },
  {
    key: "auto-spring",
    types: ["auto"],
    months: [3, 4, 5],
    label: "Spring clean for your car",
    why: "Winter salt keeps working until it's washed off.",
    subject: "Time to get the winter off your car",
    opening:
      "Winter salt keeps working on paint and metal until it is washed off. Spring is the time to get it cleaned up properly.",
    serviceWords: /detail|wash|clean|interior|exterior/i,
    topic: "your car",
  },
  {
    key: "beauty-holidays",
    types: ["beauty"],
    months: [10, 11, 12],
    label: "Booked for the holidays",
    why: "Holiday appointments go fast.",
    subject: "Holiday appointments are filling up",
    opening:
      "Holiday parties and family photos are coming up, and so is the busiest time of year for appointments.",
    topic: "an appointment",
  },
  {
    key: "pets-holidays",
    types: ["pets"],
    months: [10, 11, 12],
    label: "Holiday grooming",
    why: "Holiday spots go fast.",
    subject: "Holiday grooming spots are filling up",
    opening:
      "The holidays are coming, and so are the visitors. If your pet is due for a groom, the weeks before are the busiest of the year.",
    serviceWords: /groom|bath|trim/i,
    topic: "a grooming appointment",
  },
  {
    key: "pets-spring",
    types: ["pets"],
    months: [3, 4, 5],
    label: "Spring shedding",
    why: "Winter coats come out in spring.",
    subject: "Shedding season is here",
    opening:
      "Winter coats are coming out, usually all over the couch. A good groom in spring makes the shedding season a lot easier.",
    serviceWords: /groom|bath|deshed|brush/i,
    topic: "a grooming appointment",
  },
  {
    key: "photography-holidays",
    types: ["photography"],
    months: [8, 9, 10],
    label: "Photos before the holidays",
    why: "Holiday cards need photos taken in the fall.",
    subject: "Family photos in time for the holidays",
    opening:
      "If you want new photos for holiday cards or gifts, the fall is the time to take them, while the light is good and before the calendar fills.",
    serviceWords: /family|portrait|session|mini/i,
    topic: "a session",
  },
  {
    key: "lessons-new-season",
    types: ["lessons"],
    months: [6, 7, 8],
    label: "New season sign-ups",
    why: "Families plan the year's classes over the summer.",
    subject: "Sign-ups for the new season",
    opening:
      "A new season is coming up. Families are planning their schedules now, and classes fill up before it starts.",
    serviceWords: /class|lesson|program|team|session/i,
    topic: "the new season",
  },
  {
    key: "lessons-new-year",
    types: ["lessons"],
    months: [12, 1],
    label: "New year, new classes",
    why: "January is when people start something new.",
    subject: "Start the new year with us",
    opening:
      "A new year is a good time to start something, or get back to it. If you've been meaning to come back, now is an easy time to start.",
    serviceWords: /class|lesson|program|session/i,
    topic: "classes",
  },
  {
    key: "general-holidays",
    types: ["general", "beauty", "photography", "lessons"],
    months: [11, 12],
    label: "Thanks for this year",
    why: "A simple thank-you keeps you in mind for next year.",
    subject: "Thank you for this year",
    opening:
      "As the year winds down, we wanted to say thank you for choosing us. It means a lot to a local business.",
    topic: "anything",
  },
  {
    key: "general-spring",
    types: ["general"],
    months: [3, 4],
    label: "Spring check-in",
    why: "Spring is when people plan the work they put off over winter.",
    subject: "Planning anything this spring?",
    opening:
      "Spring is when a lot of people get to the things they put off over the winter.",
    topic: "anything",
  },
  {
    key: "check-in",
    label: "It's been a while",
    why: "A friendly note to customers you haven't seen lately. Works any time of year.",
    subject: "It's been a while",
    opening: "It's been a while since we last saw you, and we wanted to check in.",
    topic: "anything",
  },
];

function monthOf(when: Date): number {
  return when.getUTCMonth() + 1;
}

/** In season, for this trade, most specific first; the all-year one last. */
export function suggestOccasions(type: BusinessType, when: Date): Occasion[] {
  const month = monthOf(when);
  const fits = OCCASIONS.filter(
    (o) => (!o.types || o.types.includes(type)) && (!o.months || o.months.includes(month)),
  );
  return [...fits.filter((o) => o.types), ...fits.filter((o) => !o.types)];
}

export interface DraftText {
  subject: string;
  body: string;
  /** Always null: the offer is the client's to write. */
  offer: null;
}

/** The first service on their list that fits the occasion, without its price. */
function matchingService(occasion: Occasion, services: string | undefined): string | null {
  if (!occasion.serviceWords || !services) return null;
  for (const line of services.split("\n")) {
    const name = line.replace(/\s+[-–—]\s+.*$/, "").trim();
    if (name && name.length <= 60 && occasion.serviceWords.test(name)) return name;
  }
  return null;
}

/** "Furnace tune-up" reads as "furnace tune-up" mid-sentence; "A/C repair" stays. */
function inSentence(service: string): string {
  return /^[A-Z][a-z]/.test(service) ? service[0]!.toLowerCase() + service.slice(1) : service;
}

/**
 * The draft for one occasion. `{first_name}` is filled in per customer when
 * it is sent; everything else is final text the client can edit.
 */
export function composeDraft(occasion: Occasion, details: BusinessDetails): DraftText {
  const name = details.businessName?.trim();
  const phone = details.phone?.trim();
  const booking = details.bookingUrl?.trim();
  const service = matchingService(occasion, details.services);

  const ask =
    occasion.topic === "anything"
      ? "If there's anything we can help with, we'd be glad to hear from you."
      : `If you'd like us to take care of ${occasion.topic}, we'd be glad to.${service ? ` Ask about our ${inSentence(service)}.` : ""}`;

  const reach = booking
    ? phone
      ? `You can book a time at ${booking}, or call us at ${phone}.`
      : `You can book a time at ${booking}.`
    : phone
      ? `Give us a call at ${phone}, or just reply to this email.`
      : "Just reply to this email and we'll get back to you.";

  const body = [
    "Hi {first_name},",
    "",
    occasion.opening,
    "",
    `${ask} ${reach}`,
    "",
    "Thanks again,",
    ...(name ? [name] : []),
  ].join("\n");

  return { subject: occasion.subject, body, offer: null };
}
