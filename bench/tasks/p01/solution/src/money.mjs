const AMOUNT = /^(?:(\()|([+-])?)(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\))?$/;

export function parseAmount(text) {
  const m = AMOUNT.exec(String(text).trim());
  if (!m) return null;
  const [, open, sign, , whole, frac = '', close] = m;
  if (Boolean(open) !== Boolean(close)) return null;
  const cents = Number(whole.replace(/,/g, '')) * 100 + Number(frac.padEnd(2, '0'));
  const negative = Boolean(open) || sign === '-';
  return negative && cents !== 0 ? -cents : cents;
}

export function formatCents(cents) {
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${whole}.${frac}`;
}

// Percentage of `part` in `whole`, rounded half up, in integer arithmetic.
export function percentOf(part, whole) {
  if (whole === 0) return null;
  return Math.floor((part * 200 + whole) / (2 * whole));
}
