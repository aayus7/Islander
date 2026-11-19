// Instant answers in "Search or Ask", computed locally (no AI round-trip), like
// Spotlight: arithmetic and common unit conversions.

/** Safe arithmetic evaluator: + − × ÷ ^ %, parentheses, decimals, sqrt/sin/cos/tan/log/ln/abs, pi, e. */
export function evalMath(input: string): number | null {
  const src = input
    .toLowerCase()
    .replace(/×|x(?=\s*[\d(])/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/,/g, "")
    .replace(/\s+/g, "");
  if (!src || !/^[\d.+\-*/^%()a-z]+$/.test(src) || !/\d|pi|\be\b/.test(src)) return null;
  // Must look like maths, not a word query.
  if (/[a-z]/.test(src.replace(/sqrt|sin|cos|tan|log|ln|abs|pi|e/g, ""))) return null;
  if (!/[+\-*/^%(]/.test(src) && !/^(sqrt|sin|cos|tan|log|ln|abs)/.test(src)) return null;

  let i = 0;
  const peek = () => src[i];
  const fns: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    sin: (x) => Math.sin((x * Math.PI) / 180),
    cos: (x) => Math.cos((x * Math.PI) / 180),
    tan: (x) => Math.tan((x * Math.PI) / 180),
    log: Math.log10,
    ln: Math.log,
    abs: Math.abs,
  };
  function primary(): number {
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") throw 0;
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -primary();
    }
    if (peek() === "+") {
      i++;
      return primary();
    }
    for (const [name, f] of Object.entries(fns)) {
      if (src.startsWith(name, i)) {
        i += name.length;
        return f(primary());
      }
    }
    if (src.startsWith("pi", i)) {
      i += 2;
      return Math.PI;
    }
    if (peek() === "e" && !/\d/.test(src[i + 1] ?? "")) {
      i++;
      return Math.E;
    }
    const m = /^\d*\.?\d+(e[+-]?\d+)?/.exec(src.slice(i));
    if (!m) throw 0;
    i += m[0].length;
    let v = parseFloat(m[0]);
    if (peek() === "%") {
      i++;
      v /= 100;
    }
    return v;
  }
  function power(): number {
    const b = primary();
    if (peek() === "^") {
      i++;
      return Math.pow(b, power());
    }
    return b;
  }
  function term(): number {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "(") {
      if (peek() === "(") {
        v *= power(); // implicit multiplication: 2(3+4)
        continue;
      }
      const op = src[i++];
      const r = power();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = src[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  try {
    const v = expr();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

const UNITS: Record<string, [string, number]> = {
  // length (metres)
  mm: ["length", 0.001], cm: ["length", 0.01], m: ["length", 1], km: ["length", 1000],
  in: ["length", 0.0254], inch: ["length", 0.0254], inches: ["length", 0.0254], ft: ["length", 0.3048], feet: ["length", 0.3048], foot: ["length", 0.3048],
  yd: ["length", 0.9144], mi: ["length", 1609.344], mile: ["length", 1609.344], miles: ["length", 1609.344],
  // mass (kg)
  g: ["mass", 0.001], kg: ["mass", 1], lb: ["mass", 0.45359237], lbs: ["mass", 0.45359237], oz: ["mass", 0.028349523], st: ["mass", 6.35029318],
  // volume (litres)
  ml: ["volume", 0.001], l: ["volume", 1], gal: ["volume", 3.785411784], cup: ["volume", 0.2365882], cups: ["volume", 0.2365882], floz: ["volume", 0.0295735],
  // speed (m/s)
  "km/h": ["speed", 1 / 3.6], kmh: ["speed", 1 / 3.6], kph: ["speed", 1 / 3.6], mph: ["speed", 0.44704], "m/s": ["speed", 1], knots: ["speed", 0.514444],
  // data (bytes)
  kb: ["data", 1e3], mb: ["data", 1e6], gb: ["data", 1e9], tb: ["data", 1e12], kib: ["data", 1024], mib: ["data", 1048576], gib: ["data", 1073741824],
  // time (s)
  s: ["time", 1], sec: ["time", 1], min: ["time", 60], h: ["time", 3600], hr: ["time", 3600], hours: ["time", 3600], day: ["time", 86400], days: ["time", 86400], week: ["time", 604800], weeks: ["time", 604800],
};

const TEMP = new Set(["c", "°c", "f", "°f", "k", "celsius", "fahrenheit", "kelvin"]);
const tempKey = (u: string) => (u.includes("f") ? "F" : u.startsWith("k") ? "K" : "C");

function fmt(n: number) {
  if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0)) return n.toExponential(4);
  return Number(n.toPrecision(10)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** "12 km to mi", "70f in c", "3.5 gb to mib" → "7.45645 mi". */
export function convert(input: string): string | null {
  const m = /^\s*(-?[\d.,]+)\s*([a-z°/]+)\s+(?:to|in|as|=)\s+([a-z°/]+)\s*\??$/i.exec(input.trim());
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  const a = m[2].toLowerCase();
  const b = m[3].toLowerCase();
  if (Number.isNaN(v)) return null;
  if (TEMP.has(a) && TEMP.has(b)) {
    const from = tempKey(a);
    const to = tempKey(b);
    const c = from === "C" ? v : from === "F" ? ((v - 32) * 5) / 9 : v - 273.15;
    const out = to === "C" ? c : to === "F" ? (c * 9) / 5 + 32 : c + 273.15;
    return `${fmt(out)} °${to === "K" ? "K" : to}`;
  }
  const ua = UNITS[a];
  const ub = UNITS[b];
  if (!ua || !ub || ua[0] !== ub[0]) return null;
  const label = ub[0] === "data" ? b.toUpperCase().replace("IB", "iB") : m[3];
  return `${fmt((v * ua[1]) / ub[1])} ${label}`;
}

/** An instant local answer for the query, or null to ask the AI. */
export function quickAnswer(q: string): string | null {
  const c = convert(q);
  if (c) return c;
  const expr = q.replace(/^\s*(what is|what's|calc|calculate|=)\s*/i, "").replace(/[=?]\s*$/, "");
  const v = evalMath(expr);
  if (v == null) return null;
  return `= ${fmt(v)}`;
}
