// Diets set in the importer settings: a name and the tags that put a recipe in it. Used by the recipe browser's
// Filter menu and the Insights view.

export interface Diet { name: string; tags: string[] }

/** Tags as typed in settings ("#Vegan, plant-based") -> ["vegan", "plant-based"]. */
export const dietTags = (text: string): string[] =>
  text.split(/[,\s]+/).map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean);

/** Whether a recipe with these (lowercase) tags fits the diet: it has any of the diet's tags. */
export const fitsDiet = (diet: Diet, tags: string[]): boolean => diet.tags.some((t) => tags.includes(t));
