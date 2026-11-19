// Splitting an ingredient line ("2 1/2 cups (300 g) flour, sifted") into quantity, unit, name and note.

export interface Ingredient {
  line: string;
  qty: string | null; // Cooklang quantity: "2", "1/2", "1.5", "2-3"
  unit: string | null;
  name: string;
  note: string | null;
  optional: boolean;
}

const FRACTIONS: Record<string, string> = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
  "⅙": "1/6", "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

const UNITS: Record<string, string> = {
  cup: "cup", cups: "cup", c: "cup",
  tablespoon: "tbsp", tablespoons: "tbsp", tbsp: "tbsp", tbs: "tbsp", tbl: "tbsp", tb: "tbsp", T: "tbsp",
  teaspoon: "tsp", teaspoons: "tsp", tsp: "tsp", t: "tsp",
  ounce: "oz", ounces: "oz", oz: "oz",
  "fluid ounce": "fl oz", "fluid ounces": "fl oz", "fl oz": "fl oz",
  pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
  gram: "g", grams: "g", g: "g", gr: "g",
  kilogram: "kg", kilograms: "kg", kg: "kg",
  milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml", ml: "ml",
  liter: "l", liters: "l", litre: "l", litres: "l", l: "l",
  pint: "pint", pints: "pint", quart: "quart", quarts: "quart", gallon: "gallon", gallons: "gallon",
  clove: "cloves", cloves: "cloves",
  pinch: "pinch", pinches: "pinch", dash: "dash", dashes: "dash", squeeze: "squeeze", squeezes: "squeeze", splash: "splash",
  can: "can", cans: "can", jar: "jar", jars: "jar", package: "package", packages: "package", pkg: "package",
  packet: "packet", packets: "packet", bag: "bag", bags: "bag", box: "box", boxes: "box",
  stick: "stick", sticks: "stick", slice: "slices", slices: "slices", piece: "pieces", pieces: "pieces",
  bunch: "bunch", bunches: "bunch", sprig: "sprigs", sprigs: "sprigs", head: "head", heads: "head",
  stalk: "stalks", stalks: "stalks", handful: "handful", handfuls: "handful", knob: "knob",
  sheet: "sheets", sheets: "sheets", fillet: "fillets", fillets: "fillets", leaf: "leaves", leaves: "leaves",
};

const ADJECTIVES = new Set([
  "boneless", "skinless", "fresh", "frozen", "ripe", "raw", "cooked", "unsalted", "salted", "dry", "dried", "whole", "lean",
  "extra", "organic", "plain", "light", "dark", "low-sodium", "reduced-sodium", "firm", "extra-firm", "soft", "hot", "cold", "warm",
]);

const SIZE_WORDS = /^(extra[- ]large|large|medium|small|heaping|heaped|level|scant|generous|big)\b\s*/i;

function normFractions(s: string): string {
  return s
    .replace(/(\d)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_, d, f) => `${d} ${FRACTIONS[f]}`)
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (f) => FRACTIONS[f])
    .replace(/(\d)\s*⁄\s*(\d)/g, "$1/$2"); // fraction slash
}

/** "1 1/2" -> "1.5" (Cooklang has no mixed numbers); "1/2" stays a fraction. */
function cookQty(q: string): string {
  q = q.trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(q);
  if (mixed) {
    const v = +mixed[1] + +mixed[2] / +mixed[3];
    return String(Math.round(v * 100) / 100);
  }
  return q;
}

const NUM = String.raw`(?:\d+\s+\d+/\d+|\d+/\d+|\d+(?:\.\d+)?|\.\d+|(?:an|a|one|two|three|four|five|six)(?![a-z]))`;
const WORD_NUMS: Record<string, string> = { a: "1", an: "1", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6" };

/** Remove characters that would break Cooklang markup inside a name or note. */
export function safeMarkupText(s: string): string {
  return s.replace(/[@#~{}%()[\]|]/g, " ").replace(/--+/g, "-").replace(/\s+/g, " ").trim();
}

export function parseIngredient(rawLine: string): Ingredient {
  const line = rawLine.replace(/\s+/g, " ").trim();
  let s = normFractions(line)
    .replace(/^[-*•]\s*/, "")
    .replace(/\(?\s*\$\d+(?:\.\d+)?\s*\)?/g, " ") // Budget Bytes style prices
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const notes: string[] = [];
  let optional = false;

  if (/\boptional\b/i.test(s)) {
    optional = true;
    s = s.replace(/\(\s*optional\s*\)|,?\s*\boptional\b/gi, "").trim();
  }

  // Sizes like "2-inch" or '1 1/2"-long' describe the piece, not the amount.
  s = s.replace(/(?:^|\s)((?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*(?:"|”|''|-?inch(?:es)?\b|-?in\.|-?cm\b)(?:[- ](?:long|thick|wide|pieces?))?)/gi, (m, size: string) => {
    notes.push(size.replace(/\s+/g, " ").trim());
    return " ";
  }).trim();

  // Quantity, possibly a range ("2-3", "2 to 3").
  let qty: string | null = null;
  const qm = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|to|or)\s*(${NUM}))?\s*`, "i").exec(s);
  if (qm && (/^[\d.]/.test(qm[1]) || !/^(a|an)\s+(few|little|bit)\b/i.test(s))) {
    const a = WORD_NUMS[qm[1].toLowerCase()] ?? cookQty(qm[1]);
    const b = qm[2] ? WORD_NUMS[qm[2].toLowerCase()] ?? cookQty(qm[2]) : null;
    qty = b ? `${a}-${b}` : a;
    s = s.slice(qm[0].length);
  }

  // A parenthetical right after the quantity: "1 (28 oz) can", "2 cups (250 g)".
  const takeParen = () => {
    const pm = /^\(([^)]*)\)\s*/.exec(s);
    if (pm) {
      notes.push(pm[1].trim());
      s = s.slice(pm[0].length);
    }
  };
  takeParen();

  // Size words are notes, not units.
  const sm = SIZE_WORDS.exec(s);
  if (sm && qty) {
    notes.push(sm[1].toLowerCase());
    s = s.slice(sm[0].length);
  }

  // Unit.
  let unit: string | null = null;
  if (qty) {
    const um = /^(fl\.?\s*oz\.?|fluid ounces?|[a-zA-Z]+)\.?(?=[\s,(]|$)\s*/.exec(s);
    if (um) {
      const key = um[1].replace(/\./g, "").replace(/\s+/g, " ");
      const u = UNITS[key] ?? UNITS[key.toLowerCase()];
      if (u) {
        unit = u;
        s = s.slice(um[0].length);
        takeParen();
      }
    }
  }
  // "knob of ginger", "pinch of salt" with no number: one of that unit.
  if (!qty) {
    const um = /^([a-zA-Z]+)\s+of\s+/.exec(s);
    const u = um ? UNITS[um[1].toLowerCase()] : undefined;
    if (um && u) {
      qty = "1";
      unit = u;
      s = s.slice(um[0].length);
    }
  }
  s = s.replace(/^of\s+/i, "");

  // Remaining text: name, then ", note" or "(note)".
  // Name is everything before the first comma, except that "boneless, skinless chicken" keeps going.
  const parts = s.split(/\s*,\s*/);
  let name = parts.shift() ?? "";
  while (parts.length && name.split(/\s+/).every((w) => ADJECTIVES.has(w.toLowerCase()))) {
    name = `${name} ${parts.shift()}`;
  }
  if (parts.length) notes.push(parts.join(", "));
  name = name.replace(/\(([^)]*)\)/g, (_, inner) => {
    notes.push(inner.trim());
    return " ";
  });
  // "salt and pepper to taste": drop "to taste" (no quantity says that already).
  name = name.replace(/\b(to taste|as needed|for serving|for garnish)\b/gi, (m) => {
    notes.push(m.toLowerCase());
    return " ";
  });

  name = safeMarkupText(name).replace(/[.,;:]+$/, "");
  const note = safeMarkupText(notes.filter(Boolean).join(", ")).replace(/^,\s*|,\s*$/g, "") || null;
  return { line, qty, unit, name: name || safeMarkupText(line), note, optional };
}

/** Cooklang markup for an ingredient: @name{qty%unit}(note). */
export function ingredientMarkup(i: Ingredient, nameOverride?: string): string {
  const name = nameOverride ?? i.name;
  const q = i.qty ? (i.unit ? `${i.qty}%${i.unit}` : i.qty) : "";
  return `@${i.optional ? "?" : ""}${name}{${q}}${i.note ? `(${i.note})` : ""}`;
}
