import { describe, expect, it } from "vitest";
import {
  flagDuplicates,
  MAX_IMPORT_ROWS,
  parseExpenseRows,
  type ParsedExpenseRow,
} from "@/lib/finance/expense-import";

/**
 * Pasting a pile of receipts into the ledger.
 *
 * The rows come from a person copying lines out of Gmail or a spreadsheet, so
 * the parser has to take what people actually paste (tabs or commas, a header
 * or none, "$1,234.56", "10/3/2026") and refuse, row by row with a reason,
 * anything it cannot read. A row it guessed at is worse than a row it refused:
 * the ledger is what goes to the accountant.
 */

function okRows(rows: ParsedExpenseRow[]) {
  return rows.filter((r) => r.ok);
}

describe("parseExpenseRows", () => {
  it("reads comma-separated rows in date, description, category, amount, note order", () => {
    const { rows } = parseExpenseRows(
      "2026-10-03,Netlify Pro,hosting,19.00,October\n2026-10-05,Figma,software,15,",
    );

    expect(rows).toEqual([
      {
        line: 1,
        ok: true,
        occurredOn: "2026-10-03",
        description: "Netlify Pro",
        category: "hosting",
        amountCents: 1900,
        note: "October",
      },
      {
        line: 2,
        ok: true,
        occurredOn: "2026-10-05",
        description: "Figma",
        category: "software",
        amountCents: 1500,
        note: null,
      },
    ]);
  });

  it("reads tab-separated rows pasted from a spreadsheet", () => {
    const { rows } = parseExpenseRows("10/3/2026\tGoogle Workspace\tSoftware\t$7.20\t");
    expect(rows[0]).toMatchObject({
      ok: true,
      occurredOn: "2026-10-03",
      description: "Google Workspace",
      category: "software",
      amountCents: 720,
    });
  });

  it("skips a header row and uses it to find the columns", () => {
    const { rows, hadHeader } = parseExpenseRows(
      "Amount,Date,What,Category\n\"$1,234.56\",2026-09-30,Laptop,equipment",
    );
    expect(hadHeader).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({
        line: 2,
        ok: true,
        amountCents: 123456,
        occurredOn: "2026-09-30",
        description: "Laptop",
        category: "equipment",
      }),
    ]);
  });

  it("handles quoted fields with commas and doubled quotes", () => {
    const { rows } = parseExpenseRows(
      '2026-10-01,"Canva, yearly ""Pro"" plan",software,119.99,"paid by card, ending 4242"',
    );
    expect(rows[0]).toMatchObject({
      ok: true,
      description: 'Canva, yearly "Pro" plan',
      note: "paid by card, ending 4242",
    });
  });

  it("reads the dates Gmail shows, when they are not split by a comma", () => {
    const { rows } = parseExpenseRows("Oct 3, 2026\tStripe Atlas\tother\t500");
    expect(rows[0]).toMatchObject({ ok: true, occurredOn: "2026-10-03" });

    const short = parseExpenseRows("3/9/26,Domain renewal,hosting,12");
    expect(short.rows[0]).toMatchObject({ ok: true, occurredOn: "2026-03-09" });
  });

  it("treats a blank category as other, and matches categories in any case", () => {
    const { rows } = parseExpenseRows("2026-10-01,Coffee with a client,,8.50\n2026-10-01,Ads,MARKETING,40");
    expect(okRows(rows).map((r) => r.ok && r.category)).toEqual(["other", "marketing"]);
  });

  it("ignores blank lines but keeps line numbers true to the paste", () => {
    const { rows } = parseExpenseRows("\n2026-10-01,A,other,1\n\n\n2026-10-02,B,other,2\n");
    expect(rows.map((r) => r.line)).toEqual([2, 5]);
  });

  it("refuses a row it cannot read, saying why, and keeps going", () => {
    const { rows } = parseExpenseRows(
      [
        "2026-02-30,Impossible day,other,5",
        "yesterday,Vague,other,5",
        "2026-10-01,,other,5",
        "2026-10-01,Groceries,food,5",
        "2026-10-01,Refund,other,-5",
        "2026-10-01,Free thing,other,0",
        "2026-10-01,Typo,other,12.345",
        "2026-10-01,Fine,other,5",
      ].join("\n"),
    );

    expect(rows).toHaveLength(8);
    expect(rows.slice(0, 7).every((r) => !r.ok)).toBe(true);
    expect(rows[7]).toMatchObject({ ok: true, description: "Fine" });

    const reasons = rows.map((r) => (r.ok ? "" : r.errors.join(" ")));
    expect(reasons[0]).toMatch(/date/i);
    expect(reasons[1]).toMatch(/date/i);
    expect(reasons[2]).toMatch(/description/i);
    expect(reasons[3]).toMatch(/category/i);
    expect(reasons[3]).toMatch(/software/);
    expect(reasons[4]).toMatch(/amount/i);
    expect(reasons[5]).toMatch(/amount/i);
    expect(reasons[6]).toMatch(/amount/i);
  });

  it("refuses a row with too few columns", () => {
    const { rows } = parseExpenseRows("2026-10-01,Only a description");
    expect(rows[0]).toMatchObject({ ok: false });
  });

  it("refuses a paste longer than the limit as a whole", () => {
    const text = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => "2026-10-01,A,other,1").join("\n");
    expect(() => parseExpenseRows(text)).toThrow(/at most/i);
  });

  it("returns nothing for an empty paste", () => {
    expect(parseExpenseRows("  \n \n").rows).toEqual([]);
  });
});

describe("flagDuplicates", () => {
  const existing = [{ occurredOn: "2026-10-03", amountCents: 1900, description: "Netlify Pro" }];

  it("flags a row already in the ledger: same date, amount and description", () => {
    const { rows } = parseExpenseRows(
      "2026-10-03,netlify  pro ,hosting,19\n2026-10-03,Netlify Pro,hosting,20\n2026-10-04,Netlify Pro,hosting,19",
    );
    const flagged = flagDuplicates(rows, existing);
    expect(flagged.map((r) => r.duplicateOf)).toEqual(["ledger", null, null]);
  });

  it("flags the second copy of a row pasted twice", () => {
    const { rows } = parseExpenseRows("2026-10-05,Figma,software,15\n2026-10-05,Figma,software,15");
    expect(flagDuplicates(rows, []).map((r) => r.duplicateOf)).toEqual([null, "paste"]);
  });

  it("never flags a row that could not be read", () => {
    const { rows } = parseExpenseRows("not a date,Netlify Pro,hosting,19");
    expect(flagDuplicates(rows, existing)[0]!.duplicateOf).toBeNull();
  });
});
