export function crc32(text: string) {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function registrationPacket(identity:string,courseId:string,timestamp:number) {
  const payload = btoa(JSON.stringify({timestamp,courseId,userId:btoa(identity)}));
  return {payload,crc32:crc32(payload)};
}
