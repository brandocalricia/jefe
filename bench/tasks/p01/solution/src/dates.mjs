const FORMATS = [
  { re: /^(\d{4})-(\d{2})-(\d{2})$/, pick: (m) => [m[1], m[2], m[3]] },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, pick: (m) => [m[3], m[1], m[2]] },
  { re: /^(\d{2})\.(\d{2})\.(\d{4})$/, pick: (m) => [m[3], m[2], m[1]] },
];

export function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseDate(text) {
  const s = String(text).trim();
  for (const { re, pick } of FORMATS) {
    const m = re.exec(s);
    if (!m) continue;
    const [y, mo, d] = pick(m).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

export function nextMonth(month) {
  let y = Number(month.slice(0, 4));
  let m = Number(month.slice(5, 7)) + 1;
  if (m > 12) { m = 1; y += 1; }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}
