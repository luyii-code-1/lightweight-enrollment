import { createHmac, timingSafeEqual } from "node:crypto";

function decodeBase32(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  if (!/^[A-Z2-7]+$/.test(secret) || ![0, 2, 4, 5, 7].includes(secret.length % 8)) {
    throw new Error("Invalid TOTP secret encoding");
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new Error("Invalid TOTP secret padding");
  return Buffer.from(bytes);
}

export function totpCode(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest.readUInt8(digest.length - 1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const currentStep = Math.floor(nowMs / 30_000);
  for (const offset of [0, -1, 1]) {
    const step = currentStep + offset;
    if (step >= 0 && timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}
