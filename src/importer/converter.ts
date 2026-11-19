// Turning normalized recipe data into a Cooklang Markdown recipe note, without any AI.

import { RecipeData } from "./recipe";
import { Ingredient, ingredientMarkup, parseIngredient } from "./ingredient";

export const DEFAULT_FOLDERS = [
  "Breakfast", "Breads", "Desserts", "Dinner", "Drinks", "Pasta & Noodles", "Sandwiches", "Sauces & Dips", "Sides", "Soups",
];


/** Text that is plain prose in Cooklang: strip anything that would be read as markup. */
export function escapeProse(s: string): string {
  return s
    .replace(/--+/g, "-")
    .replace(/\[-/g, "[ -")
    .replace(/@/g, " at ")
    .replace(/#(\d)/g, "No. $1")
    .replace(/#/g, "")
    .replace(/~/g, "about ")
    .replace(/[{}]/g, "")
    .replace(/^\s*[=>]+\s*/, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const MARKUP = /[@#~]\??[^@#~{}\n]*\{[^}\n]*\}(?:\([^)\n]*\))?/g;

/** Same-length copy of the text with existing markup blanked out, so new matches never land inside it. */
function masked(s: string): string {
  return s.replace(MARKUP, (m) => "\u0001".repeat(m.length));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function variants(phrase: string): string[] {
  const out = [phrase];
  if (/ies$/.test(phrase)) out.push(phrase.replace(/ies$/, "y"));
  else if (/(ch|sh|x|o)es$/.test(phrase)) out.push(phrase.replace(/es$/, ""));
  else if (/[^s]s$/.test(phrase)) out.push(phrase.slice(0, -1));
  else out.push(phrase + "s", phrase + "es");
  return out;
}

const WEAK_WORDS = new Set(["and", "or", "of", "the", "fresh", "freshly", "ground", "chopped", "dried", "large", "small", "medium", "whole", "to", "taste"]);

/** Phrases to look for in the steps, most specific first. */
function candidates(name: string): string[] {
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let start = 0; start < words.length; start++) {
    const tail = words.slice(start);
    if (tail.length === 1 && (WEAK_WORDS.has(tail[0]) || tail[0].length < 3)) continue;
    out.push(...variants(tail.join(" ")));
  }
  // "salt and pepper" style names: also try the first item alone.
  const first = name.toLowerCase().split(/\s+(?:and|or)\s+/)[0];
  if (first && first !== name.toLowerCase()) out.push(...variants(first));
  return [...new Set(out)];
}

function findIn(steps: string[], phrase: string, from = 0): { step: number; index: number; length: number } | null {
  const re = new RegExp(`(?<![\\w-])${escapeRe(phrase)}(?![\\w-])`, "i");
  for (let k = from; k < steps.length; k++) {
    const m = re.exec(masked(steps[k]));
    if (m) return { step: k, index: m.index, length: m[0].length };
  }
  return null;
}

export function markIngredients(steps: string[], ingredients: Ingredient[]): { steps: string[]; unmatched: Ingredient[] } {
  const out = [...steps];
  const unmatched: Ingredient[] = [];
  const order = ingredients
    .map((ing, i) => ({ ing, i }))
    .sort((a, b) => b.ing.name.length - a.ing.name.length);
  for (const { ing } of order) {
    let hit: { step: number; index: number; length: number } | null = null;
    for (const c of candidates(ing.name)) {
      hit = findIn(out, c);
      if (hit) break;
    }
    if (!hit) {
      unmatched.push(ing);
      continue;
    }
    const s = out[hit.step];
    // If the words just before the match are the start of the full name ("coarse" + "sea salt"), take them too.
    const head = ing.name.toLowerCase();
    const shortText = s.slice(hit.index, hit.index + hit.length).toLowerCase();
    if (head.endsWith(shortText) && head.length > shortText.length) {
      const prefix = ing.name.slice(0, ing.name.length - shortText.length);
      const before = s.slice(Math.max(0, hit.index - prefix.length), hit.index);
      if (before.toLowerCase() === prefix.toLowerCase() && !masked(before).includes("\u0001")) {
        hit.index -= prefix.length;
        hit.length += prefix.length;
      }
    }
    const matchedText = s.slice(hit.index, hit.index + hit.length);
    // Keep the author's word when it is the full name; otherwise use the full ingredient name so the list is clear.
    const useName = matchedText.toLowerCase() === ing.name.toLowerCase() ? matchedText : ing.name;
    // The plugin prints the note next to the name inside the step, so drop note parts the sentence already says.
    const around = (s.slice(Math.max(0, hit.index - 40), hit.index) + " " + s.slice(hit.index + hit.length, hit.index + hit.length + 60)).toLowerCase();
    const keptNote = (ing.note ?? "")
      .split(/,\s*/)
      .filter((part) => part && !around.includes(part.toLowerCase().split(" ").slice(0, 2).join(" ")))
      .join(", ");
    out[hit.step] = s.slice(0, hit.index) + ingredientMarkup({ ...ing, note: keptNote || null }, useName) + s.slice(hit.index + hit.length);
  }
  // Keep the original list order for anything not mentioned in the steps.
  unmatched.sort((a, b) => ingredients.indexOf(a) - ingredients.indexOf(b));
  return { steps: out, unmatched };
}

const TIME_RE = /(\d+(?:\s+\d+\/\d+)?(?:\.\d+)?|\d+\/\d+)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(?:more\s+|additional\s+)?(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi;

function timerUnit(u: string): string {
  u = u.toLowerCase();
  if (u.startsWith("s")) return "seconds";
  if (u.startsWith("h")) return "hours";
  return "minutes";
}

function num(q: string): string {
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(q.trim());
  return mixed ? String(+mixed[1] + +mixed[2] / +mixed[3]) : q.trim();
}

export function markTimers(step: string): string {
  const mask = masked(step);
  let result = "";
  let last = 0;
  TIME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TIME_RE.exec(mask))) {
    const qty = m[2] ? `${num(m[1])}-${num(m[2])}` : num(m[1]);
    result += step.slice(last, m.index) + `~{${qty}%${timerUnit(m[3])}}`;
    last = m.index + m[0].length;
  }
  return result + step.slice(last);
}


const PROTEINS: [RegExp, string][] = [
  [/\bchicken\b/, "chicken"],
  [/\b(beef|steak|sirloin|chuck|brisket)\b/, "beef"],
  [/\b(pork|bacon|pancetta|prosciutto|ham|sausage|chorizo)\b/, "pork"],
  [/\b(shrimp|prawns?)\b/, "shrimp"],
  [/\b(salmon|cod|tuna|halibut|tilapia|fish)\b/, "fish"],
  [/\btofu\b/, "tofu"],
  [/\b(tvp|textured vegetable protein)\b/, "tvp"],
  [/\blentils?\b/, "lentils"],
];

const DIETS: Record<string, string> = {
  vegandiet: "vegan", vegetariandiet: "vegetarian", glutenfreediet: "gluten-free", vegan: "vegan", vegetarian: "vegetarian",
  "gluten-free": "gluten-free", "gluten free": "gluten-free",
};

function slug(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function guessTags(r: RecipeData, ingredients: Ingredient[], body: string): string[] {
  const tags: string[] = [];
  for (const c of r.cuisines) tags.push(slug(c));
  const dietSource = [...r.diets, ...r.keywords].map((d) => d.replace(/^https?:\/\/schema\.org\//, "").toLowerCase());
  for (const d of dietSource) if (DIETS[d]) tags.push(DIETS[d]);
  if (!tags.includes("vegan") && /\bvegan\b/i.test(r.name)) tags.push("vegan");
  const meatless = tags.includes("vegan") || tags.includes("vegetarian");
  const names = ingredients
    .map((i) => i.name.toLowerCase())
    .filter((n) => !/\b(broth|stock|bouillon|base|fat|drippings)\b/.test(n))
    .join(" | ");
  for (const [re, tag] of PROTEINS) {
    if (meatless && !["tofu", "tvp", "lentils"].includes(tag)) continue;
    if (re.test(names)) tags.push(tag);
  }
  const text = body.toLowerCase() + " " + r.name.toLowerCase();
  if (/slow cooker|crock ?pot/.test(text)) tags.push("slow-cooker");
  if (/instant pot|pressure cook/.test(text)) tags.push("instant-pot");
  if (/air fry/.test(text)) tags.push("air-fryer");
  return [...new Set(tags.filter(Boolean))];
}

const FOLDER_RULES: [RegExp, string][] = [
  [/\b(drinks?|beverages?|shakes?|smoothies?|cocktails?|lemonade)\b/, "Drinks"],
  [/\b(desserts?|cookies?|cakes?|cupcakes?|brownies?|blondies?|pies?|tarts?|puddings?|ice cream|candy|fudge|cheesecake|cinnamon rolls?)\b/, "Desserts"],
  [/\b(breakfast|brunch|pancakes?|waffles?|oatmeal|granola|french toast)\b/, "Breakfast"],
  [/\b(breads?|muffins?|focaccia|dough|loaf|biscuits?|scones?|rolls|buns|bagels?)\b/, "Breads"],
  [/\b(soups?|stews?|chowders?|bisque|chili)\b/, "Soups"],
  [/\b(sauces?|dips?|dressings?|salsas?|pesto|guacamole|condiments?|marinades?|spreads?|gravy)\b/, "Sauces & Dips"],
  [/\b(sandwich(es)?|burgers?|wraps?|sloppy joes?)\b/, "Sandwiches"],
  [/\b(pasta|noodles?|spaghetti|linguine|fettuccine|penne|lasagna|ramen|udon|lo mein|mac and cheese|macaroni|gnocchi)\b/, "Pasta & Noodles"],
  [/\b(side dish(es)?|sides?|salads?|vegetables?)\b/, "Sides"],
];

/** Pick the most likely folder from the recipe's name and categories. Only returns names that exist. */
export function guessFolder(r: RecipeData, existing: string[]): string | null {
  const fields = [r.name, r.categories.join(" "), r.keywords.join(" ")].map((f) => f.toLowerCase());
  for (const text of fields) {
    for (const [re, folder] of FOLDER_RULES) if (re.test(text) && existing.includes(folder)) return folder;
  }
  return existing.includes("Dinner") ? "Dinner" : existing[0] ?? null;
}

function shortDescription(d: string): string {
  const flat = d.replace(/\s+/g, " ").trim();
  if (flat.length <= 220) return flat;
  const sentences = flat.match(/[^.!?]+[.!?]+/g) ?? [flat];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > 220) break;
    out += s;
  }
  return (out || flat.slice(0, 217) + "...").trim();
}

function yaml(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid YAML double-quoted string
}

export function frontmatter(r: RecipeData, tags: string[]): string {
  const lines = ["---", "recipe: true", `title: ${yaml(r.name)}`];
  if (r.description) lines.push(`description: ${yaml(shortDescription(r.description))}`);
  if (r.servings) lines.push(`servings: ${r.servings}`);
  if (r.totalMinutes) lines.push(`time: ${r.totalMinutes} minutes`);
  if (r.url) lines.push(`source: ${r.url}`);
  if (tags.length) lines.push(`tags: [${tags.join(", ")}]`);
  lines.push("---");
  return lines.join("\n");
}

/** Heuristic conversion: the whole note, frontmatter included. */
export function toCooklang(r: RecipeData): string {
  const ingredients = r.ingredients.map(parseIngredient).filter((i) => i.name);
  const flat: string[] = [];
  const sectionAt: Map<number, string> = new Map();
  for (const g of r.groups) {
    if (g.section && r.groups.length > 1) sectionAt.set(flat.length, escapeProse(g.section));
    for (const s of g.steps) {
      let clean = escapeProse(s);
      // "SAUCE: Whisk the..." -> a section named Sauce.
      const label = /^([A-Z][A-Z0-9 &'/-]{2,40}):\s+/.exec(clean);
      if (label) {
        sectionAt.set(flat.length, label[1].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
        clean = clean.slice(label[0].length);
      }
      if (clean) flat.push(clean);
    }
  }
  if (!flat.length) flat.push("Combine the ingredients as described in the source recipe.");

  const marked = markIngredients(flat, ingredients);
  const steps = marked.steps.map(markTimers);
  if (marked.unmatched.length) {
    const list = marked.unmatched.map((i) => ingredientMarkup(i));
    steps[0] = `${steps[0]} You will also need ${list.join(", ")}.`;
  }

  const body: string[] = [];
  steps.forEach((s, k) => {
    const section = sectionAt.get(k);
    if (section) body.push(`= ${section}`);
    body.push(s);
  });
  const notes: string[] = [];
  if (r.yieldText && !/^\d+\s*(servings?)?$/i.test(r.yieldText)) notes.push(`> Makes ${escapeProse(r.yieldText)}.`);
  const text = body.join("\n\n");
  const tags = guessTags(r, ingredients, text);
  return `${frontmatter(r, tags)}\n\n${text}\n${notes.length ? "\n" + notes.join("\n") + "\n" : ""}`;
}

/** A file name Obsidian accepts on every platform. */
export function safeFileName(name: string): string {
  let n = name
    .replace(/&/g, "and")
    .replace(/[®™©]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  if (n === n.toUpperCase() && /[A-Z]/.test(n)) n = n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return n.slice(0, 120) || "Untitled recipe";
}
