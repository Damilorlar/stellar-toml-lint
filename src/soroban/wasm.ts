/**
 * A pure-TypeScript WebAssembly *binary* parser, sized for one job: pulling
 * custom sections (section code 0) out of compiled Soroban contract WASM.
 *
 * Soroban embeds its interface metadata — `contractspecv0`,
 * `contractenvmetav0`, `contractmetav0` — in exactly those custom sections, so
 * a linter can read a contract's declared interface without instantiating the
 * module or pulling in a WASM runtime. There is no native compilation
 * dependency anywhere in this file: the whole format is a magic number, a
 * little-endian version, and a sequence of LEB128-length-prefixed sections.
 *
 * Every structural failure throws {@link WasmParseError} naming the byte
 * offset, because "your contract binary is corrupted" is only actionable if
 * the report says where to look.
 */

/** One custom section: its name and the raw payload that follows the name. */
export interface WasmCustomSection {
  name: string;
  payload: Uint8Array;
}

/** Thrown when a WASM binary is structurally invalid; carries the offset. */
export class WasmParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`Invalid WASM binary at byte ${offset}: ${message}`);
    this.name = 'WasmParseError';
    this.offset = offset;
  }
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d]; // \0asm
const VERSION_SIZE = 4;
const SECTION_ID_CUSTOM = 0;

/** Reads an unsigned LEB128 integer, rejecting encodings past 32 bits. */
function readLeb128(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    if (at >= bytes.length) {
      throw new WasmParseError('file ends inside a length prefix', offset);
    }
    const byte = bytes[at] as number;
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) {
      throw new WasmParseError('length prefix is longer than 32 bits', offset);
    }
  }
  return { value, next: at };
}

function decodeName(bytes: Uint8Array, offset: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WasmParseError('section name is not valid UTF-8', offset);
  }
}

/**
 * Extracts every custom section (id 0) from a WASM binary, in file order.
 *
 * Non-custom sections are skipped by their declared size — the parser never
 * needs to understand types, functions, or code to find the metadata Soroban
 * embeds, and refusing to guess keeps corrupted-but-lucky binaries from being
 * read differently by different tools.
 */
export function extractCustomSections(wasm: Uint8Array): WasmCustomSection[] {
  if (wasm.length < MAGIC.length + VERSION_SIZE) {
    throw new WasmParseError(
      `file is ${wasm.length} byte(s), too short to hold the 8-byte header`,
      0,
    );
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (wasm[i] !== MAGIC[i]) {
      throw new WasmParseError(
        `magic number is ${[...wasm.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}, expected 00 61 73 6d (\\0asm)`,
        0,
      );
    }
  }

  const sections: WasmCustomSection[] = [];
  let offset = MAGIC.length + VERSION_SIZE;

  while (offset < wasm.length) {
    const id = wasm[offset] as number;
    const bodyStart = offset + 1;
    const size = readLeb128(wasm, bodyStart);
    const payloadStart = size.next;
    const payloadEnd = payloadStart + size.value;

    if (payloadEnd > wasm.length) {
      throw new WasmParseError(
        `section of ${size.value} byte(s) extends ${payloadEnd - wasm.length} byte(s) past the end of the file`,
        offset,
      );
    }

    if (id === SECTION_ID_CUSTOM) {
      const nameLen = readLeb128(wasm, payloadStart);
      const nameEnd = nameLen.next + nameLen.value;
      if (nameEnd > payloadEnd) {
        throw new WasmParseError(
          `custom section name (${nameLen.value} byte(s)) exceeds its ${size.value}-byte section`,
          payloadStart,
        );
      }
      sections.push({
        name: decodeName(wasm.subarray(nameLen.next, nameEnd), nameLen.next),
        payload: wasm.subarray(nameEnd, payloadEnd),
      });
    }

    offset = payloadEnd;
  }

  return sections;
}

/** Returns the named custom section's payload, or `undefined` when absent. */
export function customSectionPayload(
  sections: WasmCustomSection[],
  name: string,
): Uint8Array | undefined {
  return sections.find((section) => section.name === name)?.payload;
}
