// The checksums behind the redaction rules (SC-AI1): a number is only treated as a tax file
// number, an ABN or a card when it passes the check its issuer designed, so an ordinary
// number of the same length is left alone.

export function isLuhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let n = Number(digits[i]);
    if (double) n = n > 4 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** Nine-digit tax file number: weights 1 4 3 7 5 8 6 9 10, sum divisible by 11. */
export function isTfnValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  return weights.reduce((sum, weight, i) => sum + weight * Number(digits[i]), 0) % 11 === 0;
}

/** Eleven-digit ABN: take 1 from the first digit, weights 10 1 3 5 ... 19, sum divisible by 89. */
export function isAbnValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const values = digits.split("").map(Number);
  values[0] -= 1;
  return values.reduce((sum, value, i) => sum + value * weights[i], 0) % 89 === 0;
}

/** Card issuers' number ranges, loosely: enough to leave alone a long number that only happens to pass Luhn. */
export function plausibleCardPrefix(digits: string): boolean {
  const first = digits[0];
  if (first === "4" || first === "5" || first === "6") return true;
  if (first === "3") return /^3[0456789]/.test(digits);
  if (first === "2") return Number(digits.slice(0, 4)) >= 2221 && Number(digits.slice(0, 4)) <= 2720;
  return false;
}
