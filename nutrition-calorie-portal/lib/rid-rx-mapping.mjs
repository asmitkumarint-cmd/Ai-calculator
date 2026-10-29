import { gunzipSync } from "node:zlib";

export function decodeRidClassifierAsset(compressed) {
  const bytes = gunzipSync(compressed);
  if (bytes.length < 5) throw new Error("RID classifier asset is truncated.");
  const count = bytes.readUInt32LE(0);
  const categoryCount = bytes.readUInt8(4);
  const categories = [];
  let offset = 5;
  for (let index = 0; index < categoryCount; index += 1) {
    if (offset >= bytes.length) throw new Error("RID classifier asset category header is truncated.");
    const length = bytes.readUInt8(offset++);
    if (offset + length > bytes.length) throw new Error("RID classifier asset category label is truncated.");
    categories.push(bytes.toString("utf8", offset, offset + length));
    offset += length;
  }
  const recordsOffset = offset;
  if (recordsOffset + count * 5 !== bytes.length) throw new Error("RID classifier asset record count is invalid.");

  return (rid) => {
    const target = Number(rid);
    if (!Number.isSafeInteger(target) || target <= 0 || target > 0xffffffff) return null;
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const entryOffset = recordsOffset + middle * 5;
      const current = bytes.readUInt32LE(entryOffset);
      if (current === target) return categories[bytes.readUInt8(entryOffset + 4)] || null;
      if (current < target) low = middle + 1;
      else high = middle - 1;
    }
    return null;
  };
}
