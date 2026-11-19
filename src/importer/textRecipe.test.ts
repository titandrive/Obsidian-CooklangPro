import { describe, expect, it } from "vitest";
import { minutesIn, parseRecipeText } from "./textRecipe";
import { toCooklang } from "./converter";

describe("parseRecipeText", () => {
  it("reads a recipe without headings", () => {
    const r = parseRecipeText(`Easy Garlic Butter Green Beans
Serves 4, about 15 min

1 lb green beans, trimmed
2 tbsp butter
3 cloves garlic, minced
salt and pepper
squeeze of lemon

Boil the beans in salted water for 4 minutes, then drain.
Melt the butter in a skillet, add garlic and cook 1 minute.
Toss in the beans, season, and finish with lemon.`);
    expect(r.name).toBe("Easy Garlic Butter Green Beans");
    expect(r.servings).toBe(4);
    expect(r.totalMinutes).toBe(15);
    expect(r.ingredients).toEqual([
      "1 lb green beans, trimmed",
      "2 tbsp butter",
      "3 cloves garlic, minced",
      "salt",
      "pepper",
      "squeeze of lemon",
    ]);
    expect(r.groups[0].steps).toHaveLength(3);
  });

  it("reads headings, bullets, numbered steps and notes", () => {
    const r = parseRecipeText(`# Chocolate Chip Cookies

Chewy in the middle, crisp at the edges.

Prep time: 15 minutes
Total time: 1 hour 10 minutes
Makes 24

Ingredients:
- 2 1/4 cups flour
- 1 tsp baking soda
- 1 cup butter, softened
For the topping:
- flaky salt

Instructions
1. Heat the oven to 375F.
2. Whisk the flour and baking soda.
3. Beat the butter, then mix everything
   together until smooth.

Notes
The dough keeps for 3 days.`);
    expect(r.name).toBe("Chocolate Chip Cookies");
    expect(r.description).toContain("Chewy in the middle");
    expect(r.description).toContain("dough keeps");
    expect(r.totalMinutes).toBe(70);
    expect(r.servings).toBe(24);
    expect(r.ingredients).toEqual(["2 1/4 cups flour", "1 tsp baking soda", "1 cup butter, softened", "flaky salt"]);
    expect(r.groups[0].steps).toEqual([
      "Heat the oven to 375F.",
      "Whisk the flour and baking soda.",
      "Beat the butter, then mix everything together until smooth.",
    ]);
  });

  it("keeps step sections", () => {
    const r = parseRecipeText(`Bao
Ingredients
1 cup flour
Instructions
Dough:
Mix the flour with water.
Filling:
Cook the pork.`);
    expect(r.groups.map((g) => g.section)).toEqual(["Dough", "Filling"]);
  });

  it("converts to a Cooklang note with the ingredients marked", () => {
    const md = toCooklang(parseRecipeText(`Garlic Butter
2 tbsp butter
3 cloves garlic

Melt the butter and add the garlic.`));
    expect(md).toContain('title: "Garlic Butter"');
    expect(md).toContain("@butter{2%tbsp}");
    expect(md).toContain("@garlic{3%cloves}");
  });

  it("splits salt and pepper, and reads a squeeze of lemon", () => {
    const md = toCooklang(parseRecipeText(`Beans
1 lb green beans
salt and pepper to taste
a squeeze of lemon

Cook the beans. Season with salt and pepper and finish with lemon.`));
    expect(md).toContain("@salt{}");
    expect(md).toContain("@pepper{}");
    expect(md).toContain("@lemon{1%squeeze}");
  });
});

describe("minutesIn", () => {
  it("adds hours and minutes", () => {
    expect(minutesIn("1 hour 15 minutes")).toBe(75);
    expect(minutesIn("45 min")).toBe(45);
    expect(minutesIn("1.5 hrs")).toBe(90);
    expect(minutesIn("no time")).toBeNull();
  });
});
