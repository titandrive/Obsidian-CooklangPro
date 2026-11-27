// "Edit tags": add, rename and remove the tags of one recipe or several at once.
//
// Opened from a card's right-click menu in the recipe browser (for the selected cards when several are
// selected), the file explorer's menu, the "Edit recipe tags" command, and the pencil beside a recipe's tags.
// Nothing is saved until Save.
//
// Keyboard: the add box has focus. Enter adds what's typed (or the highlighted suggestion), Enter in an empty
// box saves, Backspace in an empty box removes the last tag, Ctrl/Cmd+Enter saves from anywhere. On a tag:
// Enter renames it, Delete or Backspace removes it (again to undo).

import { AbstractInputSuggest, App, ButtonComponent, Modal, Notice, Platform, TFile, setIcon } from "obsidian";
import { applyTagStates, initialStates, normalizeTag, readTags, tagsChanged, type TagState } from "./tagEdits";

class TagSuggest extends AbstractInputSuggest<[string, number]> {
  isShown = false;
  /** Down arrow in the empty box lists every tag; otherwise the list waits for typing. */
  browsing = false;

  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private tags: () => [string, number][],
    private taken: () => Set<string>,
    private pick: (tag: string) => void,
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): [string, number][] {
    const q = normalizeTag(query);
    const taken = this.taken();
    const all = this.tags().filter(([t]) => !taken.has(t));
    if (!q) return this.browsing ? all.slice(0, 30) : [];
    // Tags starting with what's typed first, then ones containing it.
    const starts = all.filter(([t]) => t.startsWith(q));
    const contains = all.filter(([t]) => !t.startsWith(q) && t.includes(q));
    return [...starts, ...contains].slice(0, 30);
  }

  renderSuggestion([tag, count]: [string, number], el: HTMLElement): void {
    el.addClass("cooklang-tag-suggestion");
    el.createSpan({ text: tag });
    el.createSpan({ cls: "cooklang-tag-suggestion-count", text: String(count) });
  }

  selectSuggestion([tag]: [string, number]): void {
    this.pick(tag);
    this.inputEl.value = "";
    this.close();
  }

  open(): void {
    super.open();
    this.isShown = true;
  }

  close(): void {
    super.close();
    this.isShown = false;
    this.browsing = false;
  }
}

export class TagEditorModal extends Modal {
  private states: TagState[] = [];
  private lists: string[][] = [];
  private renaming: TagState | null = null;
  private rendering = false;
  private chipsEl!: HTMLElement;
  private input!: HTMLInputElement;
  private save!: ButtonComponent;
  private suggest!: TagSuggest;

  constructor(
    app: App,
    private files: TFile[],
    /** Every recipe tag with how many recipes use it, most used first, for suggestions. */
    private knownTags: () => [string, number][],
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, modalEl, files } = this;
    modalEl.addClass("cooklang-tag-editor", "cooklang-modal");
    this.setTitle("Edit tags");
    const many = files.length > 1;
    const sub = contentEl.createDiv({ cls: "cooklang-tag-editor-target" });
    sub.setText(many ? `${files.length} recipes` : files[0].basename);
    if (many) sub.setAttr("title", files.map((f) => f.basename).join("\n"));

    this.lists = files.map((f) => readTags(this.app.metadataCache.getFileCache(f)?.frontmatter?.tags));
    this.states = initialStates(this.lists);

    this.chipsEl = contentEl.createDiv({ cls: "cooklang-tag-chips" });
    const addRow = contentEl.createDiv({ cls: "cooklang-tag-add" });
    setIcon(addRow.createSpan({ cls: "cooklang-tag-add-icon" }), "plus");
    this.input = addRow.createEl("input", {
      attr: { type: "text", placeholder: many ? "Add a tag to all of them" : "Add a tag", "aria-label": "Add a tag", spellcheck: "false", autocapitalize: "none" },
    });
    this.suggest = new TagSuggest(this.app, this.input, this.knownTags, () => this.names(), (t) => this.add(t));

    if (many) {
      contentEl.createDiv({
        cls: "cooklang-tag-editor-note",
        text: "A tag marked 2/5 is on some of them: + adds it to all. Renaming or removing a tag changes it on every recipe that has it.",
      });
    }

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    this.save = new ButtonComponent(buttons).setButtonText("Save").setCta().onClick(() => void this.commit());
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    const mod = Platform.isMacOS ? "⌘" : "Ctrl";
    if (!Platform.isMobile) {
      contentEl.createDiv({ cls: "cooklang-tag-editor-keys", text: `Enter add   ·   ↓ all tags   ·   ${mod}+Enter save   ·   Esc close` });
    }

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !this.input.value && !this.suggest.isShown) {
        e.preventDefault();
        this.suggest.browsing = true;
        this.input.dispatchEvent(new Event("input"));
        return;
      }
      if (e.key === "," || (e.key === " " && !this.suggest.isShown)) {
        // A comma (or a space) finishes a tag, like in most tag boxes.
        if (this.input.value.trim()) {
          e.preventDefault();
          this.addTyped();
        }
      } else if (e.key === "Backspace" && !this.input.value) {
        const last = [...this.states].reverse().find((s) => !s.removed);
        if (last) {
          e.preventDefault();
          this.toggleRemoved(last);
        }
      }
    });
    this.scope.register(["Mod"], "Enter", () => {
      void this.commit();
      return false;
    });
    this.scope.register([], "Enter", (e) => {
      if (e.target !== this.input) return true;
      if (this.suggest.isShown) return true; // the suggestion list handles it
      if (this.input.value.trim()) this.addTyped();
      else void this.commit();
      return false;
    });

    this.render();
    window.setTimeout(() => this.input.focus(), 0);
  }

  /** The names the tags will have: what's taken, for suggestions and duplicates. */
  private names(): Set<string> {
    return new Set(this.states.filter((s) => !s.removed).map((s) => s.name));
  }

  private addTyped() {
    this.add(this.input.value);
    this.input.value = "";
    this.suggest.close();
  }

  private add(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag) return;
    const existing = this.states.find((s) => s.name === tag);
    if (existing) {
      // Already listed: bring it back if removed, and put it on every recipe.
      existing.removed = false;
      existing.toAll = true;
    } else {
      this.states.push({ original: null, name: tag, removed: false, toAll: true, count: 0 });
    }
    this.render();
  }

  private toggleRemoved(s: TagState) {
    if (s.original === null && !s.removed) this.states.splice(this.states.indexOf(s), 1);
    else s.removed = !s.removed;
    this.render();
  }

  private render() {
    const n = this.files.length;
    const el = this.chipsEl;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.tag;
    this.rendering = true;
    el.empty();
    this.rendering = false;
    if (!this.states.length) el.createSpan({ cls: "cooklang-tag-empty", text: "No tags yet." });
    for (const s of this.states) {
      const chip = el.createDiv({ cls: "cooklang-tag-chip" });
      chip.toggleClass("is-removed", s.removed);
      chip.toggleClass("is-new", s.original === null);
      chip.toggleClass("is-renamed", s.original !== null && s.name !== s.original);
      const partial = n > 1 && s.original !== null && !s.toAll && s.count < n;
      chip.toggleClass("is-partial", partial);

      if (this.renaming === s) {
        const edit = chip.createEl("input", { cls: "cooklang-tag-rename", attr: { type: "text", value: s.name, "aria-label": `Rename ${s.name}`, spellcheck: "false" } });
        const done = (keep: boolean) => {
          if (this.renaming !== s || this.rendering) return;
          this.renaming = null;
          const name = normalizeTag(edit.value);
          if (keep && name) {
            // Renaming onto another tag merges the two.
            const other = this.states.find((x) => x !== s && !x.removed && x.name === name);
            if (other && other.original === null) this.states.splice(this.states.indexOf(other), 1);
            s.name = name;
          }
          this.render();
          window.setTimeout(() => (el.querySelector<HTMLElement>(`[data-tag="${CSS.escape(s.name)}"]`) ?? this.input).focus(), 0);
        };
        edit.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            done(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done(false);
          }
        });
        edit.addEventListener("blur", () => done(true));
        window.setTimeout(() => {
          edit.focus();
          edit.select();
        }, 0);
        continue;
      }

      const name = chip.createEl("button", {
        cls: "cooklang-tag-name",
        text: `#${s.name}`,
        attr: { type: "button", "data-tag": s.name, "aria-label": s.removed ? `${s.name}, removed` : `Rename ${s.name}` },
      });
      if (s.original !== null && s.name !== s.original) name.setAttr("title", `Was #${s.original}`);
      name.addEventListener("click", () => {
        if (s.removed) return;
        this.renaming = s;
        this.render();
      });
      name.addEventListener("keydown", (e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          this.toggleRemoved(s);
          window.setTimeout(() => el.querySelector<HTMLElement>(`[data-tag="${CSS.escape(s.name)}"]`)?.focus(), 0);
        }
      });
      if (partial) {
        const all = chip.createEl("button", { cls: "cooklang-tag-count", attr: { type: "button", "aria-label": `On ${s.count} of ${n}. Add to all` } });
        all.createSpan({ text: `${s.count}/${n}` });
        setIcon(all.createSpan({ cls: "cooklang-tag-count-plus" }), "plus");
        all.addEventListener("click", () => {
          s.toAll = true;
          this.render();
        });
      }
      const x = chip.createEl("button", {
        cls: "cooklang-tag-remove",
        attr: { type: "button", "aria-label": s.removed ? `Keep ${s.name}` : `Remove ${s.name}`, tabindex: "-1" },
      });
      setIcon(x, s.removed ? "undo-2" : "x");
      x.addEventListener("click", () => this.toggleRemoved(s));
    }
    if (focused) el.querySelector<HTMLElement>(`[data-tag="${CSS.escape(focused)}"]`)?.focus();
    this.save.setDisabled(!tagsChanged(this.lists, this.states));
  }

  private async commit() {
    if (this.renaming) return;
    if (this.input.value.trim()) this.addTyped();
    if (!tagsChanged(this.lists, this.states)) {
      this.close();
      return;
    }
    this.save.setDisabled(true);
    let changed = 0;
    try {
      for (const file of this.files) {
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          const before = readTags(fm.tags);
          const after = applyTagStates(before, this.states);
          if (after.length === before.length && after.every((t, i) => t === before[i])) return;
          changed++;
          if (after.length) fm.tags = after;
          else delete fm.tags;
        });
      }
      new Notice(changed === 1 && this.files.length === 1 ? `Tags saved for ${this.files[0].basename}` : `Tags saved on ${changed} recipe${changed === 1 ? "" : "s"}`);
      this.close();
    } catch (e) {
      this.save.setDisabled(false);
      new Notice(`Couldn't save the tags: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
