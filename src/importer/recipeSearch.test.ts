import { describe, expect, it } from "vitest";
import { ingredientNames, matchesSearch, searchTerms, searchText } from "./recipeSearch";

describe("recipe search", () => {
  const text = searchText({
    name: "Chana Masala",
    folder: "Recipes/Mains",
    frontmatter: {
      recipe: true,
      photo: "[[chana.jpg]]",
      tags: ["indian", "vegan"],
      source: { name: "Serious Eats", url: "https://www.seriouseats.com/chana-masala" },
      author: "Kenji",
      servings: 4,
    },
    ingredients: ingredientNames("Add @chickpeas{2%cans} and @garam masala{1%tsp}. Season with @salt."),
  });

  it("finds ingredients, tags, the source and other properties", () => {
    for (const q of ["chickpeas", "garam masala", "#vegan", "serious eats", "seriouseats.com", "kenji", "mains", "chana salt"]) {
      expect(matchesSearch(text, searchTerms(q)), q).toBe(true);
    }
  });

  it("needs every word, and skips the photo and marker", () => {
    expect(matchesSearch(text, searchTerms("chickpeas beef"))).toBe(false);
    expect(matchesSearch(text, searchTerms("jpg"))).toBe(false);
    expect(matchesSearch(text, searchTerms('"masala chickpeas"'))).toBe(false);
  });
});
