import { App, Component, Modal, Notice, Plugin, Setting, TFile, TFolder, WorkspaceLeaf, normalizePath, requestUrl } from "obsidian";
import { RecipeData, findRecipeJsonLd, normalizeRecipe } from "./recipe";
import { DEFAULT_FOLDERS, guessFolder, safeFileName, toCooklang } from "./converter";
import { DEFAULT_MODEL, checkKey, convertWithClaude, describeError } from "./claude";
import { syncBrowserRows } from "./rating";

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
}

export const DEFAULT_IMPORTER_SETTINGS: ImporterSettings = {
  recipesFolder: "Recipes",
  apiKey: "",
  model: DEFAULT_MODEL,
  openAfterImport: true,
  saveImage: true,
  photoLocation: "folder",
  photosFolder: "Recipes/Photos",
};

/** What the importer needs from the CooklangPro plugin. */
export interface ImporterHost extends Plugin {
  settings: { importer?: Partial<ImporterSettings> };
  saveSettings(): Promise<void>;
  openAsRecipe(leaf: WorkspaceLeaf, file: TFile): Promise<void>;
}

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

interface Prepared {
  url: string;
  recipe: RecipeData | null;
  markdown: string;
  method: "claude" | "rules";
}

/** An Obsidian base listing every recipe note (recipe: true), with photo cards and a table. */
function recipeBaseContent(): string {
  const cardProps = ["file.name", "formula.stars", "note.time", "note.servings", "note.tags"];
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
    `  favorite_icon: 'if(favorite == true, [icon("heart")], [])'`,
    `  rating_stars: '[1,2,3,4,5].filter(value <= number(rating)).map(icon("star"))'`,
    "properties:",
    "  file.name:",
    "    displayName: Recipe",
    "  file.folder:",
    "    displayName: Folder",
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
    ...cards("All recipes"),
    ...cards("By folder", ["    groupBy:", "      property: file.folder", "      direction: ASC"]),
    ...cards("Vegan", ["    filters:", "      and:", '        - tags.contains("vegan")']),
    ...cards("Favorites", ["    filters:", "      and:", "        - favorite == true"]),
    ...cards("Top rated", ["    filters:", "      and:", "        - rating >= 4"], [["note.rating", "DESC"], ["file.name", "ASC"]]),
    "  - type: table",
    "    name: Table",
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
 * Formerly the separate Recipe Importer plugin; now a component of CooklangPro.
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
    host.settings.importer = this.settings;
  }

  async saveSettings() {
    await this.host.saveSettings();
  }

  onload() {
    this.host.addCommand({
      id: "import-recipe-from-url",
      name: "Import recipe from URL",
      callback: () => new ImportModal(this.app, this).open(),
    });
    this.host.addRibbonIcon("chef-hat", "Import recipe from URL", () => new ImportModal(this.app, this).open());
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
            syncBrowserRows(this.app, view, (f) => this.isRecipe(f));
          });
        });
        observer.observe(el, { childList: true, subtree: true });
        this.register(() => observer.disconnect());
      }
      syncBrowserRows(this.app, view, (f) => this.isRecipe(f));
    }
  }

  private refreshBrowsers() {
    for (const leaf of this.app.workspace.getLeavesOfType("bases")) {
      syncBrowserRows(this.app, leaf.view, (f) => this.isRecipe(f));
    }
  }

  onunload() {
    document.querySelectorAll(".recipe-importer-rating").forEach((el) => el.remove());
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

  async prepare(url: string): Promise<Prepared> {
    const res = await requestUrl({ url, headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, throw: false });
    if (res.status >= 400) throw new Error(`The site answered with error ${res.status}.`);
    const html = res.text;
    const json = findRecipeJsonLd(html);
    const recipe = json ? normalizeRecipe(json, url) : null;
    const usable = recipe && (recipe.ingredients.length || recipe.groups.length);

    if (this.settings.apiKey) {
      const markdown = await convertWithClaude({
        apiKey: this.settings.apiKey,
        model: this.settings.model,
        recipe: usable ? recipe : null,
        url,
        pageText: usable ? undefined : pageText(html),
      });
      return { url, recipe, markdown, method: "claude" };
    }
    if (!usable) {
      throw new Error(
        recipe
          ? "This page's recipe data has no ingredients or steps. Add a Claude API key in settings to import it from the page text."
          : "No recipe data found on this page. Add a Claude API key in settings to import it from the page text.",
      );
    }
    return { url, recipe, markdown: toCooklang(recipe!), method: "rules" };
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
        const type = (img.headers["content-type"] || img.headers["Content-Type"] || "").toLowerCase();
        const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
        // Photos go beside the recipe or into the photos folder, per the settings. Either way the recipe's
        // photo property links to it, which the recipe view and the browser both use; Obsidian keeps the
        // link updated when files move or are renamed.
        const photos = this.photosFolder() ?? dir;
        if (!this.app.vault.getAbstractFileByPath(photos)) await this.app.vault.createFolder(photos);
        let photoName = `${base}.${ext}`;
        for (let n = 2; this.app.vault.getAbstractFileByPath(`${photos}/${photoName}`); n++) photoName = `${base} ${n}.${ext}`;
        await this.app.vault.createBinary(`${photos}/${photoName}`, img.arrayBuffer);
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          fm.photo = `[[${photoName}]]`;
        });
      } catch (e) {
        console.warn("Recipe Importer: could not save the photo", e);
        new Notice("Recipe saved, but its photo could not be downloaded.");
      }
    }
    return file;
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
    this.showUrlStep();
  }

  private showUrlStep() {
    const { contentEl } = this;
    contentEl.empty();
    let url = "";
    const status = contentEl.createDiv({ cls: "recipe-importer-status" });
    const go = async () => {
      url = url.trim();
      if (!/^https?:\/\//i.test(url)) {
        status.setText("Enter a link starting with http:// or https://");
        return;
      }
      status.setText(this.plugin.settings.apiKey ? "Fetching the page and converting it with Claude..." : "Fetching the page...");
      button.setDisabled(true);
      try {
        this.prepared = await this.plugin.prepare(url);
        this.showSaveStep();
      } catch (e) {
        status.setText(describeError(e));
        button.setDisabled(false);
      }
    };
    new Setting(contentEl).setName("Recipe link").addText((t) => {
      t.setPlaceholder("https://...").onChange((v) => (url = v));
      t.inputEl.addClass("recipe-importer-url");
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void go();
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    let button: import("obsidian").ButtonComponent;
    new Setting(contentEl).addButton((b) => {
      button = b;
      b.setButtonText("Import").setCta().onClick(() => void go());
    });
    contentEl.appendChild(status);
  }

  private showSaveStep() {
    const p = this.prepared!;
    const { contentEl } = this;
    contentEl.empty();
    const folders = this.plugin.recipeFolders();
    let title = p.recipe?.name ?? (/^title:\s*"?(.*?)"?\s*$/m.exec(p.markdown)?.[1] || "New recipe");
    let folder = (p.recipe && guessFolder(p.recipe, folders)) ?? folders[0] ?? "";

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
        b.setButtonText("Back").onClick(() => {
          this.prepared = null;
          this.showUrlStep();
        }),
      )
      .addButton((b) =>
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
            try {
              const file = await this.plugin.save(p, title, target);
              this.close();
              new Notice(`Imported ${file.basename}`);
              if (this.plugin.settings.openAfterImport) await this.plugin.open(file);
            } catch (e) {
              b.setDisabled(false);
              new Notice(`Could not save the recipe: ${e instanceof Error ? e.message : String(e)}`);
            }
          }),
      );
  }

  onClose() {
    this.contentEl.empty();
  }
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
      .setDesc("A base in the recipes folder that shows every recipe as a photo card, with views by folder, vegan only, favorites, top rated (4 or 5 stars), and a table.")
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


    new Setting(containerEl).setName("Recipe importer: Claude").setHeading();
    const keySetting = new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc(
        "Optional. With a key, Claude converts each recipe (better ingredient marking, and pages without recipe data work). Without one, a built-in converter is used. The key is stored in CooklangPro's data.json, which syncs with your vault.",
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
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Claude Opus 5.5 gives the best results (about 5 cents per recipe). Claude Haiku 5.5 is much cheaper.")
      .addDropdown((d) =>
        d
          .addOption("claude-opus-5-5", "Claude Opus 5.5")
          .addOption("claude-sonnet-5-5", "Claude Sonnet 5.5")
          .addOption("claude-haiku-5-5", "Claude Haiku 5.5")
          .setValue(plugin.settings.model)
          .onChange(async (v) => {
            plugin.settings.model = v;
            await plugin.saveSettings();
            await runCheck();
          }),
      );
}
