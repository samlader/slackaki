// Tiny cron matcher. Supports the standard 5 fields (minute, hour,
// day-of-month, month, day-of-week) with *, N, A,B,C, A-B, */N, A-B/N.
// Day-of-month vs day-of-week uses Vixie semantics: if both are restricted
// they OR, otherwise AND.

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 6], // day-of-week (Sun=0)
];

interface Parsed {
  sets: Set<number>[];
  domRaw: string;
  dowRaw: string;
}

export function parseCron(expr: string): Parsed | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(fields[i], RANGES[i][0], RANGES[i][1]);
    if (!s) return null;
    sets.push(s);
  }
  return { sets, domRaw: fields[2], dowRaw: fields[4] };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

export function cronMatches(parsed: Parsed, date: Date): boolean {
  const [m, h, dom, mo, dow] = parsed.sets;
  if (!m.has(date.getMinutes())) return false;
  if (!h.has(date.getHours())) return false;
  if (!mo.has(date.getMonth() + 1)) return false;
  const domOk = dom.has(date.getDate());
  const dowOk = dow.has(date.getDay());
  const bothRestricted = parsed.domRaw !== "*" && parsed.dowRaw !== "*";
  return bothRestricted ? domOk || dowOk : domOk && dowOk;
}

function parseField(spec: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const piece of spec.split(",")) {
    let step = 1;
    let rangePart = piece;
    const slash = piece.indexOf("/");
    if (slash >= 0) {
      rangePart = piece.slice(0, slash);
      const s = Number(piece.slice(slash + 1));
      if (!Number.isInteger(s) || s <= 0) return null;
      step = s;
    }
    let from = lo;
    let to = hi;
    if (rangePart === "*") {
      // leave as full range
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      from = a;
      to = b;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return null;
      from = n;
      to = slash >= 0 ? hi : n;
    }
    if (from < lo || to > hi || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}
