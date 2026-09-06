import { describe, expect, it } from "vitest";
import { csv, csvCell, randomPassword } from "./utils.js";

describe("CSV export", () => {
  it("escapes quotes and blocks spreadsheet formulas", () => {
    expect(csvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
  });

  it("writes UTF-8 BOM and CRLF rows", () => {
    expect(csv([["学号", "姓名"], ["1", "张三"]])).toBe("\uFEFF\"学号\",\"姓名\"\r\n\"1\",\"张三\"\r\n");
  });
});

describe("initial passwords", () => {
  it("generates non-ambiguous 12-character values", () => {
    const values = new Set(Array.from({ length: 50 }, randomPassword));
    expect(values.size).toBe(50);
    for (const value of values) expect(value).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
  });
});

