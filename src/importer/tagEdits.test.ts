import { describe, expect, it } from "vitest";
import { applyTagStates, initialStates, normalizeTag, readTags, tagsChanged } from "./tagEdits";

describe("normalizeTag", () => {
  it("matches the recipes' tag style", () => {
    expect(normalizeTag("#Slow Cooker")).toBe("slow-cooker");
    expect(normalizeTag("  middle eastern ")).toBe("middle-eastern");
    expect(normalizeTag("a,b!")).toBe("ab");
    expect(normalizeTag("#")).toBe("");
    expect(normalizeTag("diet/vegan")).toBe("diet/vegan");
  });
});

describe("readTags", () => {
  it("reads lists and strings", () => {
    expect(readTags(["thai", "#chicken", "thai"])).toEqual(["thai", "chicken"]);
    expect(readTags("thai, chicken")).toEqual(["thai", "chicken"]);
    expect(readTags(undefined)).toEqual([]);
  });
});

describe("tag edits", () => {
  const lists = [["thai", "chicken"], ["thai", "vegan"], ["soup"]];

  it("counts how many recipes have each tag", () => {
    expect(initialStates(lists).map((s) => [s.name, s.count])).toEqual([
      ["thai", 2],
      ["chicken", 1],
      ["vegan", 1],
      ["soup", 1],
    ]);
  });

  it("renames, removes and adds across recipes", () => {
    const states = initialStates(lists);
    states.find((s) => s.name === "thai")!.name = "thai-food";
    states.find((s) => s.name === "vegan")!.removed = true;
    states.push({ original: null, name: "weeknight", removed: false, toAll: true, count: 0 });
    expect(lists.map((l) => applyTagStates(l, states))).toEqual([
      ["thai-food", "chicken", "weeknight"],
      ["thai-food", "weeknight"],
      ["soup", "weeknight"],
    ]);
  });

  it("adds a tag some recipes have to all of them, without duplicates", () => {
    const states = initialStates(lists);
    states.find((s) => s.name === "thai")!.toAll = true;
    expect(lists.map((l) => applyTagStates(l, states))).toEqual([
      ["thai", "chicken"],
      ["thai", "vegan"],
      ["soup", "thai"],
    ]);
  });

  it("merges a tag renamed to one the recipe already has", () => {
    const states = initialStates([["chicken", "poultry"]]);
    states.find((s) => s.name === "poultry")!.name = "chicken";
    expect(applyTagStates(["chicken", "poultry"], states)).toEqual(["chicken"]);
  });

  it("knows when nothing changed", () => {
    const states = initialStates(lists);
    expect(tagsChanged(lists, states)).toBe(false);
    states[0].removed = true;
    expect(tagsChanged(lists, states)).toBe(true);
  });
});
