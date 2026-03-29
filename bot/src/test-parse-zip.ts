/**
 * Quick test: verify GdtXmlParser.parseLineItems handles ZIP format + DLHDon wrapper
 * Usage: npx ts-node src/test-parse-zip.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { GdtXmlParser } from './parsers/GdtXmlParser';

const zipPath = path.resolve(__dirname, '..', 'test-output', 'invoice-36.xml');
const buf = fs.readFileSync(zipPath);

console.log(`Loaded file: ${zipPath} (${buf.length} bytes, starts with ${buf.slice(0,4).toString('hex')})`);
console.log(`ZIP magic check: ${buf.readUInt32LE(0) === 0x04034b50 ? 'YES PK\\x03\\x04' : 'NOT A ZIP'}`);

// Manual ZIP scan
let offset = 0;
let foundCount = 0;
while (offset + 30 <= buf.length) {
  const sig = buf.readUInt32LE(offset);
  if (sig !== 0x04034b50) {
    console.log(`End of local headers at offset ${offset}, sig=0x${sig.toString(16)}`);
    break;
  }
  const method = buf.readUInt16LE(offset + 8);
  const csize  = buf.readUInt32LE(offset + 18);
  const usize  = buf.readUInt32LE(offset + 22);
  const fnLen  = buf.readUInt16LE(offset + 26);
  const exLen  = buf.readUInt16LE(offset + 28);
  const fname  = buf.slice(offset + 30, offset + 30 + fnLen).toString('utf-8');
  const dataStart = offset + 30 + fnLen + exLen;
  
  console.log(`  Entry: "${fname}" method=${method} csize=${csize} usize=${usize} dataStart=${dataStart}`);
  
  if (fname === 'invoice.xml') {
    const compressed = buf.slice(dataStart, dataStart + csize);
    console.log(`  → Extracting invoice.xml, compressed=${compressed.length} bytes`);
    if (method === 0) {
      console.log(`  → STORED, raw: ${compressed.slice(0, 100).toString('utf-8')}`);
    } else if (method === 8) {
      try {
        const decompressed = zlib.inflateRawSync(compressed);
        console.log(`  → DEFLATED OK: ${decompressed.length} bytes`);
        console.log(`  → Start: ${decompressed.slice(0, 200).toString('utf-8')}`);
      } catch (e) {
        console.log(`  → inflateRawSync FAILED: ${e}`);
        // Try zlib inflate (with header)
        try {
          const decompressed2 = zlib.inflateSync(compressed);
          console.log(`  → inflateSync OK: ${decompressed2.length} bytes`);
          console.log(`  → Start: ${decompressed2.slice(0, 200).toString('utf-8')}`);
        } catch (e2) {
          console.log(`  → inflateSync also FAILED: ${e2}`);
        }
      }
    }
  }
  
  foundCount++;
  offset = dataStart + csize;
}
console.log(`Total entries scanned: ${foundCount}`);

console.log('\n=== Parser test ===');
const parser = new GdtXmlParser();
const items = parser.parseLineItems(buf);
console.log(`Line items found: ${items.length}`);
items.forEach((item, i) => {
  console.log(`  [${i+1}] ${item.item_name} | qty=${item.quantity} | price=${item.unit_price} | total=${item.total}`);
});
