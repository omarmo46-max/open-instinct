/** `{{secret:vault:Netflix.password}}` or `{{secret:op://Personal/Netflix/password}}`: a stand-in the model writes so it never sees the value. */
const REF = /\{\{\s*secret:([^{}\s][^{}]{0,118}?)\s*\}\}/g;

export function findSecretRefs(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof v === "string") {
      for (const m of v.matchAll(REF)) out.add(m[1]!.trim());
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
  };
  walk(value, 0);
  return [...out];
}

/** A copy of `value` with every reference replaced by `resolve(ref)`. */
export async function replaceSecretRefs<T>(value: T, resolve: (ref: string) => Promise<string>): Promise<T> {
  const refs = findSecretRefs(value);
  const values = new Map<string, string>();
  for (const r of refs) values.set(r, await resolve(r));
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return v;
    if (typeof v === "string") return v.replace(REF, (_m, ref: string) => values.get(ref.trim()) ?? "");
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, depth + 1)]));
    return v;
  };
  return walk(value, 0) as T;
}

/** A label that is safe to show: the reference itself holds a name, not a value. */
export function refLabel(ref: string): string {
  return ref.length > 60 ? `${ref.slice(0, 59)}…` : ref;
}
