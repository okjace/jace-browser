/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * End-to-end encryption for Jace sync. Only WebCrypto here, so
 * tests/crypto.test.mjs runs it under Node.
 *
 * - The sync key is 256 bits derived from the person's sync passphrase with
 *   PBKDF2-SHA256 (600,000 rounds) and a random salt. The passphrase never
 *   leaves the device; the derived key is kept in the password manager.
 * - The "keys" collection on Jace holds only the salt, the round count, and a
 *   check value (a known string encrypted with the key), so a new device can
 *   tell a wrong passphrase from a right one.
 * - Each collection is JSON encrypted with AES-256-GCM, a fresh 96-bit IV per
 *   upload, and the collection name as additional data (so one collection's
 *   ciphertext can't be swapped in for another's).
 * - Wire format: base64( 0x01 | iv(12) | ciphertext+tag ).
 */

const VERSION = 1;
export const PBKDF2_ROUNDS = 600_000;
const CHECK_TEXT = "jace-sync-key-check-v1";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(rawBase64) {
  return crypto.subtle.importKey("raw", fromBase64(rawBase64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export class JaceCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const JaceCrypto = {
  /** Derives the raw sync key (base64) from a passphrase and salt (base64). */
  async deriveKey(passphrase, saltBase64, rounds = PBKDF2_ROUNDS) {
    const material = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(saltBase64), iterations: rounds },
      material,
      256,
    );
    return toBase64(new Uint8Array(bits));
  },

  newSalt() {
    return toBase64(crypto.getRandomValues(new Uint8Array(16)));
  },

  async encrypt(keyBase64, collection, value) {
    const key = await importKey(keyBase64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: enc.encode(collection) },
        key,
        enc.encode(JSON.stringify(value)),
      ),
    );
    const out = new Uint8Array(1 + iv.length + ciphertext.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(ciphertext, 1 + iv.length);
    return toBase64(out);
  },

  async decrypt(keyBase64, collection, payloadBase64) {
    const bytes = fromBase64(payloadBase64);
    if (bytes[0] !== VERSION) {
      throw new JaceCryptoError("unsupported", "This sync data was written by a newer Jace Browser. Update to read it.");
    }
    const key = await importKey(keyBase64);
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(1, 13), additionalData: enc.encode(collection) },
        key,
        bytes.subarray(13),
      );
    } catch {
      throw new JaceCryptoError("bad_key", "Couldn't decrypt sync data. Was the sync passphrase changed on another device?");
    }
    return JSON.parse(dec.decode(plain));
  },

  /** The public "keys" record for a new sync key: salt, rounds, and a check value. */
  async makeKeysRecord(keyBase64, saltBase64, rounds = PBKDF2_ROUNDS) {
    return { v: VERSION, salt: saltBase64, rounds, check: await this.encrypt(keyBase64, "keys", CHECK_TEXT) };
  },

  /** True if keyBase64 is the key the keys record was made with. */
  async checkKey(keyBase64, keysRecord) {
    try {
      return (await this.decrypt(keyBase64, "keys", keysRecord.check)) === CHECK_TEXT;
    } catch {
      return false;
    }
  },

  /** keys records travel as base64(JSON) (the server only accepts base64). */
  encodeKeysRecord(record) {
    return toBase64(enc.encode(JSON.stringify(record)));
  },

  decodeKeysRecord(payload) {
    return JSON.parse(dec.decode(fromBase64(payload)));
  },
};
