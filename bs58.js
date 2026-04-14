// Minimal Base58 encoder/decoder for Solana addresses and keys
const BS58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bs58encode(bytes) {
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;
  // same fix as decode: don't initialise digits for all-zero input
  const digits = zeros < bytes.length ? [0] : [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = digits.length - 1; j >= 0; j--) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.unshift(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.map(d => BS58_ALPHA[d]).join('');
}

function bs58decode(str) {
  let zeros = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i++) zeros++;

  // Only initialise bytes if there are non-'1' characters to decode.
  // If ALL characters are '1' (e.g. System Program 111...1) the loop
  // never runs, so bytes must start empty to avoid an off-by-one zero.
  const bytes = zeros < str.length ? [0] : [];

  for (let i = zeros; i < str.length; i++) {
    let carry = BS58_ALPHA.indexOf(str[i]);
    if (carry < 0) throw new Error('Invalid base58 character: ' + str[i]);
    for (let j = bytes.length - 1; j >= 0; j--) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.unshift(carry & 0xff); carry >>= 8; }
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}