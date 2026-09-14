// ULID — lexicographically sortable unique IDs (spec §7: stable unique IDs).
// Standard Crockford Base32 implementation (48-bit timestamp + 80-bit randomness).
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRand: number[] = [];

function encodeTime(time: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out = ENCODING[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function randomChars(len: number): number[] {
  const out: number[] = new Array(len);
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out[i] = bytes[i] % 32;
  return out;
}

/** Monotonic ULID: strictly increasing within the same millisecond. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // increment randomness within same ms to preserve monotonic order
    for (let i = lastRand.length - 1; i >= 0; i--) {
      if (lastRand[i] < 31) {
        lastRand[i]++;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastTime = now;
    lastRand = randomChars(16);
  }
  return encodeTime(now, 10) + lastRand.map((r) => ENCODING[r]).join("");
}

export function isValidUlid(id: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

/** Extract timestamp from a ULID. */
export function ulidTime(id: string): number {
  let time = 0;
  for (let i = 0; i < 10; i++) {
    time = time * 32 + ENCODING.indexOf(id[i]);
  }
  return time;
}
