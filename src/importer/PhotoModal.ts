// "Set recipe photo": pick a photo for a recipe from a web link or a file on this device.
// Modelled on MoonSync's cover import (a link tab, download, resize), with a file tab added.

import { App, Modal, Setting, requestUrl } from "obsidian";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** Largest width or height kept: sharp on a phone, without multi-megabyte files. */
const MAX_SIZE = 1200;

/** Scales an image down to MAX_SIZE and re-encodes it as JPEG; returns the original if that fails. */
export async function resizePhoto(data: ArrayBuffer): Promise<{ data: ArrayBuffer; ext: string }> {
  try {
    const bitmap = await createImageBitmap(new Blob([data]));
    const scale = Math.min(1, MAX_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob) throw new Error("could not encode");
    return { data: await blob.arrayBuffer(), ext: "jpg" };
  } catch {
    return { data, ext: "jpg" };
  }
}

export class PhotoModal extends Modal {
  private url = "";
  private file: File | null = null;

  constructor(
    app: App,
    private recipeName: string,
    private onPhoto: (data: ArrayBuffer) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle("Set recipe photo");
    contentEl.addClass("cooklang-photo-modal");
    contentEl.createEl("p", { text: this.recipeName, cls: "setting-item-description" });

    const tabNav = contentEl.createDiv({ cls: "cooklang-photo-tabs" });
    const linkTab = tabNav.createEl("button", { text: "From a link", cls: "is-active" });
    const fileTab = tabNav.createEl("button", { text: "From a file" });
    const linkPane = contentEl.createDiv({ cls: "cooklang-photo-pane is-active" });
    const filePane = contentEl.createDiv({ cls: "cooklang-photo-pane" });
    const show = (tab: HTMLElement, pane: HTMLElement) => {
      [linkTab, fileTab].forEach((t) => t.toggleClass("is-active", t === tab));
      [linkPane, filePane].forEach((p) => p.toggleClass("is-active", p === pane));
    };
    linkTab.addEventListener("click", () => show(linkTab, linkPane));
    fileTab.addEventListener("click", () => show(fileTab, filePane));

    const preview = contentEl.createEl("img", { cls: "cooklang-photo-preview" });
    preview.hide();
    const status = contentEl.createDiv({ cls: "cooklang-photo-status setting-item-description" });

    // From a link
    new Setting(linkPane).setName("Image link").addText((t) => {
      t.setPlaceholder("https://example.com/photo.jpg").onChange((v) => {
        this.url = v.trim();
        if (/^https?:\/\//i.test(this.url)) {
          preview.src = this.url;
          preview.show();
        } else preview.hide();
      });
      t.inputEl.addClass("recipe-importer-url");
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void save();
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    // From a file
    const input = filePane.createEl("input", { attr: { type: "file", accept: "image/*" } });
    input.hide();
    const chosen = new Setting(filePane).setName("Image file").setDesc("No file chosen.");
    chosen.addButton((b) => b.setButtonText("Choose image").onClick(() => input.click()));
    input.addEventListener("change", () => {
      this.file = input.files?.[0] ?? null;
      chosen.setDesc(this.file ? this.file.name : "No file chosen.");
      if (this.file) {
        preview.src = URL.createObjectURL(this.file);
        preview.show();
      }
    });

    let button: import("obsidian").ButtonComponent;
    const save = async () => {
      const fromFile = filePane.hasClass("is-active");
      if (fromFile ? !this.file : !/^https?:\/\//i.test(this.url)) {
        status.setText(fromFile ? "Choose an image first." : "Enter a link starting with http:// or https://");
        return;
      }
      button.setDisabled(true);
      status.setText("Saving the photo...");
      try {
        const data = fromFile
          ? await this.file!.arrayBuffer()
          : (await requestUrl({ url: this.url, headers: { "User-Agent": USER_AGENT } })).arrayBuffer;
        await this.onPhoto(data);
        this.close();
      } catch (e) {
        button.setDisabled(false);
        status.setText(`Could not get that image: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    new Setting(contentEl).addButton((b) => {
      button = b;
      b.setButtonText("Set photo").setCta().onClick(() => void save());
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
