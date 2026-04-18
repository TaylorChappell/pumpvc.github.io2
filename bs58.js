'use strict';

(function () {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const map = Object.fromEntries([...alphabet].map((char, index) => [char, index]));

  function encode(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    let digits = [0];
    for (const byte of bytes) {
      let carry = byte;
      for (let i = 0; i < digits.length; i += 1) {
        carry += digits[i] << 8;
        digits[i] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    for (const byte of bytes) {
      if (byte !== 0) break;
      digits.push(0);
    }
    return digits.reverse().map((digit) => alphabet[digit]).join('');
  }

  function decode(text) {
    if (!text) return new Uint8Array();
    const bytes = [0];
    for (const char of text) {
      const value = map[char];
      if (value == null) throw new Error('Invalid base58 character');
      let carry = value;
      for (let i = 0; i < bytes.length; i += 1) {
        carry += bytes[i] * 58;
        bytes[i] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (const char of text) {
      if (char !== '1') break;
      bytes.push(0);
    }
    return new Uint8Array(bytes.reverse());
  }

  window.bs58 = { encode, decode };
})();
