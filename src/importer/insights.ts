// The Insights view: a Bases view type that summarizes the recipes the base shows (so its filters and search
// narrow it too). Modelled on the Daily Journal plugin's Trends view: sections of number tiles and cards with bar
// lists. Reads each recipe's properties from its front matter and its ingredients from its text.

import { BasesView, Menu, QueryController, TFile, setIcon } from "obsidian";
import { minutesIn } from "./textRecipe";

export const INSIGHTS_VIEW = "recipe-insights";

type Frontmatter = Record<string, unknown>;
interface Recipe { file: TFile; fm: Frontmatter; minutes: number | null; rating: number | null; tags: string[]; ingredients: string[] }
interface Row { label: string; value: number; text: string; hint?: string; file?: TFile }

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const one = (n: number) => (Math.round(n * 10) / 10).toString();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** "75 minutes" -> "1h 15m". */
const shortTime = (m: number) => {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};

/** Ingredient names in a Cooklang recipe body: @name{...} or @word. */
export function ingredientNames(body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(/@([^@#~{}\n]+?)\{|@([\p{L}\p{N}_-]+)/gu)) {
    const name = (m[1] ?? m[2] ?? "").replace(/^\?/, "").trim().toLowerCase();
    if (name) names.add(name);
  }
  return [...names];
}

/** Values counted, most frequent first. */
function ranked(values: string[], limit: number): Row[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
    .map(([label, n]) => ({ label, value: n, text: String(n) }));
}

export class RecipeInsightsView extends BasesView {
  type = INSIGHTS_VIEW;

  constructor(controller: QueryController, private el: HTMLElement, private openRecipe: (file: TFile) => void) {
    super(controller);
    el.addClass("cooklang-insights-host");
  }

  onDataUpdated(): void {
    void this.collect();
  }

  private async collect(): Promise<void> {
    const recipes: Recipe[] = [];
    for (const entry of this.data.data) {
      const file = entry.file;
      if (!(file instanceof TFile) || file.extension !== "md") continue;
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Frontmatter;
      if (fm.recipe !== true) continue;
      const text = await this.app.vault.cachedRead(file);
      const body = text.replace(/^---[\s\S]*?\n---/, "");
      const tags = (Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(/[,\s]+/) : [])
        .map((t) => String(t).replace(/^#/, "").trim().toLowerCase()).filter(Boolean);
      recipes.push({
        file, fm, tags,
        minutes: typeof fm.time === "string" || typeof fm.time === "number" ? minutesIn(String(fm.time)) : null,
        rating: num(fm.rating),
        ingredients: ingredientNames(body),
      });
    }
    this.render(recipes);
  }

  private render(recipes: Recipe[]): void {
    const el = this.el;
    el.empty();
    const root = el.createDiv({ cls: "cooklang-insights" });
    if (!recipes.length) {
      root.createDiv({ cls: "cooklang-insights-empty", text: "No recipes match this view's search or filters." });
      return;
    }

    const section = (title: string) => {
      const sec = root.createDiv({ cls: "cooklang-insights-section" });
      sec.createDiv({ cls: "cooklang-insights-section-title", text: title });
      let tiles: HTMLElement | null = null, grid: HTMLElement | null = null;
      return {
        el: sec,
        /** `icon`: a small icon before the label. `onClick`: the tile becomes a button. */
        tile(label: string, value: string, hint?: string, icon?: string, onClick?: (evt: MouseEvent) => void) {
          tiles ??= sec.createDiv({ cls: "cooklang-insights-tiles" });
          const t = tiles.createDiv({ cls: "cooklang-insights-tile" });
          t.createDiv({ cls: "cooklang-insights-tile-value", text: value });
          const l = t.createDiv({ cls: "cooklang-insights-tile-label" });
          if (icon) setIcon(l.createSpan({ cls: `cooklang-insights-icon is-${icon}` }), icon);
          l.createSpan({ text: label });
          if (hint) t.createDiv({ cls: "cooklang-insights-tile-hint", text: hint });
          if (onClick) {
            t.addClass("is-clickable");
            t.setAttr("role", "button");
            t.setAttr("tabindex", "0");
            t.addEventListener("click", onClick);
            t.addEventListener("keydown", (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                const r = t.getBoundingClientRect();
                onClick(new MouseEvent("click", { clientX: r.left, clientY: r.bottom }));
              }
            });
          }
        },
        card(title: string, note?: string, icon?: string) {
          grid ??= sec.createDiv({ cls: "cooklang-insights-grid" });
          const c = grid.createDiv({ cls: "cooklang-insights-card" });
          const head = c.createDiv({ cls: "cooklang-insights-card-head" });
          const t = head.createDiv({ cls: "cooklang-insights-card-title" });
          if (icon) setIcon(t.createSpan({ cls: `cooklang-insights-icon is-${icon}` }), icon);
          t.createSpan({ text: title });
          if (note) head.createDiv({ cls: "cooklang-insights-card-note", text: note });
          return c;
        },
      };
    };

    const rated = recipes.filter((r) => r.rating !== null && r.rating > 0);
    const timed = recipes.filter((r) => r.minutes !== null && r.minutes > 0);
    const favorites = recipes.filter((r) => r.fm.favorite === true);
    const withPhoto = recipes.filter((r) => !!r.fm.photo);
    const folders = new Set(recipes.map((r) => r.file.parent?.path ?? ""));

    // Overview
    const overview = section("Overview");
    overview.tile("Recipes", String(recipes.length), `in ${plural(folders.size, "folder")}`);
    overview.tile("Favorites", String(favorites.length), undefined, "heart");
    if (rated.length) overview.tile("Average rating", `${one(rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length)} ★`, `${rated.length} rated`);
    if (timed.length) overview.tile("Typical time", shortTime(median(timed.map((r) => r.minutes!))), `median of ${timed.length}`);
    // With some missing, the tile lists the recipes without a photo; pick one to open it.
    const noPhoto = recipes.filter((r) => !r.fm.photo);
    overview.tile("With photos", `${Math.round((100 * withPhoto.length) / recipes.length)}%`,
      noPhoto.length ? `${noPhoto.length} missing · show` : `${withPhoto.length} of ${recipes.length}`, undefined,
      noPhoto.length ? (evt) => {
        const menu = new Menu();
        menu.addItem((i) => i.setTitle(`${plural(noPhoto.length, "recipe")} without a photo`).setIsLabel(true));
        for (const r of noPhoto) menu.addItem((i) => i.setTitle(r.file.basename).setIcon("image-off").onClick(() => this.openRecipe(r.file)));
        menu.showAtMouseEvent(evt);
      } : undefined);

    // Collection
    const collection = section("Collection");
    const byFolder = ranked(recipes.map((r) => r.file.parent?.name ?? ""), 20);
    if (byFolder.length > 1) barList(collection.card("By folder"), byFolder);
    const topTags = ranked(recipes.flatMap((r) => r.tags), 10);
    if (topTags.length) barList(collection.card("Top tags"), topTags);
    const vegan = recipes.filter((r) => r.tags.includes("vegan")).length;
    const vegetarian = recipes.filter((r) => !r.tags.includes("vegan") && r.tags.includes("vegetarian")).length;
    if (vegan || vegetarian) {
      const other = recipes.length - vegan - vegetarian;
      barList(collection.card("Diet", "From tags"), [
        { label: "Vegan", value: vegan, text: `${vegan} · ${Math.round((100 * vegan) / recipes.length)}%` },
        { label: "Vegetarian", value: vegetarian, text: `${vegetarian} · ${Math.round((100 * vegetarian) / recipes.length)}%` },
        { label: "Other", value: other, text: `${other} · ${Math.round((100 * other) / recipes.length)}%` },
      ]);
    }

    // Ratings
    const ratings = section("Ratings");
    if (rated.length) {
      const stars = [5, 4, 3, 2, 1].map((s) => {
        const n = rated.filter((r) => Math.round(r.rating!) === s).length;
        return { label: "★".repeat(s), value: n, text: String(n) };
      });
      stars.push({ label: "Not rated", value: recipes.length - rated.length, text: String(recipes.length - rated.length) });
      barList(ratings.card("Ratings"), stars);
      const best = [...rated].sort((a, b) => b.rating! - a.rating! || a.file.basename.localeCompare(b.file.basename)).slice(0, 6);
      recipeList(ratings.card("Top rated"), best.map((r) => ({ file: r.file, text: "★".repeat(Math.round(r.rating!)) })), this.openRecipe);
    }
    if (favorites.length) {
      recipeList(ratings.card("Favorites", undefined, "heart"), favorites.map((r) => ({ file: r.file, text: r.rating ? "★".repeat(Math.round(r.rating)) : "" })), this.openRecipe);
    }

    // Time
    const time = section("Time");
    if (timed.length) {
      const band = (lo: number, hi: number) => timed.filter((r) => r.minutes! >= lo && r.minutes! < hi).length;
      const bands: Row[] = [
        ["Under 15 min", 0, 15], ["15–30 min", 15, 30], ["30–60 min", 30, 60], ["1–2 hours", 60, 120], ["2 hours+", 120, 1e9],
      ].map(([label, lo, hi]) => ({ label: String(label), value: band(Number(lo), Number(hi)), text: String(band(Number(lo), Number(hi))) }));
      barList(time.card("Cooking time", `${timed.length} recipes with a time`), bands);
      const quickest = [...timed].sort((a, b) => a.minutes! - b.minutes! || a.file.basename.localeCompare(b.file.basename)).slice(0, 6);
      recipeList(time.card("Quickest"), quickest.map((r) => ({ file: r.file, text: shortTime(r.minutes!) })), this.openRecipe);
    }

    // Ingredients
    const ingredients = section("Ingredients");
    const common = ranked(recipes.flatMap((r) => r.ingredients), 12);
    const counts = recipes.map((r) => r.ingredients.length).filter((n) => n > 0);
    if (counts.length) {
      ingredients.tile("Typical ingredient count", String(Math.round(median(counts))), "per recipe");
      ingredients.tile("Different ingredients", String(new Set(recipes.flatMap((r) => r.ingredients)).size));
    }
    if (common.length) barList(ingredients.card("Most used", "Recipes using each"), common);
    if (counts.length) {
      const fewest = [...recipes].filter((r) => r.ingredients.length).sort((a, b) => a.ingredients.length - b.ingredients.length).slice(0, 6);
      recipeList(ingredients.card("Fewest ingredients"), fewest.map((r) => ({ file: r.file, text: plural(r.ingredients.length, "ingredient") })), this.openRecipe);
    }

    // Sources
    const sources = section("Sources");
    const sites = recipes.map((r) => {
      try {
        return typeof r.fm.source === "string" ? new URL(r.fm.source).hostname.replace(/^www\./, "") : "";
      } catch {
        return "";
      }
    });
    const topSites = ranked(sites, 8);
    if (topSites.length) {
      sources.tile("Websites", String(new Set(sites.filter(Boolean)).size), `${sites.filter(Boolean).length} recipes with a link`);
      sources.tile("Without a link", String(sites.filter((s) => !s).length));
      barList(sources.card("Top sources"), topSites);
    }

    for (const s of [overview, collection, ratings, time, ingredients, sources]) {
      if (!s.el.querySelector(".cooklang-insights-tile, .cooklang-insights-card")) s.el.remove();
    }
  }
}

/** Labelled horizontal bars; the largest value fills the track. */
function barList(el: HTMLElement, rows: Row[]): void {
  const top = Math.max(1, ...rows.map((r) => r.value));
  const list = el.createDiv({ cls: "cooklang-insights-bars" });
  for (const r of rows) {
    const row = list.createDiv({ cls: "cooklang-insights-bar-row", attr: r.hint ? { "aria-label": r.hint } : {} });
    row.createDiv({ cls: "cooklang-insights-bar-label", text: r.label });
    row.createDiv({ cls: "cooklang-insights-bar-track" }).createDiv({ cls: "cooklang-insights-bar-fill" }).style.width = `${Math.max(2, (100 * r.value) / top)}%`;
    row.createDiv({ cls: "cooklang-insights-bar-value", text: r.text });
  }
}

/** A list of recipes, each name opening the recipe, with a short note on the right. */
function recipeList(el: HTMLElement, rows: Array<{ file: TFile; text: string }>, open: (file: TFile) => void): void {
  const list = el.createDiv({ cls: "cooklang-insights-list" });
  for (const r of rows) {
    const row = list.createDiv({ cls: "cooklang-insights-list-row" });
    const link = row.createEl("a", { cls: "cooklang-insights-link", text: r.file.basename, attr: { href: "#" } });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      open(r.file);
    });
    row.createSpan({ cls: "cooklang-insights-muted", text: r.text });
  }
}
