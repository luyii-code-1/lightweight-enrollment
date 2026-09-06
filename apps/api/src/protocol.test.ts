import { describe,it,expect } from "vitest";
import { crc32,decodeBase64,decodeRegistrationPacket } from "./protocol.js";

describe("registration packet",()=>{
  it("uses CRC-32/ISO-HDLC test vectors",()=>{
    expect(crc32("123456789")).toBe("cbf43926");expect(crc32("")).toBe("00000000");
  });
  it("decodes nested identity without losing leading zeroes or X",()=>{
    const identity="00000020000101000X";
    const payload=Buffer.from(JSON.stringify({timestamp:1800000000001,courseId:"2",userId:Buffer.from(identity).toString("base64")})).toString("base64");
    expect(decodeRegistrationPacket({payload,crc32:crc32(payload)})).toMatchObject({identity,timestamp:1800000000001,courseId:"2"});
    expect(()=>decodeRegistrationPacket({payload,crc32:"00000000"})).toThrow("CRC");
    expect(()=>decodeBase64("not base64")).toThrow();
    expect(()=>decodeBase64("AB==")).toThrow();
  });
});
