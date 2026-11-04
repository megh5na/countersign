// Invariant I8: money is integer minor units. PayPal speaks decimal strings; convert only at the edge, without floats.
export function minorToDecimal(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) throw new Error(`invalid minor amount: ${minor}`);
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

export function decimalToMinor(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new Error(`invalid decimal amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
