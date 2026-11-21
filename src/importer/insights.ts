// The Insights view: a Bases view type that summarizes the recipes the base shows (so its filters and search
// narrow it too). Modelled on the Daily Journal plugin's Trends view: sections of number tiles and cards with bar
// lists. Reads each recipe's properties from its front matter and its ingredients from its text.

import { BasesView, QueryController, TFile, setIcon } from "obsidian";
import { minutesIn } from "./textRecipe";
import { type Diet, fitsDiet } from "./diets";

export const INSIGHTS_VIEW = "recipe-insights";

type Frontmatter = Record<string, unknown>;
interface Recipe { file: TFile; fm: Frontmatter; minutes: number | null; rating: number | null; tags: string[]; ingredients: string[] }
/** A bar. Clicking it runs `pick`, or else lists `files` to open one. */
interface Row { label: string; value: number; text: string; hint?: string; files?: TFile[]; pick?: () => void }

/** What a click in the view can do: open a recipe, show a folder or tag in its browser view, or switch views. */
export interface InsightActions {
  open(file: TFile): void;
  show(kind: "folder" | "tag", value: string): void;
  /** Narrow the All recipes view to these recipes, labelled (for the toolbar chip) with `label`. */
  filter(label: string, files: TFile[]): void;
  view(name: string): void;
  /** The diets set in settings. */
  diets(): Diet[];
}

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

/** Recipes grouped by each value `keys` gives them, biggest group first, with each group's recipes. */
function rankedRecipes(recipes: Recipe[], keys: (r: Recipe) => string[], limit: number): Row[] {
  const groups = new Map<string, TFile[]>();
  for (const r of recipes) for (const k of new Set(keys(r))) if (k) groups.set(k, [...(groups.get(k) ?? []), r.file]);
  return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, limit)
    .map(([label, files]) => ({ label, value: files.length, text: String(files.length), files }));
}

export class RecipeInsightsView extends BasesView {
  type = INSIGHTS_VIEW;

  constructor(controller: QueryController, private el: HTMLElement, private actions: InsightActions) {
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
        tile(label: string, value: string, hint?: string, icon?: string, onClick?: (evt: MouseEvent) => void): HTMLElement {
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
          return t;
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
    overview.tile("Recipes", String(recipes.length), `in ${plural(folders.size, "folder")}`, undefined, () => this.actions.view("All recipes"));
    overview.tile("Favorites", String(favorites.length), undefined, "heart", () => this.actions.view("Favorites"));
    if (rated.length) overview.tile("Average rating", `${one(rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length)} ★`, `${rated.length} rated`, undefined, () => this.actions.view("Top rated"));
    if (timed.length) overview.tile("Typical time", shortTime(median(timed.map((r) => r.minutes!))), `median of ${timed.length}`);
    // With some missing, the tile lists the recipes without a photo; pick one to open it.
    const noPhoto = recipes.filter((r) => !r.fm.photo);
    overview.tile("With photos", `${Math.round((100 * withPhoto.length) / recipes.length)}%`,
      noPhoto.length ? `${noPhoto.length} missing · show` : `${withPhoto.length} of ${recipes.length}`, undefined,
      noPhoto.length ? () => this.actions.filter("No photo", noPhoto.map((r) => r.file)) : undefined);

    // Collection
    const collection = section("Collection");
    // Folders and tags open their browser view with that folder or tag picked.
    const byFolder = rankedRecipes(recipes, (r) => [r.file.parent?.path ?? ""], 20)
      .map((row) => ({ ...row, label: row.label.split("/").pop() ?? row.label, pick: () => this.actions.show("folder", row.label) }));
    if (byFolder.length > 1) this.bars(collection.card("By folder"), byFolder);
    const topTags = rankedRecipes(recipes, (r) => r.tags, 10).map((row) => ({ ...row, pick: () => this.actions.show("tag", row.label) }));
    if (topTags.length) this.bars(collection.card("Top tags"), topTags);
    // Diets from settings, each a set of tags. A recipe can fit more than one.
    const diets = this.actions.diets().map((d) => ({ diet: d, files: recipes.filter((r) => fitsDiet(d, r.tags)).map((r) => r.file) }));
    if (diets.some((d) => d.files.length)) {
      const pct = (n: number) => `${n} · ${Math.round((100 * n) / recipes.length)}%`;
      this.bars(collection.card("Diet", "From tags"),
        diets.map(({ diet, files }) => ({ label: diet.name.trim(), value: files.length, text: pct(files.length), files })));
    }

    // Ratings
    const ratings = section("Ratings");
    if (rated.length) {
      const stars: Row[] = [5, 4, 3, 2, 1].map((s) => {
        const files = rated.filter((r) => Math.round(r.rating!) === s).map((r) => r.file);
        return { label: "★".repeat(s), value: files.length, text: String(files.length), files };
      });
      const unrated = recipes.filter((r) => !(r.rating !== null && r.rating > 0)).map((r) => r.file);
      stars.push({ label: "Not rated", value: unrated.length, text: String(unrated.length), files: unrated });
      this.bars(ratings.card("Ratings"), stars);
      const best = [...rated].sort((a, b) => b.rating! - a.rating! || a.file.basename.localeCompare(b.file.basename)).slice(0, 6);
      recipeList(ratings.card("Top rated"), best.map((r) => ({ file: r.file, text: "★".repeat(Math.round(r.rating!)) })), this.actions.open);
    }
    if (favorites.length) {
      recipeList(ratings.card("Favorites", undefined, "heart"), favorites.map((r) => ({ file: r.file, text: r.rating ? "★".repeat(Math.round(r.rating)) : "" })), this.actions.open);
    }

    // Time
    const time = section("Time");
    if (timed.length) {
      const band = (lo: number, hi: number) => timed.filter((r) => r.minutes! >= lo && r.minutes! < hi).map((r) => r.file);
      const bands: Row[] = ([
        ["Under 15 min", 0, 15], ["15–30 min", 15, 30], ["30–60 min", 30, 60], ["1–2 hours", 60, 120], ["2 hours+", 120, 1e9],
      ] as Array<[string, number, number]>).map(([label, lo, hi]) => {
        const files = band(lo, hi);
        return { label, value: files.length, text: String(files.length), files };
      });
      this.bars(time.card("Cooking time", `${timed.length} recipes with a time`), bands);
      const quickest = [...timed].sort((a, b) => a.minutes! - b.minutes! || a.file.basename.localeCompare(b.file.basename)).slice(0, 6);
      recipeList(time.card("Quickest"), quickest.map((r) => ({ file: r.file, text: shortTime(r.minutes!) })), this.actions.open);
    }

    // Ingredients
    const ingredients = section("Ingredients");
    const common = rankedRecipes(recipes, (r) => r.ingredients, 12);
    const counts = recipes.map((r) => r.ingredients.length).filter((n) => n > 0);
    if (common.length) this.bars(ingredients.card("Most used", "Recipes using each"), common);
    if (counts.length) {
      const fewest = [...recipes].filter((r) => r.ingredients.length).sort((a, b) => a.ingredients.length - b.ingredients.length).slice(0, 6);
      recipeList(ingredients.card("Fewest ingredients"), fewest.map((r) => ({ file: r.file, text: plural(r.ingredients.length, "ingredient") })), this.actions.open);
    }

    // Sources
    const sources = section("Sources");
    const site = (r: Recipe) => {
      try {
        return typeof r.fm.source === "string" ? new URL(r.fm.source).hostname.replace(/^www\./, "") : "";
      } catch {
        return "";
      }
    };
    const sites = recipes.map(site);
    const topSites = rankedRecipes(recipes, (r) => [site(r)], 8);
    if (topSites.length) {
      // "Websites" sits beside its number.
      sources.tile("Websites", String(new Set(sites.filter(Boolean)).size), `${sites.filter(Boolean).length} recipes with a link`)
        .addClass("is-inline-label");
      // Like With photos: when some have no link, the tile lists them.
      const noLink = recipes.filter((r) => !site(r));
      sources.tile("Without a link", String(noLink.length), noLink.length ? "show" : undefined, undefined,
        noLink.length ? () => this.actions.filter("No source", noLink.map((r) => r.file)) : undefined);
      this.bars(sources.card("Top sources"), topSites);
    }

    for (const s of [overview, collection, ratings, time, ingredients, sources]) {
      if (!s.el.querySelector(".cooklang-insights-tile, .cooklang-insights-card")) s.el.remove();
    }
  }

  /**
   * Bars that can be clicked: a row's `pick`, or else All recipes narrowed to the row's recipes. `label` turns a
   * row into the filter's name ("garlic", "★★★", "Under 15 min"); by default it's the row's own label.
   */
  private bars(el: HTMLElement, rows: Row[], label: (row: Row) => string = (row) => row.label): void {
    barList(el, rows, (row) => {
      if (row.pick) return row.pick();
      if (row.files?.length) this.actions.filter(label(row), row.files);
    });
  }
}

/** Labelled horizontal bars; the largest value fills the track. Rows with something to show are clickable. */
function barList(el: HTMLElement, rows: Row[], onClick?: (row: Row) => void): void {
  const top = Math.max(1, ...rows.map((r) => r.value));
  const list = el.createDiv({ cls: "cooklang-insights-bars" });
  for (const r of rows) {
    const clickable = !!onClick && (!!r.pick || !!r.files?.length);
    const row = list.createDiv({ cls: "cooklang-insights-bar-row" + (clickable ? " is-clickable" : ""), attr: r.hint ? { "aria-label": r.hint } : {} });
    row.createDiv({ cls: "cooklang-insights-bar-label", text: r.label });
    row.createDiv({ cls: "cooklang-insights-bar-track" }).createDiv({ cls: "cooklang-insights-bar-fill" }).style.width = `${Math.max(2, (100 * r.value) / top)}%`;
    row.createDiv({ cls: "cooklang-insights-bar-value", text: r.text });
    if (clickable) {
      for (const cell of Array.from(row.children) as HTMLElement[]) {
        cell.addEventListener("click", () => onClick!(r));
      }
    }
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
