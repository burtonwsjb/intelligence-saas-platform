export const MONEY_UNIT_MAJOR = "major" as const;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;
const ZERO_FRACTION_CURRENCIES = new Set(["JPY", "KRW"]);

export function normalizeCurrencyCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new MoneyError("Currency is required and must be an ISO 4217 uppercase code.");
  }
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new MoneyError("Currency is required and must be an ISO 4217 uppercase code.");
  }
  return code;
}

export function assertSameCurrency(left: unknown, right: unknown): string {
  const a = normalizeCurrencyCode(left);
  const b = normalizeCurrencyCode(right);
  if (a !== b) {
    throw new MoneyError(`Cannot combine ${a} with ${b}; FX conversion is not supported.`);
  }
  return a;
}

export function parseMoneyDecimal(value: unknown): string {
  if (value == null || value === "") {
    throw new MoneyError("Money value is required.");
  }
  let raw: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MoneyError("Money value must be a finite decimal.");
    }
    raw = value.toString();
  } else if (typeof value === "string") {
    raw = value.trim();
  } else {
    throw new MoneyError("Money value must be a decimal string or finite number.");
  }
  if (/[eE]/.test(raw) || raw.includes(",")) {
    throw new MoneyError("Money value must be a plain decimal without scientific notation or grouping.");
  }
  if (!DECIMAL_RE.test(raw)) {
    throw new MoneyError("Money value must be a plain decimal.");
  }
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  if (!integerPart) {
    throw new MoneyError("Money value must be a plain decimal.");
  }
  if (fractionPart.length > 8) {
    throw new MoneyError("Money value exceeds 8 decimal places.");
  }
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionPart.replace(/0+$/, "");
  const normalized = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  if (normalized === "0") {
    return negative ? "-0" : "0";
  }
  return negative ? `-${normalized}` : normalized;
}

export function persistMoneyDecimal(value: unknown): string {
  return parseMoneyDecimal(value);
}

export function moneyToFiniteNumber(value: unknown): number {
  const parsed = parseMoneyDecimal(value);
  const n = Number(parsed);
  if (!Number.isFinite(n)) {
    throw new MoneyError("Money value cannot be represented as a finite number.");
  }
  return n;
}

export function displayFractionDigits(currency: unknown): number {
  const code = normalizeCurrencyCode(currency);
  return ZERO_FRACTION_CURRENCIES.has(code) ? 0 : 2;
}

export function formatMoney(amount: unknown, currency: unknown): string {
  if (amount == null || amount === "") {
    return "—";
  }
  const code = normalizeCurrencyCode(currency);
  const digits = displayFractionDigits(code);
  const n = moneyToFiniteNumber(amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function majorMoneyFields(
  amount: unknown,
  currency: unknown,
): {
  amount: string | null;
  currency: string | null;
  unit: typeof MONEY_UNIT_MAJOR;
} {
  if (amount == null || amount === "" || currency == null || currency === "") {
    return { amount: null, currency: null, unit: MONEY_UNIT_MAJOR };
  }
  return {
    amount: parseMoneyDecimal(amount),
    currency: normalizeCurrencyCode(currency),
    unit: MONEY_UNIT_MAJOR,
  };
}
