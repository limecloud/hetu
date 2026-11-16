import { deflateSync, crc32 } from "node:zlib";

export function sampleImage(width = 120, height = 180) {
  const chunk = (type: string, bytes: Buffer) => {
    const value = Buffer.alloc(12 + bytes.length);
    value.writeUInt32BE(bytes.length);
    value.write(type, 4);
    bytes.copy(value, 8);
    value.writeUInt32BE(
      crc32(value.subarray(4, 8 + bytes.length)),
      8 + bytes.length,
    );
    return value;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3 + 1,
    pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 3;
      pixels[offset] = (80 + x) % 256;
      pixels[offset + 1] = (80 + y) % 256;
      pixels[offset + 2] = 160;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function sampleAudio() {
  const rate = 44100,
    samples = rate * 4,
    bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin((i * 440 * 2 * Math.PI) / rate) * 1500),
      44 + i * 2,
    );
  return bytes;
}
