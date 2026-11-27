// "Set recipe source": where a recipe came from, as a link, a name, or both. Saved to the `source` property:
// a plain string when there is only one of them, `{ name, url }` when there are both, removed when both are empty.
// Enter saves, Escape closes.

import { App, ButtonComponent, Modal, Notice, Platform, Setting, TFile, TextComponent } from "obsidian";
import { readSource, sourceValue } from "./recipeSource";

export class SourceModal extends Modal {
  constructor(app: App, private file: TFile) {
    super(app);
  }

  onOpen() {
    const { contentEl, modalEl, file } = this;
    modalEl.addClass("cooklang-source-modal", "cooklang-modal");
    contentEl.createDiv({ cls: "cooklang-photo-recipe", text: file.basename });

    const current = readSource(this.app.metadataCache.getFileCache(file)?.frontmatter?.source);
    const has = !!(current.name || current.url);
    this.setTitle(has ? "Edit recipe source" : "Set recipe source");

    // Obsidian's own text fields, so they follow the theme. The link is a plain text field with a URL keyboard:
    // a type="url" field isn't styled by Obsidian.
    let url!: TextComponent;
    let name!: TextComponent;
    new Setting(contentEl).setName("Link").addText((t) => {
      url = t.setPlaceholder("https://…").setValue(current.url);
      t.inputEl.setAttrs({ inputmode: "url", spellcheck: "false", autocapitalize: "none", autocomplete: "off" });
    });
    new Setting(contentEl).setName("Name").setDesc("Optional, e.g. Serious Eats or Grandma's notebook").addText((t) => {
      name = t.setValue(current.name);
      t.inputEl.setAttrs({ spellcheck: "false", autocomplete: "off" });
    });

    const save = () => void this.save(name.getValue(), url.getValue());
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    if (has) {
      new ButtonComponent(buttons).setButtonText("Remove source").setWarning().onClick(() => void this.save("", ""));
      buttons.createDiv({ cls: "cooklang-source-spacer" });
    }
    new ButtonComponent(buttons).setButtonText("Save").setCta().onClick(save);
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    if (!Platform.isMobile) {
      const mod = Platform.isMacOS ? "⌘" : "Ctrl";
      contentEl.createDiv({
        cls: "cooklang-source-keys",
        text: ["Enter save", "Tab next", has ? `${mod}+Delete remove` : "", "Esc close"].filter(Boolean).join("   ·   "),
      });
    }

    // Enter saves from a field; on a button it presses that button.
    this.scope.register([], "Enter", (e) => {
      if (!(e.target instanceof HTMLInputElement)) return true;
      save();
      return false;
    });
    this.scope.register(["Mod"], "Enter", () => (save(), false));
    if (has) {
      const remove = () => (void this.save("", ""), false);
      this.scope.register(["Mod"], "Delete", remove);
      // A Mac keyboard's Delete key is Backspace.
      if (Platform.isMacOS) this.scope.register(["Mod"], "Backspace", (e) => (e.target instanceof HTMLInputElement && e.target.value ? true : remove()));
    }
    window.setTimeout(() => {
      const el = (current.url || !current.name ? url : name).inputEl;
      el.focus();
      el.select();
    }, 0);
  }

  private async save(name: string, url: string) {
    const value = sourceValue(name, url);
    try {
      await this.app.fileManager.processFrontMatter(this.file, (fm: Record<string, unknown>) => {
        if (value === null) delete fm.source;
        else fm.source = value;
      });
      new Notice(value === null ? `Source removed from ${this.file.basename}` : `Source saved for ${this.file.basename}`);
      this.close();
    } catch (e) {
      new Notice(`Couldn't save the source: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
