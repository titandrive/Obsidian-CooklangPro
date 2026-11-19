// A favorite heart and 1-5 rating stars, shown under the title in the Cooklang Editor's recipe view
// and on each card in the recipe browser. The heart toggles a "favorite" property. Clicking a star saves
// it as "rating"; clicking the current rating clears it.

import { App, TFile, setIcon } from "obsidian";

const ROW = "recipe-importer-rating";

export function readRating(app: App, file: TFile): number {
  const r = Number(app.metadataCache.getFileCache(file)?.frontmatter?.rating);
  return Number.isInteger(r) && r >= 1 && r <= 5 ? r : 0;
}

export function readFavorite(app: App, file: TFile): boolean {
  return app.metadataCache.getFileCache(file)?.frontmatter?.favorite === true;
}

async function setProperty(app: App, file: TFile, key: string, value: unknown) {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (value) fm[key] = value;
    else delete fm[key];
  });
}

function paintStars(row: HTMLElement, n: number) {
  row.querySelectorAll<HTMLElement>(".recipe-importer-rating-star").forEach((s, i) => s.toggleClass("is-filled", i < n));
}

function paintHeart(row: HTMLElement, on: boolean) {
  const heart = row.querySelector<HTMLElement>(".recipe-importer-favorite");
  if (!heart) return;
  heart.toggleClass("is-favorite", on);
  heart.setAttr("aria-pressed", String(on));
  heart.setAttr("aria-label", on ? "Remove from favorites" : "Add to favorites");
}

/** Keeps clicks on the heart and stars from also opening the card or note they sit in. */
function swallow(el: HTMLElement) {
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"]) {
    el.addEventListener(type, (evt) => evt.stopPropagation());
  }
}

export type RowParts = "both" | "heart" | "stars";

function buildRow(app: App, file: TFile, extraClass: string, parts: RowParts): HTMLElement {
  const row = createDiv({ cls: [ROW, extraClass].filter(Boolean) });
  row.dataset.path = file.path;
  row.dataset.parts = parts;
  swallow(row);

  if (parts !== "stars") {
    const heart = row.createEl("button", { cls: "recipe-importer-favorite clickable-icon" });
    setIcon(heart, "heart");
    heart.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const next = !readFavorite(app, file);
      paintHeart(row, next); // show it at once; the file change follows
      void setProperty(app, file, "favorite", next);
    });
  }
  if (parts === "heart") return row;

  const stars = row.createDiv({ cls: "recipe-importer-stars", attr: { role: "radiogroup", "aria-label": "Rating" } });
  for (let n = 1; n <= 5; n++) {
    const star = stars.createEl("button", { cls: "recipe-importer-rating-star clickable-icon", attr: { role: "radio" } });
    setIcon(star, "star");
    star.addEventListener("mouseenter", () => paintStars(row, n));
    star.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const next = readRating(app, file) === n ? 0 : n;
      paintStars(row, next);
      row.dataset.rating = String(next);
      void setProperty(app, file, "rating", next);
    });
  }
  stars.addEventListener("mouseleave", () => paintStars(row, Number(row.dataset.rating || 0)));
  return row;
}

/** Puts a heart-and-stars row for `file` inside `parent` (or updates the one there). Cheap to call often. */
export function ensureRatingRow(app: App, parent: HTMLElement, file: TFile, extraClass = "", parts: RowParts = "both"): HTMLElement {
  let row = parent.querySelector<HTMLElement>(`:scope > .${ROW}`);
  if (row && (row.dataset.path !== file.path || row.dataset.parts !== parts)) {
    row.remove();
    row = null;
  }
  if (!row) {
    row = buildRow(app, file, extraClass, parts);
    parent.appendChild(row);
  }
  paintHeart(row, readFavorite(app, file));
  const rating = readRating(app, file);
  row.dataset.rating = String(rating);
  row.querySelectorAll<HTMLElement>(".recipe-importer-rating-star").forEach((s, i) => {
    s.setAttr("aria-label", i + 1 === rating ? "Clear rating" : `Rate ${i + 1} star${i ? "s" : ""}`);
    s.setAttr("aria-checked", String(i + 1 === rating));
  });
  if (!row.querySelector(".recipe-importer-stars:hover")) paintStars(row, rating);
  return row;
}

/** The recipe view: the row goes at the end of the title block. */
export function syncRatingRow(app: App, container: HTMLElement, file: TFile | null) {
  const body = container.querySelector<HTMLElement>(".cook-hero-body");
  if (!body || !file) {
    container.querySelectorAll(`.${ROW}`).forEach((el) => el.remove());
    return;
  }
  ensureRatingRow(app, body, file);
}

/** Browser formula properties that get a clickable row, and which parts each shows. */
const BROWSER_PROPS: [string, RowParts][] = [
  ["formula.stars", "both"],
  ["formula.favorite_icon", "heart"],
  ["formula.rating_stars", "stars"],
];

/**
 * The recipe browser: on every card or table row that shows the stars formula, put a clickable row in
 * its place. Uses the view's own list of cards (items) or rows, which pairs each element with its file.
 */
export function syncBrowserRows(app: App, baseView: any, isRecipe: (f: TFile) => boolean) {
  const view = baseView?.controller?.view;
  const items: any[] | undefined = Array.isArray(view?.items) ? view.items : Array.isArray(view?.rows) ? view.rows : undefined;
  if (!items) return;
  for (const item of items) {
    const el: HTMLElement | undefined = item?.el;
    const file: TFile | undefined = item?.entry?.file;
    if (!el || !(file instanceof TFile) || !isRecipe(file)) continue;
    for (const [prop, parts] of BROWSER_PROPS) {
      const line = el.querySelector<HTMLElement>(
        `[data-property="${prop}"] .bases-cards-line, [data-property="${prop}"] .bases-table-cell`,
      );
      if (!line) continue;
      line.addClass("recipe-importer-has-row");
      ensureRatingRow(app, line, file, "is-compact", parts);
    }
  }
}
