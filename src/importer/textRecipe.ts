// Reading a recipe that was pasted as plain text, without Claude. No Obsidian imports, so it can be tested in Node.
//
// It handles the usual layouts: a title, maybe a line like "Serves 4, 30 minutes", an ingredient list, and steps,
// with or without "Ingredients" / "Instructions" headings, bullets or step numbers. Messy text comes out rough;
// Claude does better with that.

import type { RecipeData, StepGroup } from "./recipe";

const INGREDIENTS_HEADING = /^(ingredients?|you will need|what you need|shopping list)\b/i;
const STEPS_HEADING = /^(instructions?|directions?|method|steps?|preparation|how to make( it)?)\b/i;
const NOTES_HEADING = /^(notes?|tips?|recipe notes|cook'?s notes)\b/i;

/** "2", "1/2", "½", "1-2", "2.5", "a pinch", or a bare pantry item: lines that look like an ingredient. */
const AMOUNT = /^(\d|[¼½¾⅓⅔⅛⅜⅝⅞]|an? (pinch|dash|handful|few|couple|splash|squeeze)\b|one |two |three |four |five |six )/i;
const PANTRY = /^(salt|pepper|black pepper|kosher salt|sea salt|oil|olive oil|water|ice|butter|sugar|flour|parsley|cilantro|lemon|lime|fresh \w+)\b/i;

/** Removes bullets, checkboxes and step numbers from the start of a line. */
function stripMarker(line: string): string {
  return line
    .replace(/^\s*(?:[-*•·▢☐□◦‣]|\[ ?\])\s*/, "")
    .replace(/^\s*(?:step\s*)?\d{1,2}\s*[.):]\s+/i, "")
    .trim();
}

function isHeading(line: string, re: RegExp): boolean {
  const l = line.replace(/[:\-–—#*]+\s*$/, "").replace(/^[#*\s]+/, "").trim();
  return re.test(l) && l.length <= 30;
}

function looksLikeIngredient(line: string): boolean {
  const l = stripMarker(line);
  if (!l || l.length > 90) return false;
  if (AMOUNT.test(l)) return true;
  // "salt and pepper", "Olive oil, for drizzling"; short and no sentence ending.
  return PANTRY.test(l) && l.length <= 45 && !/[.!?]$/.test(l);
}

/** A sub-heading inside a list, like "For the sauce:" or "SAUCE". */
function isSubHeading(line: string): string | null {
  const l = line.trim();
  const m = /^(?:for the\s+)?(.{2,40}?):$/i.exec(l);
  if (m) return m[1].replace(/^for the\s+/i, "");
  if (/^[A-Z][A-Z &'/-]{2,30}$/.test(l)) return l;
  return null;
}

/** "salt and pepper" is two ingredients; "a pinch of salt" reads as "pinch of salt". */
function splitIngredient(line: string): string[] {
  const l = line.replace(/^an?\s+(?=\w+\s+of\s)/i, "");
  const pair = /^(\w+(?: \w+)?)\s+(?:and|&)\s+(\w+(?: \w+)?)(\s*,?\s*(?:to taste|as needed|for seasoning))?$/i.exec(l);
  if (pair && !/^\d/.test(l)) return [pair[1], pair[2]];
  return [l];
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Total minutes from text like "1 hour 15 minutes", "45 min", "1.5 hrs". */
export function minutesIn(text: string): number | null {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|minutes?|mins?|m\b)/gi)) {
    const n = parseFloat(m[1]);
    total += /^h/i.test(m[2]) ? n * 60 : n;
    found = true;
  }
  return found && total > 0 ? Math.round(total) : null;
}

/** Turns pasted recipe text into recipe data, which the built-in converter then writes as Cooklang. */
export function parseRecipeText(text: string): RecipeData {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());

  let name = "";
  let servings: number | null = null;
  let totalMinutes: number | null = null;
  const description: string[] = [];
  const ingredients: string[] = [];
  const groups: StepGroup[] = [];
  const notes: string[] = [];
  let group: StepGroup | null = null;
  const addStep = (s: string) => {
    if (!group) groups.push((group = { section: null, steps: [] }));
    group.steps.push(s);
  };

  // With headings, the headings decide; without, the first run of ingredient-like lines is the list.
  const hasHeadings = lines.some((l) => isHeading(l, INGREDIENTS_HEADING)) && lines.some((l) => isHeading(l, STEPS_HEADING));
  let mode: "head" | "ingredients" | "steps" | "notes" = "head";
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const p = paragraph.join(" ");
    if (mode === "notes") notes.push(p);
    else addStep(p);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripMarker(raw);
    if (!raw) {
      flush();
      continue;
    }
    if (isHeading(raw, INGREDIENTS_HEADING)) { flush(); mode = "ingredients"; continue; }
    if (isHeading(raw, STEPS_HEADING)) { flush(); mode = "steps"; continue; }
    if (isHeading(raw, NOTES_HEADING)) { flush(); mode = "notes"; continue; }

    if (mode === "head") {
      // Serving and time lines can sit anywhere near the top.
      const serves = /\b(?:serves|servings?|yield|makes)\s*:?\s*(\d+)/i.exec(line) ?? /^(\d+)\s+servings?\b/i.exec(line);
      const isMeta = !!serves || (/\b(prep|cook|total|time|ready in)\b/i.test(line) && minutesIn(line) !== null)
        || (/^(about|approx\.?)?\s*\d+\s*(min|minutes|hours?|hrs?)\b/i.test(line));
      if (isMeta) {
        if (serves && servings === null) servings = parseInt(serves[1], 10);
        const total = /\btotal\b/i.test(line) ? minutesIn(line.split(/total/i)[1] ?? "") : null;
        const mins = total ?? minutesIn(line);
        if (mins !== null && (totalMinutes === null || /\btotal\b/i.test(line))) totalMinutes = mins;
        continue;
      }
      if (!name && !looksLikeIngredient(raw)) {
        name = line.replace(/^#+\s*/, "");
        continue;
      }
      if (!hasHeadings && looksLikeIngredient(raw)) mode = "ingredients";
      else {
        // Text between the title and the list is a description.
        description.push(line);
        continue;
      }
    }

    if (mode === "ingredients") {
      const sub = isSubHeading(raw);
      if (sub) continue; // ingredient sub-groups are listed together
      // Without headings, short lines that aren't sentences stay in the list ("squeeze of lemon").
      const listy = line.length <= 50 && !/[.!?]$/.test(line);
      if (hasHeadings || looksLikeIngredient(raw) || listy) {
        ingredients.push(...splitIngredient(line));
        continue;
      }
      // No headings, and this line isn't an ingredient: the steps have started.
      mode = "steps";
    }

    if (mode === "steps") {
      const sub = isSubHeading(raw);
      if (sub) {
        flush();
        groups.push((group = { section: titleCase(sub), steps: [] }));
        continue;
      }
      // A numbered or bulleted line starts a new step; plain lines continue a paragraph.
      if (line !== raw.trim() && paragraph.length) flush();
      paragraph.push(line);
      // Lines that end a sentence are steps of their own when the text has no blank lines between steps.
      if (/[.!?)]$/.test(line) && !lines[i + 1]?.match(/^[a-z]/)) flush();
      continue;
    }

    if (mode === "notes") {
      paragraph.push(line);
      if (/[.!?)]$/.test(line)) flush();
    }
  }
  flush();

  return {
    name: name || "New recipe",
    description: [...description, ...notes].join(" "),
    url: "",
    imageUrl: null,
    servings,
    yieldText: null,
    totalMinutes,
    ingredients,
    groups: groups.filter((g) => g.steps.length),
    categories: [],
    cuisines: [],
    keywords: [],
    diets: [],
    raw: null,
  };
}
