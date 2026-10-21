import { describe, expect, it } from "vitest";
import { guessMapping, mapRows, parseCsv, MAX_IMPORT_ROWS } from "@/lib/winback/csv";

/**
 * Importing past customers from a spreadsheet.
 *
 * What would go wrong quietly: a quoted comma splitting a name into two
 * columns; the same person imported twice under different capitalisation; a
 * row with no usable address imported as a customer we can never reach; and a
 * spreadsheet's own "Email" column not being found because it is called
 * "E-mail Address".
 */

describe("parseCsv", () => {
  it("reads quoted fields, escaped quotes and CRLF line endings", () => {
    const parsed = parseCsv('Name,Email,Notes\r\n"Reyes, Dana",dana@example.test,"Said ""call first"""\r\n');
    expect(parsed.headers).toEqual(["Name", "Email", "Notes"]);
    expect(parsed.rows).toEqual([["Reyes, Dana", "dana@example.test", 'Said "call first"']]);
  });

  it("keeps a line break inside quotes as part of the field", () => {
    const parsed = parseCsv('Name,Notes\n"Dana","Line one\nLine two"\n');
    expect(parsed.rows[0]![1]).toBe("Line one\nLine two");
  });

  it("drops a byte-order mark and blank lines", () => {
    const parsed = parseCsv("﻿Email\n\na@example.test\n\n");
    expect(parsed.headers).toEqual(["Email"]);
    expect(parsed.rows).toEqual([["a@example.test"]]);
  });

  it("reads semicolon-separated exports", () => {
    const parsed = parseCsv("Name;Email\nDana;dana@example.test\n");
    expect(parsed.headers).toEqual(["Name", "Email"]);
    expect(parsed.rows[0]).toEqual(["Dana", "dana@example.test"]);
  });

  it("refuses a file with more rows than one import takes", () => {
    const big = ["Email", ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `c${i}@example.test`)].join("\n");
    expect(() => parseCsv(big)).toThrow(/at most/);
  });
});

describe("guessMapping", () => {
  it("finds the columns spreadsheets usually call them", () => {
    expect(guessMapping(["Customer Name", "E-mail Address", "Last Service Date", "Job notes"])).toEqual({
      email: 1,
      name: 0,
      firstName: null,
      lastName: null,
      lastJob: 2,
      note: 3,
    });
    expect(guessMapping(["First name", "Last name", "Email"])).toMatchObject({
      email: 2,
      firstName: 0,
      lastName: 1,
      name: null,
    });
  });

  it("leaves a column unmapped rather than guessing", () => {
    expect(guessMapping(["Col A", "Col B"])).toMatchObject({ email: null, name: null });
  });
});

describe("mapRows", () => {
  const headers = ["Name", "Email", "Last job", "Notes"];
  const mapping = { email: 1, name: 0, firstName: null, lastName: null, lastJob: 2, note: 3 };

  it("lowercases addresses and drops duplicates within the file", () => {
    const result = mapRows(
      { headers, rows: [["Dana", "Dana@Example.test ", "", ""], ["Dana R", "dana@example.test", "", ""]] },
      mapping,
    );
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]!.email).toBe("dana@example.test");
    expect(result.skipped).toEqual([{ row: 3, reason: "duplicate" }]);
  });

  it("skips a row without a usable address, and says which row", () => {
    const result = mapRows({ headers, rows: [["Dana", "not an email", "", ""], ["Sam", "", "", ""]] }, mapping);
    expect(result.contacts).toHaveLength(0);
    expect(result.skipped).toEqual([
      { row: 2, reason: "no_email" },
      { row: 3, reason: "no_email" },
    ]);
  });

  it("joins first and last name columns", () => {
    const result = mapRows(
      { headers: ["First", "Last", "Email"], rows: [["Dana", "Reyes", "dana@example.test"]] },
      { email: 2, name: null, firstName: 0, lastName: 1, lastJob: null, note: null },
    );
    expect(result.contacts[0]!.name).toBe("Dana Reyes");
  });

  it("reads the last-job date in the usual formats, and ignores one it cannot read", () => {
    const rows = [
      ["A", "a@example.test", "2025-11-03", ""],
      ["B", "b@example.test", "11/3/2025", ""],
      ["C", "c@example.test", "sometime last fall", ""],
    ];
    const result = mapRows({ headers, rows }, mapping);
    expect(result.contacts.map((c) => c.lastJobOn)).toEqual(["2025-11-03", "2025-11-03", null]);
  });

  it("keeps a short note of the job from the mapped column", () => {
    const result = mapRows({ headers, rows: [["Dana", "dana@example.test", "", "Furnace install"]] }, mapping);
    expect(result.contacts[0]!.note).toBe("Furnace install");
  });

  it("refuses a mapping without an email column", () => {
    expect(() => mapRows({ headers, rows: [] }, { ...mapping, email: null })).toThrow(/email/i);
  });
});
