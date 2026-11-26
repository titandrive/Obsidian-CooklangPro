// When a recipe was added: the `added` property (YYYY-MM-DD), set on import and filled in once for older
// recipes from their file's creation time. No Obsidian imports, so it can be tested in Node.

/** A date as YYYY-MM-DD in local time. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A recipe note with `added: <date>` in its front matter, unless it has one already. */
export function withAdded(markdown: string, date: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!fm) return `---\nadded: ${date}\n---\n${markdown}`;
  if (/^added:/m.test(fm[1])) return markdown;
  const end = fm.index + 4 + fm[1].length;
  return `${markdown.slice(0, end)}\nadded: ${date}${markdown.slice(end)}`;
}

/** The time a recipe was added, in ms: its `added` property, else `fallback` (the file's creation time). */
export function addedTime(value: unknown, fallback: number): number {
  const s = value instanceof Date ? localDate(value) : typeof value === "string" ? value.trim() : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return fallback;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** "Nov 26" this year, "Nov 26, 2025" otherwise; `full` always has the year. */
export function shortDate(time: number, full = false, now = new Date()): string {
  const d = new Date(time);
  const year = full || d.getFullYear() !== now.getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });
}
