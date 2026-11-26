// "Set recipe source": where a recipe came from, as a link, a name, or both. Saved to the `source` property:
// a plain string when there is only one of them, `{ name, url }` when there are both, removed when both are empty.
// Enter saves, Escape closes.

import { App, ButtonComponent, Modal, Notice, TFile } from "obsidian";
import { readSource, sourceValue } from "./recipeSource";

export class SourceModal extends Modal {
  constructor(app: App, private file: TFile) {
    super(app);
  }

  onOpen() {
    const { contentEl, modalEl, file } = this;
    modalEl.addClass("cooklang-source-modal");
    this.setTitle("Set recipe source");
    contentEl.createDiv({ cls: "cooklang-photo-recipe", text: file.basename });

    const current = readSource(this.app.metadataCache.getFileCache(file)?.frontmatter?.source);
    const field = (label: string, value: string, placeholder: string, type: string) => {
      const row = contentEl.createEl("label", { cls: "cooklang-source-field" });
      row.createSpan({ text: label });
      return row.createEl("input", { attr: { type, value, placeholder, spellcheck: "false", autocapitalize: "none" } });
    };
    const url = field("Link", current.url, "https://…", "url");
    const name = field("Name", current.name, "Optional, e.g. Serious Eats or Grandma's notebook", "text");

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons).setButtonText("Save").setCta().onClick(() => void this.save(name.value, url.value));
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());

    this.scope.register([], "Enter", () => {
      void this.save(name.value, url.value);
      return false;
    });
    window.setTimeout(() => (current.url || !current.name ? url : name).focus(), 0);
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
