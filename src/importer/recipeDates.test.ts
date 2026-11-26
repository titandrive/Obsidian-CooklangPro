import { describe, expect, it } from "vitest";
import { addedTime, localDate, withAdded } from "./recipeDates";

describe("recipe dates", () => {
  it("adds the date to the front matter once", () => {
    const md = '---\nrecipe: true\ntitle: "Soup"\n---\n\nBoil @water{1%l}.\n';
    const out = withAdded(md, "2026-11-26");
    expect(out).toBe('---\nrecipe: true\ntitle: "Soup"\nadded: 2026-11-26\n---\n\nBoil @water{1%l}.\n');
    expect(withAdded(out, "2027-01-01")).toBe(out);
  });

  it("reads the date, or falls back", () => {
    expect(localDate(new Date(addedTime("2026-11-26", 0)))).toBe("2026-11-26");
    expect(addedTime(undefined, 42)).toBe(42);
    expect(addedTime("soon", 42)).toBe(42);
  });
});
