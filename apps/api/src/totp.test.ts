import { describe, expect, it } from "vitest";
import { totpCode, verifyTotp } from "./totp.js";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP", () => {
  it.each([
    [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
    [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]
  ])("matches the six-digit RFC 6238 SHA-1 vector at %s seconds", (seconds, code) => {
    expect(totpCode(secret, Math.floor(Number(seconds) / 30))).toBe(code);
  });

  it("accepts one adjacent time step, rejecting expired and malformed codes", () => {
    const now = 1234567890000;
    const step = Math.floor(now / 30000);
    for (const offset of [-1, 0, 1]) expect(verifyTotp(secret, totpCode(secret, step + offset), now)).toBe(step + offset);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
    for (const code of ["", "12345", "1234567", "abcdef"]) expect(verifyTotp(secret, code, now)).toBeNull();
  });

  it("rejects noncanonical Base32 secrets", () => {
    expect(() => totpCode("AH", 1)).toThrow("padding");
    expect(() => totpCode("A0", 1)).toThrow("encoding");
  });
});
