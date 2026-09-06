import { randomBytes } from "node:crypto";

export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csv(rows: unknown[][]) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(12);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

