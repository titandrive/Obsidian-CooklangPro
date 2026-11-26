// What the recipe browser's search box matches: a recipe's name, folder, every property (tags, source name and
// link, author, cuisine, course, diet, description...) and its ingredients. Bases' own search only looks at the
// properties a view shows, which leaves out the source, the ingredients and more. No Obsidian imports, so it can
// be tested in Node.

/** Ingredient names in a Cooklang recipe body: @name{...} or @word. */
export function ingredientNames(body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(/@([^@#~{}\n]+?)\{|@([\p{L}\p{N}_-]+)/gu)) {
    const name = (m[1] ?? m[2] ?? "").replace(/^\?/, "").trim().toLowerCase();
    if (name) names.add(name);
  }
  return [...names];
}

/** Properties that aren't worth searching: the recipe marker, the photo's file name, the heart and stars. */
const SKIP = new Set(["recipe", "photo", "favorite", "rating", "position"]);

function flatten(value: unknown, out: string[]) {
  if (value == null) return;
  if (Array.isArray(value)) value.forEach((v) => flatten(v, out));
  else if (typeof value === "object") Object.values(value as Record<string, unknown>).forEach((v) => flatten(v, out));
  else out.push(String(value));
}

/** Everything searchable about one recipe, lowercased, one string. */
export function searchText(opts: { name: string; folder: string; frontmatter?: Record<string, unknown> | null; ingredients?: string[] }): string {
  const parts = [opts.name, opts.folder];
  for (const [key, value] of Object.entries(opts.frontmatter ?? {})) if (!SKIP.has(key)) flatten(value, parts);
  parts.push(...(opts.ingredients ?? []));
  return parts.join("\n").toLowerCase();
}

/** The words of a search, lowercased; "quoted words" stay together, and a leading # (a tag) is dropped. */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? "").replace(/^#/, "").trim().toLowerCase();
    if (t) terms.push(t);
  }
  return terms;
}

/** A recipe matches when every word of the search is somewhere in it. */
export function matchesSearch(text: string, terms: string[]): boolean {
  return terms.every((t) => text.includes(t));
}
