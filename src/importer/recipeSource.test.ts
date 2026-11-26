import { describe, expect, it } from "vitest";
import { readSource, sourceValue } from "./recipeSource";

describe("recipe source", () => {
  it("reads links, names and both", () => {
    expect(readSource("https://a.com/x")).toEqual({ name: "", url: "https://a.com/x" });
    expect(readSource("Grandma")).toEqual({ name: "Grandma", url: "" });
    expect(readSource({ name: "A", url: "https://a.com" })).toEqual({ name: "A", url: "https://a.com" });
    expect(readSource(undefined)).toEqual({ name: "", url: "" });
  });
  it("stores the simplest form", () => {
    expect(sourceValue("", "a.com/x")).toBe("https://a.com/x");
    expect(sourceValue("Grandma", "")).toBe("Grandma");
    expect(sourceValue("A", "https://a.com")).toEqual({ name: "A", url: "https://a.com" });
    expect(sourceValue(" ", " ")).toBeNull();
  });
});
