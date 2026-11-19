import { App, Component, Menu, Modal, Notice, Platform, Plugin, Setting, TFile, TFolder, WorkspaceLeaf, normalizePath, requestUrl, setIcon } from "obsidian";
import { RecipeData, findRecipeJsonLd, normalizeRecipe } from "./recipe";
import { DEFAULT_FOLDERS, guessFolder, safeFileName, toCooklang } from "./converter";
import { CLAUDE_MODELS, DEFAULT_MODEL, type ClaudeProgress, checkKey, convertWithClaude, describeError } from "./claude";
import { parseRecipeText } from "./textRecipe";
import { syncBrowserRows } from "./rating";
import { PhotoModal, resizePhoto } from "./PhotoModal";

export interface ImporterSettings {
  recipesFolder: string;
  apiKey: string;
  model: string;
  openAfterImport: boolean;
  saveImage: boolean;
  /** Where downloaded photos go: next to the recipe, or into `photosFolder`. */
  photoLocation: "beside" | "folder";
  /** Vault path of the photos folder when `photoLocation` is "folder", e.g. "Recipes/Photos". */
  photosFolder: string;
  /** What the recipe browser's cards show, set from its "Show" toolbar menu. */
  cardShow: { heart: boolean; stars: boolean; time: boolean; servings: boolean };
  /** Clicking a recipe in the recipe browser opens it in a new tab instead of the browser's tab. */
  browserNewTab: boolean;
  /** Use Claude when there's an API key; switched in the import dialog. */
  useClaude: boolean;
}

export const DEFAULT_IMPORTER_SETTINGS: ImporterSettings = {
  recipesFolder: "Recipes",
  apiKey: "",
  model: DEFAULT_MODEL,
  openAfterImport: true,
  saveImage: true,
  photoLocation: "folder",
  photosFolder: "Recipes/Photos",
  cardShow: { heart: true, stars: true, time: true, servings: true },
  browserNewTab: true,
  useClaude: true,
};

/** What the importer needs from the CooklangPro plugin. */
export interface ImporterHost extends Plugin {
  settings: { importer?: Partial<ImporterSettings> };
  saveSettings(): Promise<void>;
  openAsRecipe(leaf: WorkspaceLeaf, file: TFile): Promise<void>;
}

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

interface Page {
  url: string;
  html: string;
  recipe: RecipeData | null;
  /** The recipe data has ingredients or steps. */
  usable: boolean;
  /** Recipe text pasted by the user, instead of a web page. */
  text?: string;
}

interface Prepared {
  url: string;
  recipe: RecipeData | null;
  markdown: string;
  method: "claude" | "rules";
  /** The folder Claude picked, if any. */
  folder?: string | null;
}

/** An Obsidian base listing every recipe note (recipe: true), with photo cards and a table. */
function recipeBaseContent(): string {
  // Compact cards: the name, "30 minutes · 6 servings", and tags. The heart and stars are overlaid on the
  // photo and the property labels hidden by the plugin (see syncBrowser and the styles).
  const cardProps = ["file.name", "formula.details", "note.tags"];
  const cards = (name: string, extra: string[] = [], sort: [string, string][] = [["file.name", "ASC"]]) => [
    "  - type: cards",
    `    name: ${name}`,
    ...extra,
    "    image: note.photo",
    "    cardSize: 200",
    "    order:",
    ...cardProps.map((p) => `      - ${p}`),
    "    sort:",
    ...sort.flatMap(([prop, dir]) => [`      - property: ${prop}`, `        direction: ${dir}`]),
  ];
  return [
    "filters:",
    "  and:",
    "    - recipe == true",
    '    - file.ext == "md"',
    "formulas:",
    // A red heart for favorites, then one filled star per rating point. Styled by styles.css.
    `  stars: 'if(favorite == true, [icon("heart")], []) + [1,2,3,4,5].filter(value <= number(rating)).map(icon("star"))'`,
    // The table shows them as separate Favorite and Rating columns.
    `  details: 'if(time, time, "") + if(time && servings, " · ", "") + if(servings, servings + if(servings == 1, " serving", " servings"), "")'`,
    `  favorite_icon: 'if(favorite == true, [icon("heart")], [])'`,
    `  rating_stars: '[1,2,3,4,5].filter(value <= number(rating)).map(icon("star"))'`,
    "properties:",
    "  file.name:",
    "    displayName: Recipe",
    "  file.folder:",
    "    displayName: Folder",
    "  formula.details:",
    "    displayName: Details",
    "  formula.stars:",
    "    displayName: Rating",
    "  formula.favorite_icon:",
    "    displayName: Favorite",
    "  formula.rating_stars:",
    "    displayName: Rating",
    "  note.favorite:",
    "    displayName: Favorite",
    "  note.rating:",
    "    displayName: Rating",
    "  note.time:",
    "    displayName: Time",
    "  note.servings:",
    "    displayName: Servings",
    "  note.tags:",
    "    displayName: Tags",
    "  note.source:",
    "    displayName: Source",
    "views:",
    ...cards("All recipes", ["    icon: chef-hat"]),
    ...cards("By folder", ["    icon: folder", "    groupBy:", "      property: file.folder", "      direction: ASC"]),
    ...cards("Favorites", ["    icon: heart", "    filters:", "      and:", "        - favorite == true"]),
    ...cards("Top rated", ["    icon: star", "    filters:", "      and:", "        - rating >= 4"], [["note.rating", "DESC"], ["file.name", "ASC"]]),
    "  - type: table",
    "    name: Table",
    "    icon: table",
    "    columnSize:",
    "      formula.favorite_icon: 115",
    "      formula.rating_stars: 130",
    "    groupBy:",
    "      property: file.folder",
    "      direction: ASC",
    "    order:",
    "      - file.name",
    "      - formula.favorite_icon",
    "      - formula.rating_stars",
    "      - note.time",
    "      - note.servings",
    "      - note.tags",
    "      - note.source",
    "    sort:",
    "      - property: file.name",
    "        direction: ASC",
    "",
  ].join("\n");
}

/** Visible text of a page, for sites that have no structured recipe data. */
function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recipe import, the recipe browser, favorites and ratings, and clickable tags.
 * A component of CooklangPro.
 */
export class RecipeImporter extends Component {
  readonly app: App;
  readonly host: ImporterHost;
  settings: ImporterSettings;

  constructor(host: ImporterHost) {
    super();
    this.host = host;
    this.app = host.app;
    // Fill in defaults for settings saved by older versions.
    this.settings = Object.assign({}, DEFAULT_IMPORTER_SETTINGS, host.settings.importer ?? {});
    this.settings.cardShow = Object.assign({}, DEFAULT_IMPORTER_SETTINGS.cardShow, this.settings.cardShow ?? {});
    host.settings.importer = this.settings;
  }

  async saveSettings() {
    await this.host.saveSettings();
  }

  onload() {
    this.host.addCommand({
      id: "import-recipe-from-url",
      name: "Import recipe",
      callback: () => new ImportModal(this.app, this).open(),
    });
    this.host.addRibbonIcon("chef-hat", "Import recipe", () => new ImportModal(this.app, this).open());
    this.host.addCommand({
      id: "set-recipe-photo",
      name: "Set recipe photo",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isRecipe(file)) return false;
        if (!checking) this.openPhotoModal(file);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !this.isRecipe(file)) return;
        menu.addItem((item) => item.setTitle("Set recipe photo").setIcon("image").onClick(() => this.openPhotoModal(file)));
      }),
    );
    this.host.addCommand({
      id: "open-recipe-browser",
      name: "Open recipe browser",
      callback: () => void this.openRecipeBrowser(),
    });
    // Clickable heart and stars on the recipe browser's cards and table rows. Obsidian draws those, so
    // they're added to its views; the recipe view has them built in (ui/components/RecipeMarks.svelte).
    this.registerEvent(this.app.workspace.on("layout-change", () => this.watchBrowsers()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshBrowsers()));
    this.app.workspace.onLayoutReady(() => this.watchBrowsers());
  }

  isRecipe(file: TFile): boolean {
    if (file.extension === "cook") return true;
    return file.extension === "md" && this.app.metadataCache.getFileCache(file)?.frontmatter?.recipe === true;
  }

  private watchedViews = new WeakSet<object>();

  /** The browser re-renders often, so watch each one and put the rows back whenever they're missing. */
  private watchBrowsers() {
    for (const leaf of this.app.workspace.getLeavesOfType("bases")) {
      const view = leaf.view as any;
      const el: HTMLElement | undefined = view.containerEl;
      if (!el) continue;
      if (!this.watchedViews.has(view)) {
        this.watchedViews.add(view);
        let queued = false;
        const observer = new MutationObserver(() => {
          if (queued) return;
          queued = true;
          window.requestAnimationFrame(() => {
            queued = false;
            this.syncBrowser(view);
          });
        });
        observer.observe(el, { childList: true, subtree: true });
        this.register(() => observer.disconnect());
      }
      this.syncBrowser(view);
    }
  }

  private refreshBrowsers() {
    for (const leaf of this.app.workspace.getLeavesOfType("bases")) this.syncBrowser(leaf.view);
  }

  /**
   * The recipe browser gets compact cards (no property labels, heart and stars on the photo); other bases
   * that list recipes only get the clickable row in their stars columns.
   */
  private syncBrowser(view: any) {
    const el: HTMLElement | undefined = view?.containerEl;
    const isBrowser = view?.file instanceof TFile && view.file.path === this.browserPath();
    if (el && el.hasClass("cooklang-recipe-browser") !== isBrowser) {
      el.toggleClass("cooklang-recipe-browser", isBrowser);
      // Card rows are measured from the styles; re-measure now that labels are hidden or shown.
      window.requestAnimationFrame(() => view?.controller?.view?.onResize?.());
    }
    syncBrowserRows(this.app, view, (f) => this.isRecipe(f), isBrowser);
    if (!isBrowser || !el) return;
    this.openInNewTab(view);
    const show = this.settings.cardShow;
    el.toggleClass("cooklang-hide-card-heart", !show.heart);
    el.toggleClass("cooklang-hide-card-stars", !show.stars);
    this.addShowButton(view);
    this.renderCardDetails(view);
  }

  private newTabViews = new WeakSet<object>();

  /** In the recipe browser, a click on a card or a recipe name in the table opens it in a new tab. */
  private openInNewTab(view: any) {
    const el: HTMLElement | undefined = view?.containerEl;
    if (!el || this.newTabViews.has(view)) return;
    this.newTabViews.add(view);
    this.registerDomEvent(el, "click", (evt: MouseEvent) => {
      if (!this.settings.browserNewTab || evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
      if (!(view?.file instanceof TFile) || view.file.path !== this.browserPath()) return;
      const target = evt.target as HTMLElement | null;
      // The heart and stars handle their own clicks; leave toolbar, menus and editable cells alone.
      if (!target || target.closest(".recipe-importer-rating, .bases-toolbar, input, textarea, [contenteditable]")) return;
      const card = target.closest<HTMLElement>(".bases-cards-item");
      const nameCell = target.closest<HTMLElement>('.bases-td[data-property="file.name"]');
      const host = card ?? nameCell?.closest<HTMLElement>(".bases-tr");
      if (!host) return;
      const inner = view?.controller?.view;
      const list: any[] = Array.isArray(inner?.items) ? inner.items : Array.isArray(inner?.rows) ? inner.rows : [];
      const file = list.find((i) => i?.el === host)?.entry?.file;
      if (!(file instanceof TFile) || !this.isRecipe(file)) return;
      evt.preventDefault();
      evt.stopPropagation();
      // Open the new tab right after the browser's own tab, wherever the focus was.
      const ws = this.app.workspace;
      const leaf = view.leaf;
      const parent = leaf?.parent;
      const index = parent?.children?.indexOf(leaf) ?? -1;
      const newLeaf = parent && index >= 0 ? ws.createLeafInParent(parent, index + 1) : ws.getLeaf("tab");
      void this.host.openAsRecipe(newLeaf, file).then(() => ws.setActiveLeaf(newLeaf, { focus: true }));
    }, { capture: true });
  }

  /** Card details line: time and/or servings, as chosen in the Show menu. */
  private renderCardDetails(view: any) {
    const items: any[] = view?.controller?.view?.items ?? [];
    const show = this.settings.cardShow;
    for (const item of items) {
      const file: TFile | undefined = item?.entry?.file;
      const line: HTMLElement | null | undefined = item?.el?.querySelector('[data-property="formula.details"] .bases-cards-line');
      if (!(file instanceof TFile) || !line) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const parts: string[] = [];
      if (show.time && fm.time) parts.push(String(fm.time));
      if (show.servings && fm.servings) parts.push(`${fm.servings} serving${Number(fm.servings) === 1 ? "" : "s"}`);
      const text = parts.join(" · ");
      if (line.textContent !== text) line.setText(text);
    }
  }

  /** A "Show" button in the recipe browser's toolbar, next to Sort. */
  private addShowButton(view: any) {
    const toolbar: HTMLElement | null = view?.containerEl?.querySelector(".bases-toolbar");
    if (!toolbar || toolbar.querySelector(".cooklang-show-menu")) return;
    const item = createDiv({ cls: "bases-toolbar-item cooklang-show-menu" });
    const button = item.createDiv({ cls: "text-icon-button", attr: { tabindex: "0", "aria-label": "Show or hide card details" } });
    setIcon(button.createSpan({ cls: "text-button-icon" }), "eye");
    button.createSpan({ cls: "text-button-label", text: "Show" });
    button.addEventListener("click", (evt) => this.openShowMenu(view, evt));
    toolbar.insertBefore(item, toolbar.querySelector(".bases-toolbar-sort-menu"));
  }

  private openShowMenu(view: any, evt: MouseEvent) {
    const show = this.settings.cardShow;
    const config = view?.controller?.view?.config;
    // Bases may store a note property as "tags" or "note.tags"; compare without the "note." prefix.
    const bare = (p: string) => p.replace(/^note\./, "");
    const order = (): string[] => config?.getOrder?.() ?? [];
    const has = (prop: string) => order().some((p) => bare(p) === bare(prop));
    const remove = (prop: string) => config?.setOrder?.(order().filter((p) => bare(p) !== bare(prop)));
    const insert = (prop: string, at: number) => {
      const next = [...order()];
      next.splice(Math.min(at, next.length), 0, prop);
      config?.setOrder?.(next);
    };
    const menu = new Menu();
    const toggle = (title: string, on: boolean, change: () => void) =>
      menu.addItem((i) => i.setTitle(title).setChecked(on).onClick(async () => {
        change();
        await this.saveSettings();
        this.refreshBrowsers();
      }));
    toggle("Favorite heart", show.heart, () => (show.heart = !show.heart));
    toggle("Rating stars", show.stars, () => (show.stars = !show.stars));
    menu.addSeparator();
    const setDetails = () => {
      // With neither time nor servings, drop the details line so the cards get shorter.
      const want = show.time || show.servings;
      if (want && !has("formula.details")) insert("formula.details", 1);
      if (!want && has("formula.details")) remove("formula.details");
    };
    toggle("Time", show.time, () => { show.time = !show.time; setDetails(); });
    toggle("Servings", show.servings, () => { show.servings = !show.servings; setDetails(); });
    toggle("Tags", has("tags"), () => (has("tags") ? remove("tags") : insert("tags", order().length)));
    menu.addSeparator();
    toggle("Open recipes in a new tab", this.settings.browserNewTab, () => (this.settings.browserNewTab = !this.settings.browserNewTab));
    menu.showAtMouseEvent(evt);
  }


  onunload() {
    document.querySelectorAll(".recipe-importer-rating, .cooklang-show-menu").forEach((el) => el.remove());
  }

  /** The photos folder, when photos are kept in their own folder; null when they go beside recipes. */
  photosFolder(): string | null {
    if (this.settings.photoLocation !== "folder") return null;
    const path = normalizePath(this.settings.photosFolder.trim() || DEFAULT_IMPORTER_SETTINGS.photosFolder);
    return path === "/" ? null : path;
  }

  /** The standard recipe folders plus any other subfolders of the recipes folder. Missing ones are created on save. */
  recipeFolders(): string[] {
    const root = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.recipesFolder));
    const existing = root instanceof TFolder ? root.children.filter((c): c is TFolder => c instanceof TFolder).map((f) => f.name) : [];
    return [...new Set([...DEFAULT_FOLDERS, ...existing])]
      // Never offer the photos folder as a place for recipes.
      .filter((name) => normalizePath(`${this.settings.recipesFolder}/${name}`) !== this.photosFolder())
      .sort((a, b) => a.localeCompare(b));
  }

  /** Downloads a page and reads its recipe data, without converting it. */
  async fetchPage(url: string): Promise<Page> {
    const res = await requestUrl({ url, headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, throw: false });
    if (res.status >= 400) throw new Error(`The site answered with error ${res.status}.`);
    const html = res.text;
    const json = findRecipeJsonLd(html);
    const recipe = json ? normalizeRecipe(json, url) : null;
    const usable = !!recipe && (recipe.ingredients.length > 0 || recipe.groups.length > 0);
    return { url, html, recipe, usable };
  }

  /** Whether a fetched page can be imported, and how. */
  canImport(page: Page): boolean {
    return page.text !== undefined || page.usable || this.claudeOn();
  }

  /** Imports go through Claude: there's a key, and Claude is switched on in the import dialog. */
  claudeOn(): boolean {
    return !!this.settings.apiKey && this.settings.useClaude;
  }

  /** A pasted recipe, ready to convert like a fetched page. */
  textPage(text: string): Page {
    return { url: "", html: "", recipe: null, usable: false, text };
  }

  /** Converts a fetched page into a Cooklang recipe note. */
  async convert(page: Page, onProgress?: (p: ClaudeProgress) => void, signal?: AbortSignal): Promise<Prepared> {
    const { url, recipe, usable, html } = page;
    if (this.claudeOn()) {
      const { markdown, folder } = await convertWithClaude({
        apiKey: this.settings.apiKey,
        model: this.settings.model,
        recipe: usable ? recipe : null,
        url,
        pageText: page.text ?? (usable ? undefined : pageText(html)),
        pasted: page.text !== undefined,
        folders: this.recipeFolders(),
        onProgress,
        signal,
      });
      return { url, recipe, markdown, method: "claude", folder };
    }
    if (page.text !== undefined) {
      const parsed = parseRecipeText(page.text);
      if (!parsed.ingredients.length && !parsed.groups.length) throw new Error("Couldn't find ingredients or steps in that text.");
      return { url, recipe: parsed, markdown: toCooklang(parsed), method: "rules" };
    }
    if (!usable) {
      throw new Error(
        recipe
          ? "This page's recipe data has no ingredients or steps. Turn on Claude to import it from the page text."
          : "No recipe data found on this page. Turn on Claude to import it from the page text.",
      );
    }
    return { url, recipe, markdown: toCooklang(recipe!), method: "rules" };
  }

  async prepare(url: string): Promise<Prepared> {
    return this.convert(await this.fetchPage(url));
  }

  async save(p: Prepared, title: string, folder: string): Promise<TFile> {
    const dir = normalizePath(folder ? `${this.settings.recipesFolder}/${folder}` : this.settings.recipesFolder);
    if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);

    let base = safeFileName(title);
    for (let n = 2; this.app.vault.getAbstractFileByPath(`${dir}/${base}.md`); n++) base = `${safeFileName(title)} ${n}`;
    const file = await this.app.vault.create(`${dir}/${base}.md`, p.markdown);

    if (this.settings.saveImage && p.recipe?.imageUrl) {
      try {
        const img = await requestUrl({ url: new URL(p.recipe.imageUrl, p.url).href, headers: { "User-Agent": USER_AGENT } });
        // Same rules as "Set recipe photo": resized, named after the recipe, in the photos folder or
        // beside the recipe, never overwriting another recipe's photo, and linked from the recipe.
        await this.setRecipePhoto(file, img.arrayBuffer);
      } catch (e) {
        console.warn("CooklangPro: could not save the photo", e);
        new Notice("Recipe saved, but its photo could not be downloaded.");
      }
    }
    return file;
  }

  /** The image file a recipe's photo property links to, or a same-name image beside it. */
  currentPhoto(file: TFile): TFile | null {
    const linked = this.app.metadataCache.getFileCache(file)?.frontmatter?.photo;
    const linkText = typeof linked === "string" ? linked.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0] : "";
    const dest = linkText ? this.app.metadataCache.getFirstLinkpathDest(linkText, file.path) : null;
    if (dest) return dest;
    return file.parent?.children.find(
      (c): c is TFile => c instanceof TFile && c.basename === file.basename && /^(jpe?g|png|webp|gif)$/i.test(c.extension),
    ) ?? null;
  }

  openPhotoModal(file: TFile) {
    const current = this.currentPhoto(file);
    const currentUrl = current ? this.app.vault.getResourcePath(current) : null;
    new PhotoModal(this.app, file.basename, currentUrl, async (data) => {
      const path = await this.setRecipePhoto(file, data);
      new Notice(`Photo set for ${file.basename}`);
      console.debug("CooklangPro: recipe photo saved to", path);
    }).open();
  }

  /**
   * Saves a photo for a recipe: resized, named after the recipe, in the photos folder (or beside the
   * recipe, per the settings), and linked from its photo property. A previous photo goes to the trash.
   */
  async setRecipePhoto(file: TFile, data: ArrayBuffer): Promise<string> {
    const photo = await resizePhoto(data);
    const dir = this.photosFolder() ?? file.parent?.path ?? "";
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);

    // The old photo: the one linked from the recipe, or a same-name image beside it.
    const linked = this.app.metadataCache.getFileCache(file)?.frontmatter?.photo;
    const linkText = typeof linked === "string" ? linked.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0] : "";
    const old = linkText ? this.app.metadataCache.getFirstLinkpathDest(linkText, file.path) : null;
    const besideOld = file.parent?.children.find(
      (c): c is TFile => c instanceof TFile && c.basename === file.basename && /^(jpe?g|png|webp|gif)$/i.test(c.extension),
    );
    const ours = new Set([old?.path, besideOld?.path].filter(Boolean));

    // Named after the recipe. If another recipe's photo already has that name (two recipes with the
    // same name in different folders), add a number rather than overwrite it.
    const at = (n: number) => normalizePath(`${dir ? `${dir}/` : ""}${file.basename}${n > 1 ? ` ${n}` : ""}.${photo.ext}`);
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(at(n)) && !ours.has(at(n))) n++;
    const target = at(n);

    const existing = this.app.vault.getAbstractFileByPath(target);
    let saved: TFile;
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, photo.data);
      saved = existing;
    } else {
      saved = await this.app.vault.createBinary(target, photo.data);
    }
    for (const prev of [old, besideOld]) {
      if (prev instanceof TFile && prev.path !== target) await this.app.fileManager.trashFile(prev);
    }
    // Link the way Obsidian would: just the name when it's unique, with the folder when it isn't.
    const link = this.app.metadataCache.fileToLinktext(saved, file.path, false);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.photo = `[[${link}]]`;
    });
    return target;
  }

  browserPath(): string {
    return normalizePath(`${this.settings.recipesFolder}/Recipe Browser.base`);
  }

  /** Gives every recipe with a "<name>.<image ext>" photo beside it or in the Photos folder a photo property, if it has none. */
  async linkRecipePhotos(): Promise<number> {
    let added = 0;
    const photosPath = this.photosFolder();
    const photosDir = photosPath ? this.app.vault.getAbstractFileByPath(photosPath) : null;
    const isPhotoOf = (c: unknown, file: TFile): c is TFile =>
      c instanceof TFile && c.basename === file.basename && /^(jpe?g|png|webp|gif)$/i.test(c.extension);
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.recipe !== true || fm.photo || !file.parent) continue;
      const photo =
        file.parent.children.find((c): c is TFile => isPhotoOf(c, file)) ??
        (photosDir instanceof TFolder ? photosDir.children.find((c): c is TFile => isPhotoOf(c, file)) : undefined);
      if (!photo) continue;
      await this.app.fileManager.processFrontMatter(file, (f) => {
        f.photo = `[[${photo.name}]]`;
      });
      added++;
    }
    return added;
  }

  /** Opens the recipe browser base, creating it first if it doesn't exist. An existing one is never overwritten. */
  async openRecipeBrowser() {
    const added = await this.linkRecipePhotos();
    if (added) new Notice(`Linked photos for ${added} recipe${added === 1 ? "" : "s"}.`);
    const path = this.browserPath();
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const dir = normalizePath(this.settings.recipesFolder);
      if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      file = await this.app.vault.create(path, recipeBaseContent());
      new Notice("Created the recipe browser.");
    }
    await this.app.workspace.getLeaf(false).openFile(file as TFile);
  }

  async open(file: TFile) {
    await this.host.openAsRecipe(this.app.workspace.getLeaf(false), file);
  }
}

class ImportModal extends Modal {
  private plugin: RecipeImporter;
  private prepared: Prepared | null = null;

  constructor(app: App, plugin: RecipeImporter) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.setTitle("Import recipe");
    this.modalEl.addClass("recipe-importer-modal", "cooklang-themed-select");
    // Keyboard: Ctrl/Cmd+Enter does the screen's main action anywhere in the dialog, Enter does it from a
    // one-line field, Ctrl/Cmd+1 and 2 switch tabs, Alt+Left goes back. Escape closes (and cancels).
    this.scope.register(["Mod"], "Enter", () => {
      this.submit?.();
      return false;
    });
    this.scope.register([], "Enter", (e) => {
      const t = e.target as HTMLElement | null;
      if (!(t instanceof HTMLInputElement) || t.type !== "text" || !this.submit) return true;
      this.submit();
      return false;
    });
    this.scope.register(["Mod"], "1", () => (this.tabKeys?.("link"), false));
    this.scope.register(["Mod"], "2", () => (this.tabKeys?.("text"), false));
    this.scope.register(["Alt"], "ArrowLeft", () => (this.back?.(), false));
    this.showUrlStep();
  }

  private page: Page | null = null;
  private checkToken = 0;
  private abort: AbortController | null = null;

  /** Step 1: the link. As soon as a link is entered, the page is fetched and checked. */
  private pastedText = "";
  /** The current screen's main action, its "back", and tab switching (first screen only). */
  private submit: (() => void) | null = null;
  private back: (() => void) | null = null;
  private tabKeys: ((tab: "link" | "text") => void) | null = null;

  private resetKeys() {
    this.submit = this.back = this.tabKeys = null;
  }

  /** A muted line of keyboard hints under the buttons. */
  private keyHints(...hints: string[]) {
    if (Platform.isMobile) return; // no keyboard shortcuts to show on a phone or tablet
    const mod = Platform.isMacOS ? "⌘" : "Ctrl";
    this.contentEl.createDiv({ cls: "recipe-importer-keys", text: hints.map((h) => h.replace(/Mod/g, mod)).join("   ·   ") });
  }

  /** Tabs at the top of the first screen: a link, or pasted text. */
  private tabs(active: "link" | "text") {
    this.resetKeys();
    const openTab = (id: "link" | "text") => {
      if (id === active) return;
      if (id === "link") this.showUrlStep();
      else this.showTextStep();
    };
    this.tabKeys = openTab;
    const bar = this.contentEl.createDiv({ cls: "recipe-importer-tabs", attr: { role: "tablist" } });
    // Left and Right move between the tabs when one has focus.
    bar.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        openTab(active === "link" ? "text" : "link");
        window.setTimeout(() => this.contentEl.querySelector<HTMLElement>(".recipe-importer-tab.is-active")?.focus(), 0);
      }
    });
    const tab = (id: "link" | "text", icon: string, label: string, open: () => void) => {
      const b = bar.createEl("button", {
        cls: "recipe-importer-tab" + (id === active ? " is-active" : ""),
        attr: { role: "tab", "aria-selected": String(id === active), tabindex: id === active ? "0" : "-1" },
      });
      setIcon(b.createSpan({ cls: "recipe-importer-check-icon" }), icon);
      b.createSpan({ text: label });
      b.addEventListener("click", () => id !== active && open());
    };
    tab("link", "link", "From a link", () => this.showUrlStep());
    tab("text", "text", "From text", () => this.showTextStep());
  }

  /**
   * The Claude switch and model, beside the Import button. Without an API key it only says how to get Claude.
   * `changed` re-checks the screen, since what can be imported depends on it.
   */
  private claudeControls(el: HTMLElement, changed: () => void) {
    const plugin = this.plugin;
    const box = el.createDiv({ cls: "recipe-importer-claude" });
    if (!plugin.settings.apiKey) {
      box.addClass("is-unavailable");
      setIcon(box.createSpan({ cls: "recipe-importer-check-icon" }), "sparkles");
      box.createSpan({ text: "Claude: add an API key in settings" });
      return;
    }
    const toggle = box.createEl("button", { cls: "recipe-importer-claude-toggle", attr: { type: "button" } });
    setIcon(toggle.createSpan({ cls: "recipe-importer-check-icon" }), "sparkles");
    const label = toggle.createSpan();
    const model = box.createEl("select", { cls: "dropdown recipe-importer-claude-model", attr: { "aria-label": "Claude model" } });
    for (const [id, name] of CLAUDE_MODELS) model.createEl("option", { value: id, text: name });
    if (![...model.options].some((o) => o.value === plugin.settings.model)) model.createEl("option", { value: plugin.settings.model, text: plugin.settings.model });
    model.value = plugin.settings.model;
    const render = () => {
      const on = plugin.settings.useClaude;
      toggle.toggleClass("is-on", on);
      toggle.setAttr("aria-pressed", String(on));
      toggle.setAttr("aria-label", on ? "Claude is on. Click to use the built-in converter." : "Claude is off. Click to use Claude.");
      label.setText(on ? "Claude" : "Claude off");
      model.toggle(on);
    };
    toggle.addEventListener("click", async () => {
      plugin.settings.useClaude = !plugin.settings.useClaude;
      render();
      await plugin.saveSettings();
      changed();
    });
    model.addEventListener("change", async () => {
      plugin.settings.model = model.value;
      await plugin.saveSettings();
    });
    render();
  }

  /** Step 1, text tab: a recipe pasted from anywhere, read by Claude or the built-in reader. */
  private showTextStep() {
    const { contentEl } = this;
    contentEl.empty();
    this.tabs("text");
    const area = contentEl.createEl("textarea", {
      cls: "recipe-importer-text",
      attr: { placeholder: "Paste a recipe: its name, ingredients and steps, in any layout.", spellcheck: "false" },
    });
    area.value = this.pastedText;
    const check = contentEl.createDiv({ cls: "recipe-importer-check" });
    let button!: import("obsidian").ButtonComponent;
    const actions = new Setting(contentEl)
      .addExtraButton((b) =>
        b.setIcon("clipboard-paste").setTooltip("Paste recipe").onClick(async () => {
          const text = await readClipboard();
          if (!text.trim()) {
            new Notice("The clipboard is empty.");
            return;
          }
          area.value = text;
          update();
        }),
      )
      .addButton((b) => {
        button = b;
        b.setButtonText("Import").setCta().onClick(() => go());
      });
    this.claudeControls(actions.infoEl, () => update());
    const row = (icon: string, text: string, cls: string) => {
      check.empty();
      check.className = `recipe-importer-check ${cls}`;
      setIcon(check.createSpan({ cls: "recipe-importer-check-icon" }), icon);
      check.createSpan({ text });
    };
    const update = () => {
      this.pastedText = area.value;
      const text = area.value.trim();
      const lines = text ? text.split(/\n/).filter((l) => l.trim()).length : 0;
      if (!text) { check.empty(); check.className = "recipe-importer-check"; }
      else if (text.length < 40) row("triangle-alert", "That's very short for a recipe.", "is-warning");
      else if (this.plugin.claudeOn()) row("circle-check", `${plural(lines, "line")} pasted. Claude will turn it into a recipe.`, "is-ok-inline");
      else {
        // Preview what the built-in reader finds, so a bad read shows before importing.
        const r = parseRecipeText(text);
        const steps = r.groups.reduce((n, g) => n + g.steps.length, 0);
        if (!r.ingredients.length && !steps) row("circle-x", "Couldn't find ingredients or steps. Turn on Claude for messy text.", "is-error");
        else row(r.ingredients.length && steps ? "circle-check" : "triangle-alert",
          `Found "${r.name}": ${plural(r.ingredients.length, "ingredient")}, ${plural(steps, "step")}. Check it after saving.`,
          r.ingredients.length && steps ? "is-ok-inline" : "is-warning");
      }
      button.setDisabled(text.length < 40);
    };
    const go = () => {
      if (area.value.trim().length >= 40) this.showProgressStep(this.plugin.textPage(area.value.trim()));
    };
    area.addEventListener("input", update);
    // Plain Enter is a new line here; Ctrl/Cmd+Enter imports (see onOpen).
    this.submit = go;
    this.keyHints("Mod+Enter import", "Mod+1 / Mod+2 switch tab");
    update();
    if (!Platform.isMobile) window.setTimeout(() => area.focus(), 0);
  }

  private showUrlStep(initialUrl = "") {
    const { contentEl } = this;
    contentEl.empty();
    this.tabs("link");
    let url = initialUrl;
    let input!: HTMLInputElement;
    const linkSetting = new Setting(contentEl).setName("Recipe link").addText((t) => {
      t.setPlaceholder("https://...").setValue(url);
      input = t.inputEl;
      input.addClass("recipe-importer-url");
      // On a phone, focusing would open the keyboard over the dialog; pasting doesn't need it.
      if (!Platform.isMobile) window.setTimeout(() => input.focus(), 0);
    });
    const useLink = (link: string) => {
      input.value = link;
      url = link;
      window.clearTimeout(timer);
      void runCheck();
    };
    linkSetting.addExtraButton((b) =>
      b.setIcon("clipboard-paste").setTooltip("Paste link").onClick(async () => {
        const link = await clipboardLink();
        if (link) useLink(link);
        else new Notice("There's no link in the clipboard.");
      }),
    );
    const check = contentEl.createDiv({ cls: "recipe-importer-check" });
    let button!: import("obsidian").ButtonComponent;
    const actions = new Setting(contentEl).addButton((b) => {
      button = b;
      b.setButtonText("Import").setCta().setDisabled(true).onClick(() => void go());
    });
    this.claudeControls(actions.infoEl, () => {
      if (this.page && this.page.url === url.trim()) {
        showPage(this.page);
        button.setDisabled(!this.plugin.canImport(this.page));
      }
    });

    const row = (icon: string, text: string, cls = "") => {
      check.empty();
      check.className = `recipe-importer-check ${cls}`.trim();
      const i = check.createSpan({ cls: "recipe-importer-check-icon" });
      setIcon(i, icon);
      check.createSpan({ text });
    };
    const showPage = (page: Page) => {
      check.empty();
      const r = page.recipe;
      const key = this.plugin.claudeOn();
      if (page.usable && r) {
        check.className = "recipe-importer-check is-ok";
        if (r.imageUrl) check.createEl("img", { cls: "recipe-importer-check-img", attr: { src: new URL(r.imageUrl, page.url).href, alt: "" } });
        const body = check.createDiv({ cls: "recipe-importer-check-body" });
        body.createDiv({ cls: "recipe-importer-check-name", text: r.name || "Untitled recipe" });
        const steps = r.groups.reduce((n, g) => n + g.steps.length, 0);
        const facts = [
          plural(r.ingredients.length, "ingredient"),
          plural(steps, "step"),
          r.totalMinutes ? `${r.totalMinutes} minutes` : "",
          r.imageUrl ? "photo" : "no photo",
        ].filter(Boolean);
        body.createDiv({ cls: "recipe-importer-check-facts", text: facts.join(" · ") });
        const how = body.createDiv({ cls: "recipe-importer-check-how" });
        setIcon(how.createSpan({ cls: "recipe-importer-check-icon" }), "circle-check");
        how.createSpan({ text: key ? "Recipe found. Claude will convert it." : "Recipe found. The built-in converter will convert it." });
      } else if (key) {
        row("triangle-alert", r
          ? "The page's recipe data has no ingredients or steps. Claude will read the page text instead."
          : "No recipe data on this page. Claude will read the page text instead.", "is-warning");
      } else {
        row("circle-x", r
          ? "The page's recipe data has no ingredients or steps. Turn on Claude to import it from the page text."
          : "No recipe data on this page. Turn on Claude to import it from the page text.", "is-error");
      }
    };

    const runCheck = async () => {
      const token = ++this.checkToken;
      this.page = null;
      button.setDisabled(true);
      const u = url.trim();
      if (!u) {
        check.empty();
        check.className = "recipe-importer-check";
        return;
      }
      if (!/^https?:\/\/\S+\.\S+/i.test(u)) {
        row("circle-x", "Enter a link starting with http:// or https://", "is-error");
        return;
      }
      row("loader", "Checking the page...", "is-busy");
      try {
        const page = await this.plugin.fetchPage(u);
        if (token !== this.checkToken) return;
        this.page = page;
        showPage(page);
        button.setDisabled(!this.plugin.canImport(page));
      } catch (e) {
        if (token !== this.checkToken) return;
        row("circle-x", `Couldn't load the page: ${describeError(e)}`, "is-error");
      }
    };
    let timer = 0;
    input.addEventListener("input", () => {
      url = input.value;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void runCheck(), 400);
    });
    input.addEventListener("paste", () => window.setTimeout(() => {
      url = input.value;
      window.clearTimeout(timer);
      void runCheck();
    }, 0));
    const go = async () => {
      window.clearTimeout(timer);
      if (!this.page || this.page.url !== url.trim()) await runCheck();
      if (this.page && this.plugin.canImport(this.page)) this.showProgressStep(this.page);
    };
    this.submit = () => void go();
    this.keyHints("Enter import", "Mod+1 / Mod+2 switch tab");
    if (url) void runCheck();
    // A link already in the clipboard is filled in straight away.
    else void clipboardLink().then((link) => {
      if (link && !input.value.trim() && this.contentEl.contains(input)) useLink(link);
    });
  }

  /** Step 2: converting, with progress. */
  private showProgressStep(page: Page) {
    const { contentEl } = this;
    contentEl.empty();
    this.resetKeys();
    const claude = this.plugin.claudeOn();
    const list = contentEl.createDiv({ cls: "recipe-importer-progress" });
    const step = (text: string) => {
      const el = list.createDiv({ cls: "recipe-importer-step" });
      const icon = el.createSpan({ cls: "recipe-importer-check-icon" });
      const label = el.createSpan({ text });
      const detail = el.createDiv({ cls: "recipe-importer-step-detail" });
      const set = (state: "waiting" | "busy" | "done" | "failed", info = "") => {
        el.className = `recipe-importer-step is-${state}`;
        setIcon(icon, { waiting: "circle", busy: "loader", done: "circle-check", failed: "circle-x" }[state]);
        detail.setText(info);
      };
      set("waiting");
      return { el, set, label };
    };
    const read = step(page.text !== undefined ? "Read the pasted recipe" : "Read the recipe from the page");
    const convert = step(claude ? "Convert with Claude" : "Convert to Cooklang");
    const bar = convert.el.createEl("progress", { cls: "recipe-importer-bar" });
    bar.max = 1;
    bar.hide();
    read.set("done", page.text !== undefined ? "" : page.usable && page.recipe ? page.recipe.name : "From the page text");

    const buttons = new Setting(contentEl);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const cancel = () => {
      this.abort?.abort();
      if (page.text !== undefined) this.showTextStep();
      else this.showUrlStep(page.url);
    };
    buttons.addButton((b) => {
      b.setButtonText("Cancel").onClick(cancel);
      window.setTimeout(() => b.buttonEl.focus(), 0);
    });
    this.back = cancel;
    this.keyHints("Alt+← cancel", "Esc close");

    // Progress from the streamed answer: steps written out of the steps in the recipe data.
    const total = page.usable && page.recipe ? page.recipe.groups.reduce((n, g) => n + g.steps.length, 0) : 0;
    const started = Date.now();
    const onProgress = (p: ClaudeProgress) => {
      if (signal.aborted) return;
      if (p.phase === "thinking") {
        bar.removeAttribute("value");
        bar.show();
        convert.set("busy", "Claude is reading the recipe...");
        return;
      }
      const written = writtenSteps(p.text);
      if (total) {
        bar.value = Math.min(0.97, written / total);
        convert.set("busy", written ? `Writing step ${Math.min(written + 1, total)} of ${total}` : "Writing the ingredients and details...");
      } else {
        convert.set("busy", written ? `Writing step ${written + 1}...` : "Writing the ingredients and details...");
      }
    };

    void (async () => {
      convert.set("busy", claude ? "Sending to Claude..." : "");
      try {
        const prepared = await this.plugin.convert(page, onProgress, signal);
        if (signal.aborted) return;
        bar.value = 1;
        const secs = Math.round((Date.now() - started) / 1000);
        convert.set("done", claude ? `Done in ${secs} seconds` : "");
        this.prepared = prepared;
        window.setTimeout(() => !signal.aborted && this.showSaveStep(), 400);
      } catch (e) {
        if (signal.aborted) return;
        bar.hide();
        convert.set("failed", describeError(e));
        buttons.addButton((b) => {
          b.setButtonText("Try again").setCta().onClick(() => this.showProgressStep(page));
          b.buttonEl.focus();
        });
        this.submit = () => this.showProgressStep(page);
      }
    })();
  }

  private showSaveStep() {
    const p = this.prepared!;
    const { contentEl } = this;
    contentEl.empty();
    this.resetKeys();
    const folders = this.plugin.recipeFolders();
    let title = p.recipe?.name ?? (/^title:\s*"?(.*?)"?\s*$/m.exec(p.markdown)?.[1] || "New recipe");
    let folder = (p.folder && folders.includes(p.folder) ? p.folder : null)
      ?? guessFolder(p.recipe ?? noteAsRecipe(p.markdown, title), folders) ?? folders[0] ?? "";

    contentEl.createEl("p", {
      text:
        p.method === "claude"
          ? "Converted with Claude."
          : "Converted without AI. Check the ingredients in the steps after saving.",
      cls: "setting-item-description",
    });
    new Setting(contentEl).setName("Name").addText((t) => {
      t.setValue(title).onChange((v) => (title = v));
      t.inputEl.addClass("recipe-importer-url");
      if (!Platform.isMobile) window.setTimeout(() => {
        t.inputEl.focus();
        t.inputEl.select();
      }, 0);
    });
    const NEW = "\u0000new";
    let newFolder = "";
    let newFolderSetting: Setting;
    new Setting(contentEl).setName("Folder").addDropdown((d) => {
      d.addOption("", `${this.plugin.settings.recipesFolder} (top level)`);
      for (const f of folders) d.addOption(f, f);
      d.addOption(NEW, "New folder...");
      d.setValue(folder).onChange((v) => {
        folder = v;
        newFolderSetting.settingEl.toggle(v === NEW);
        if (v === NEW) newFolderSetting.controlEl.querySelector("input")?.focus();
      });
    });
    newFolderSetting = new Setting(contentEl).setName("New folder name").addText((t) => {
      t.setPlaceholder("e.g. Salads").onChange((v) => (newFolder = v));
    });
    newFolderSetting.settingEl.hide();
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Back").onClick(() => this.back?.()),
      )
      .addButton((b) => {
        this.submit = () => {
          if (!b.disabled) b.buttonEl.click();
        };
        b
          .setButtonText("Save recipe")
          .setCta()
          .onClick(async () => {
            let target = folder;
            if (folder === NEW) {
              target = newFolder.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
              if (!target) {
                new Notice("Enter a name for the new folder.");
                return;
              }
            }
            b.setDisabled(true);
            b.setButtonText(this.plugin.settings.saveImage && p.recipe?.imageUrl ? "Saving recipe and photo..." : "Saving...");
            try {
              const file = await this.plugin.save(p, title, target);
              this.close();
              new Notice(`Imported ${file.basename}`);
              if (this.plugin.settings.openAfterImport) await this.plugin.open(file);
            } catch (e) {
              b.setDisabled(false);
              b.setButtonText("Save recipe");
              new Notice(`Could not save the recipe: ${e instanceof Error ? e.message : String(e)}`);
            }
          });
      });
    this.back = () => {
      this.prepared = null;
      if (p.url) this.showUrlStep(p.url);
      else this.showTextStep();
    };
    this.keyHints("Enter save", "Alt+← back", "Esc close");
  }

  onClose() {
    this.abort?.abort();
    this.checkToken++;
    this.contentEl.empty();
  }
}

/** Enough of a recipe note's front matter to guess its folder: the title and tags. */
function noteAsRecipe(markdown: string, title: string): RecipeData {
  const tags = /^tags:\s*\[(.*)\]/m.exec(markdown)?.[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")) ?? [];
  return {
    name: title, description: "", url: "", imageUrl: null, servings: null, yieldText: null, totalMinutes: null,
    ingredients: [], groups: [], categories: [], cuisines: [], keywords: tags, diets: [], raw: null,
  };
}

/** The clipboard's text, or "" when it can't be read (no permission, or not text). */
async function readClipboard(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()) ?? "";
  } catch {
    return "";
  }
}

/** A web link in the clipboard, if that's all the clipboard holds. */
async function clipboardLink(): Promise<string | null> {
  const text = (await readClipboard()).trim();
  return /^https?:\/\/\S+\.\S+$/i.test(text) ? text : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Steps written so far in a streamed recipe note: finished paragraphs after the front matter, not notes or sections. */
export function writtenSteps(text: string): number {
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end < 0) return 0;
  const body = text.slice(end + 4);
  const paras = body.split(/\n\s*\n/).map((p) => p.trim());
  // The last paragraph may still be being written.
  paras.pop();
  return paras.filter((p) => p && !p.startsWith(">") && !p.startsWith("=")).length;
}

/** The importer's part of the CooklangPro settings tab. */
export function displayImporterSettings(containerEl: HTMLElement, importer: RecipeImporter): void {
    const plugin = importer;
    new Setting(containerEl).setName("Recipe importer").setHeading();
    new Setting(containerEl)
      .setName("Recipes folder")
      .setDesc("Imported recipes go into this folder or one of its subfolders.")
      .addText((t) =>
        t.setValue(plugin.settings.recipesFolder).onChange(async (v) => {
          plugin.settings.recipesFolder = v.trim() || DEFAULT_IMPORTER_SETTINGS.recipesFolder;
          await plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Recipe browser")
      .setDesc("A base in the recipes folder that shows every recipe as a photo card, with views by folder, favorites, top rated (4 or 5 stars), and a table.")
      .addButton((b) => b.setButtonText("Open recipe browser").onClick(() => void plugin.openRecipeBrowser()));
    new Setting(containerEl)
      .setName("Save the recipe photo")
      .setDesc("Downloads the recipe's photo when importing, and links it from the recipe's photo property.")
      .addToggle((t) =>
        t.setValue(plugin.settings.saveImage).onChange(async (v) => {
          plugin.settings.saveImage = v;
          await plugin.saveSettings();
          showPhotoSettings();
        }),
      );
    const locationSetting = new Setting(containerEl)
      .setName("Where to save photos")
      .setDesc("Next to each recipe, or all in one folder.")
      .addDropdown((d) =>
        d
          .addOption("beside", "Next to the recipe")
          .addOption("folder", "In a folder")
          .setValue(plugin.settings.photoLocation)
          .onChange(async (v) => {
            plugin.settings.photoLocation = v === "beside" ? "beside" : "folder";
            await plugin.saveSettings();
            showPhotoSettings();
          }),
      );
    const folderSetting = new Setting(containerEl)
      .setName("Photos folder")
      .setDesc("The folder in your vault for recipe photos, for example Recipes/Photos. It's created when needed.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_IMPORTER_SETTINGS.photosFolder)
          .setValue(plugin.settings.photosFolder)
          .onChange(async (v) => {
            plugin.settings.photosFolder = v.trim() || DEFAULT_IMPORTER_SETTINGS.photosFolder;
            await plugin.saveSettings();
          }),
      );
    const showPhotoSettings = () => {
      locationSetting.settingEl.toggle(plugin.settings.saveImage);
      folderSetting.settingEl.toggle(plugin.settings.saveImage && plugin.settings.photoLocation === "folder");
    };
    showPhotoSettings();
    new Setting(containerEl)
      .setName("Open after importing")
      .addToggle((t) =>
        t.setValue(plugin.settings.openAfterImport).onChange(async (v) => {
          plugin.settings.openAfterImport = v;
          await plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Open recipes from the browser in a new tab")
      .setDesc("Off: a recipe opens in the recipe browser's tab.")
      .addToggle((t) =>
        t.setValue(plugin.settings.browserNewTab).onChange(async (v) => {
          plugin.settings.browserNewTab = v;
          await plugin.saveSettings();
        }),
      );


    new Setting(containerEl).setName("Recipe importer: Claude").setHeading();
    const keySetting = new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc(
        "Optional. With a key, Claude can convert recipes (better ingredient marking, and pages without recipe data or messy pasted text work). Switch Claude on or off and pick the model in the import dialog. Without a key, a built-in converter is used. The key is stored in CooklangPro's data.json, which syncs with your vault.",
      );
    const keyStatus = containerEl.createDiv({ cls: "recipe-importer-key-status" });
    keySetting.settingEl.after(keyStatus);
    const runCheck = async () => {
      const key = plugin.settings.apiKey;
      keyStatus.removeClass("is-ok", "is-error");
      if (!key) {
        keyStatus.setText("");
        return;
      }
      keyStatus.setText("Checking the key...");
      const result = await checkKey(key, plugin.settings.model);
      if (plugin.settings.apiKey !== key) return; // changed while checking
      keyStatus.setText(result.message);
      keyStatus.addClass(result.ok ? "is-ok" : "is-error");
    };
    keySetting
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...")
          .setValue(plugin.settings.apiKey)
          .onChange(async (v) => {
            plugin.settings.apiKey = v.trim();
            await plugin.saveSettings();
            keyStatus.setText(v.trim() ? "Not checked yet." : "");
            keyStatus.removeClass("is-ok", "is-error");
          });
        t.inputEl.addEventListener("blur", () => void runCheck());
      })
      .addButton((b) => b.setButtonText("Check key").onClick(() => void runCheck()));
    void runCheck();
}
