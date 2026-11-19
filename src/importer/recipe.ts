// Finding and normalizing schema.org Recipe data. No Obsidian imports, so it can be tested in Node.

export interface StepGroup {
  section: string | null;
  steps: string[];
}

export interface RecipeData {
  name: string;
  description: string;
  url: string;
  imageUrl: string | null;
  servings: number | null;
  yieldText: string | null;
  totalMinutes: number | null;
  ingredients: string[];
  groups: StepGroup[];
  categories: string[];
  cuisines: string[];
  keywords: string[];
  diets: string[];
  raw: unknown;
}

type Json = any; // schema.org data is loosely typed in the wild

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", frac12: "½", frac14: "¼", frac34: "¾",
  deg: "°", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", eacute: "é",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function cleanText(s: unknown): string {
  if (typeof s !== "string") return "";
  return decodeEntities(decodeEntities(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")))
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function hasType(node: Json, type: string): boolean {
  const t = node?.["@type"];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

function findRecipeNode(node: Json, depth = 0): Json | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipeNode(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (hasType(node, "Recipe")) return node;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    if (node[key]) {
      const r = findRecipeNode(node[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** Returns the first schema.org Recipe found in the page's JSON-LD blocks, or null. */
export function findRecipeJsonLd(html: string): Json | null {
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    let data: Json;
    try {
      data = JSON.parse(text);
    } catch {
      try {
        data = JSON.parse(text.replace(/[\u0000-\u001f]+/g, " "));
      } catch {
        continue;
      }
    }
    const recipe = findRecipeNode(data);
    if (recipe) return recipe;
  }
  return null;
}

/** ISO 8601 duration (PT1H30M, P0DT2H) to minutes. */
export function isoMinutes(d: unknown): number | null {
  if (typeof d !== "string") return null;
  if (!/^P/i.test(d.trim())) {
    // Some sites write plain text: "55 minutes", "1 hour 30 mins".
    const h = /(\d+(?:\.\d+)?)\s*(?:h|hours?|hrs?)\b/i.exec(d);
    const mi = /(\d+)\s*(?:m|min|mins|minutes?)\b/i.exec(d);
    const total = (h ? +h[1] * 60 : 0) + (mi ? +mi[1] : 0);
    return total > 0 ? Math.round(total) : null;
  }
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(d.trim());
  if (!m) return null;
  const mins = (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) + (+(m[4] || 0)) / 60;
  return mins > 0 ? Math.round(mins) : null;
}

function asList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(asList);
  if (typeof v === "string") return v.split(",").map((s) => cleanText(s)).filter(Boolean);
  if (typeof v === "object" && typeof (v as Json).name === "string") return [cleanText((v as Json).name)];
  return [];
}

/** Rough size of an image from its URL ("w_1200", "?fit=225,225", "1200x800"); unknown counts as large. */
function urlSize(u: string): number {
  const m = /(?:w_|width=|w=|fit=)(\d{2,5})|(\d{2,5})(?:x|%2C|,)\d{2,5}/i.exec(u);
  return m ? +(m[1] || m[2]) : 5000;
}

function imageUrl(img: Json): string | null {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) {
    const urls = img
      .map((i) => (typeof i === "string" ? { url: i, w: urlSize(i) } : i?.url ? { url: i.url as string, w: +i.width || urlSize(i.url) } : null))
      .filter((x): x is { url: string; w: number } => !!x);
    if (!urls.length) return null;
    return urls.sort((a, b) => b.w - a.w)[0].url;
  }
  return img.url || img.contentUrl || null;
}

function stepTexts(node: Json): string[] {
  if (!node) return [];
  if (typeof node === "string") {
    return cleanText(node).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(node)) return node.flatMap(stepTexts);
  if (hasType(node, "HowToStep") || node.text) return stepTexts(node.text ?? node.name);
  if (node.itemListElement) return stepTexts(node.itemListElement);
  return [];
}

function stepGroups(instr: Json): StepGroup[] {
  const list = Array.isArray(instr) ? instr : [instr];
  const groups: StepGroup[] = [];
  let loose: StepGroup | null = null;
  for (const item of list) {
    if (item && typeof item === "object" && hasType(item, "HowToSection")) {
      loose = null;
      groups.push({ section: cleanText(item.name) || null, steps: stepTexts(item.itemListElement) });
    } else {
      if (!loose) {
        loose = { section: null, steps: [] };
        groups.push(loose);
      }
      loose.steps.push(...stepTexts(item));
    }
  }
  return groups.filter((g) => g.steps.length);
}

function parseServings(y: unknown): { n: number | null; text: string | null } {
  const items = Array.isArray(y) ? y : [y];
  let text: string | null = null;
  for (const it of items) {
    const s = typeof it === "number" ? String(it) : cleanText(it);
    if (!s) continue;
    text = text ?? s;
    const m = /(\d+)/.exec(s);
    if (m && /^\s*\d+\s*(servings?|people|portions?)?\s*$/i.test(s)) return { n: +m[1], text: s };
  }
  const m = text ? /(\d+)/.exec(text) : null;
  return { n: m ? +m[1] : null, text };
}

export function normalizeRecipe(r: Json, url: string): RecipeData {
  const s = parseServings(r.recipeYield);
  const total = isoMinutes(r.totalTime) ?? (((isoMinutes(r.prepTime) ?? 0) + (isoMinutes(r.cookTime) ?? 0)) || null);
  return {
    name: cleanText(r.name) || "Untitled recipe",
    description: cleanText(r.description),
    url,
    imageUrl: imageUrl(r.image),
    servings: s.n,
    yieldText: s.text,
    totalMinutes: total,
    ingredients: (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : Array.isArray(r.ingredients) ? r.ingredients : [])
      .map((i: unknown) => cleanText(i))
      .filter(Boolean),
    groups: stepGroups(r.recipeInstructions),
    categories: asList(r.recipeCategory),
    cuisines: asList(r.recipeCuisine),
    keywords: asList(r.keywords),
    diets: asList(r.suitableForDiet),
    raw: r,
  };
}
