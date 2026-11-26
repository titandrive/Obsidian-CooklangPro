// A recipe's `source` property: read and write it. No Obsidian imports, so it can be tested in Node.

/** The name and link in a `source` property, however it was written. */
export function readSource(value: unknown): { name: string; url: string } {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return { name: String(v.name ?? "").trim(), url: String(v.url ?? "").trim() };
  }
  const s = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(s) ? { name: "", url: s } : { name: s, url: "" };
}

/** What to store for a name and link; null removes the property. */
export function sourceValue(name: string, url: string): string | { name: string; url: string } | null {
  name = name.trim();
  url = url.trim();
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
  if (name && url) return { name, url };
  return url || name || null;
}
