/**
 * A minimal CBOR (RFC 8949) decoder, pure TypeScript, no dependencies.
 *
 * Soroban embeds its contract metadata in WASM custom sections as CBOR. The
 * payloads the network actually produces are small — arrays of base64-encoded
 * XDR strings, or maps of strings — but the decoder covers every major type
 * (including indefinite-length forms and half-precision floats) so a hostile
 * or merely unusual binary produces a controlled error rather than garbage.
 *
 * Decoding is total: anything unparseable throws {@link CborDecodeError} with
 * the byte offset where the parser gave up, so callers can report exactly
 * where a corrupted metadata section went wrong.
 */

/** Every value CBOR can produce, flattened to JSON-friendly shapes. */
export type CborValue =
  | bigint
  | Uint8Array
  | string
  | CborValue[]
  | Map<CborValue, CborValue>
  | boolean
  | null
  | undefined
  | number;

/** Thrown when a CBOR payload is malformed; carries the failing offset. */
export class CborDecodeError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`Malformed CBOR at byte ${offset}: ${message}`);
    this.name = 'CborDecodeError';
    this.offset = offset;
  }
}

interface Cursor {
  bytes: Uint8Array;
  offset: number;
}

function need(cursor: Cursor, count: number): void {
  if (cursor.offset + count > cursor.bytes.length) {
    throw new CborDecodeError(
      `payload ends after ${cursor.bytes.length} byte(s), expected ${count} more`,
      cursor.offset,
    );
  }
}

function readByte(cursor: Cursor): number {
  need(cursor, 1);
  const byte = cursor.bytes[cursor.offset] as number;
  cursor.offset += 1;
  return byte;
}

/** Reads an unsigned LEB128-style argument, per RFC 8949 §3.1. */
function readArgument(cursor: Cursor, ai: number, initialOffset: number): number | bigint {
  if (ai < 24) return ai;
  if (ai === 24) return readByte(cursor);
  if (ai === 25) {
    need(cursor, 2);
    const value =
      ((cursor.bytes[cursor.offset] as number) << 8) | (cursor.bytes[cursor.offset + 1] as number);
    cursor.offset += 2;
    return value;
  }
  if (ai === 26) {
    need(cursor, 4);
    let value = 0;
    for (let i = 0; i < 4; i++) value = value * 256 + readByte(cursor);
    return value;
  }
  if (ai === 27) {
    need(cursor, 8);
    let value = 0n;
    for (let i = 0; i < 8; i++) value = value * 256n + BigInt(readByte(cursor));
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }
  if (ai === 31) return INDEFINITE;
  throw new CborDecodeError(`reserved additional-information ${ai}`, initialOffset);
}

/** Marker returned by {@link readArgument} for indefinite-length items. */
const INDEFINITE = -1;

function readHalf(cursor: Cursor): number {
  const raw =
    ((cursor.bytes[cursor.offset] as number) << 8) | (cursor.bytes[cursor.offset + 1] as number);
  cursor.offset += 2;
  const exponent = (raw >> 10) & 0x1f;
  const mantissa = raw & 0x03ff;
  const sign = raw & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

function readFloat(cursor: Cursor, width: 2 | 4 | 8): number {
  need(cursor, width);
  if (width === 2) return readHalf(cursor);
  const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.offset, width);
  cursor.offset += width;
  if (width === 4) return view.getFloat32(0, false);
  return view.getFloat64(0, false);
}

function readString(cursor: Cursor, length: number | bigint, initialOffset: number): string {
  const size = typeof length === 'bigint' ? Number(length) : length;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new CborDecodeError(`string length ${length} is not representable`, initialOffset);
  }
  need(cursor, size);
  const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + size);
  cursor.offset += size;
  // A lone continuation byte inside a "UTF-8" string means the encoder lied;
  // TextDecoder reports that instead of silently producing U+FFFD runs.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return decoder.decode(slice);
  } catch {
    throw new CborDecodeError('text string is not valid UTF-8', initialOffset);
  }
}

function readBytes(cursor: Cursor, length: number | bigint, initialOffset: number): Uint8Array {
  const size = typeof length === 'bigint' ? Number(length) : length;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new CborDecodeError(`byte-string length ${length} is not representable`, initialOffset);
  }
  need(cursor, size);
  const slice = cursor.bytes.slice(cursor.offset, cursor.offset + size);
  cursor.offset += size;
  return slice;
}

function decodeItem(cursor: Cursor): CborValue {
  const initialOffset = cursor.offset;
  const lead = readByte(cursor);
  const major = lead >> 5;
  const ai = lead & 0x1f;

  // Major 7's additional-info values 25/26/27 are float widths, not integer
  // arguments, so they must not be consumed by readArgument before the float
  // reader sees them. Dispatch simple/float values on their own.
  if (major === 7) return decodeSimple(cursor, ai, initialOffset);

  const argument = readArgument(cursor, ai, initialOffset);

  switch (major) {
    case 0: // unsigned integer
      return argument;
    case 1: // negative integer
      return typeof argument === 'bigint' ? -1n - argument : -1 - argument;
    case 2: // byte string
      if (argument === INDEFINITE) {
        const parts: Uint8Array[] = [];
        while (cursor.bytes[cursor.offset] !== 0xff) parts.push(decodeItem(cursor) as Uint8Array);
        cursor.offset += 1;
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const joined = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
          joined.set(part, at);
          at += part.length;
        }
        return joined;
      }
      return readBytes(cursor, argument, initialOffset);
    case 3: // text string
      if (argument === INDEFINITE) {
        let out = '';
        while (cursor.bytes[cursor.offset] !== 0xff) out += decodeItem(cursor);
        cursor.offset += 1;
        return out;
      }
      return readString(cursor, argument, initialOffset);
    case 4: {
      // array
      const items: CborValue[] = [];
      if (argument === INDEFINITE) {
        while (cursor.bytes[cursor.offset] !== 0xff) items.push(decodeItem(cursor));
        cursor.offset += 1;
        return items;
      }
      for (let i = 0; i < Number(argument); i++) items.push(decodeItem(cursor));
      return items;
    }
    case 5: {
      // map
      const map = new Map<CborValue, CborValue>();
      const pairs = argument === INDEFINITE ? Infinity : Number(argument);
      for (let i = 0; i < pairs; i++) {
        if (cursor.bytes[cursor.offset] === 0xff) {
          if (Number.isFinite(pairs))
            throw new CborDecodeError('definite map ended early', cursor.offset);
          cursor.offset += 1;
          break;
        }
        const key = decodeItem(cursor);
        if (map.has(key)) throw new CborDecodeError('duplicate map key', initialOffset);
        map.set(key, decodeItem(cursor));
      }
      return map;
    }
    case 6: // tag: the value is what matters to us
      return decodeItem(cursor);
    /* c8 ignore next 2 */
    default:
      throw new CborDecodeError(`unsupported major type ${major}`, initialOffset);
  }
}

/** Decodes a major-type-7 simple value or float. */
function decodeSimple(cursor: Cursor, ai: number, initialOffset: number): CborValue {
  if (ai === 20) return false;
  if (ai === 21) return true;
  if (ai === 22) return null;
  if (ai === 23) return undefined;
  if (ai === 24) return `simple:${readByte(cursor)}` as unknown as CborValue;
  if (ai === 25) return readFloat(cursor, 2);
  if (ai === 26) return readFloat(cursor, 4);
  if (ai === 27) return readFloat(cursor, 8);
  if (ai === 31) throw new CborDecodeError('unexpected break code', initialOffset);
  // Simple values below 32 carry no meaning we need; surface them so callers
  // can still inspect them.
  return `simple:${ai}` as unknown as CborValue;
}

/**
 * Decodes one complete CBOR value.
 *
 * Trailing bytes are an error: a metadata section holding exactly one value
 * that is followed by junk is corrupted, not "two values".
 */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const cursor: Cursor = { bytes, offset: 0 };
  const value = decodeItem(cursor);
  if (cursor.offset !== bytes.length) {
    throw new CborDecodeError(
      `${bytes.length - cursor.offset} trailing byte(s) after the top-level value`,
      cursor.offset,
    );
  }
  return value;
}
