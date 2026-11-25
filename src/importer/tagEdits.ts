// Tag edits for one or more recipes, worked out before anything is saved. No Obsidian imports, so it can be
// tested in Node.
//
// The editor starts from every tag on the chosen recipes. Each tag can be renamed or removed, a tag only some
// of the recipes have can be added to all of them, and new tags are added to all of them.

export interface TagState {
  /** The tag as it is now on some of the recipes; null for a tag added in the editor. */
  original: string | null;
  /** What it will be called. */
  name: string;
  removed: boolean;
  /** Add it to every recipe, not only the ones that have it now. Always true for new tags. */
  toAll: boolean;
  /** How many of the recipes have it now. */
  count: number;
}

/** A tag as recipes store it: no #, lowercase, words joined with hyphens. Empty if nothing usable is left. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_\-/]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
}

/** The tags in a recipe's front matter, however they were written (a list, or a string with commas or spaces). */
export function readTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const v of list) {
    const t = String(v ?? "").replace(/^#/, "").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The starting state: every tag on the recipes, in the order first seen, with how many recipes have it. */
export function initialStates(tagLists: string[][]): TagState[] {
  const states: TagState[] = [];
  for (const tags of tagLists) {
    for (const t of tags) {
      const s = states.find((x) => x.original === t);
      if (s) s.count++;
      else states.push({ original: t, name: t, removed: false, toAll: false, count: 1 });
    }
  }
  return states;
}

/** One recipe's tags after the edits: renamed, removed and added, with no duplicates. */
export function applyTagStates(tags: string[], states: TagState[]): string[] {
  const out: string[] = [];
  const push = (t: string) => {
    if (t && !out.includes(t)) out.push(t);
  };
  for (const t of tags) {
    const s = states.find((x) => x.original === t);
    if (!s) push(t);
    else if (!s.removed) push(s.name);
  }
  for (const s of states) if (!s.removed && (s.original === null || s.toAll)) push(s.name);
  return out;
}

/** Whether the edits change anything for these recipes. */
export function tagsChanged(tagLists: string[][], states: TagState[]): boolean {
  return tagLists.some((tags) => {
    const next = applyTagStates(tags, states);
    return next.length !== tags.length || next.some((t, i) => t !== tags[i]);
  });
}
