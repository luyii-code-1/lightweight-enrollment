import { z } from "zod";

export function crc32(text: string) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function decodeBase64(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Base64 格式错误");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Base64 格式错误");
  return bytes.toString("utf8");
}

export function decodeRegistrationPacket(input: unknown) {
  const packet = z.object({ payload:z.string().min(4).max(2048),crc32:z.string().regex(/^[0-9a-fA-F]{8}$/) }).parse(input);
  if (crc32(packet.payload) !== packet.crc32.toLowerCase()) throw new Error("CRC 校验失败，请重新提交");
  const data = z.object({timestamp:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),courseId:z.string().regex(/^\d+$/),userId:z.string().min(4).max(128)}).strict().parse(JSON.parse(decodeBase64(packet.payload)));
  return {...data,identity:decodeBase64(data.userId)};
}
