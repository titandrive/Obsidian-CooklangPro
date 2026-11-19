// "Set recipe photo": pick a photo for a recipe from a web link, a pasted image, a dropped file, or a
// file chosen from this device. One screen, no tabs, and usable from the keyboard:
//   - the link field has focus; Enter sets the photo
//   - Tab reaches the drop area, where Enter or Space opens the file chooser
//   - Ctrl/Cmd+V with an image on the clipboard uses that image
//   - Escape closes
// The download and resize follow MoonSync's cover import.

import { App, ButtonComponent, Modal, requestUrl } from "obsidian";

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

type Source = { kind: "url"; url: string } | { kind: "blob"; blob: Blob; label: string } | null;

export class PhotoModal extends Modal {
  private source: Source = null;
  private objectUrl: string | null = null;

  constructor(
    app: App,
    private recipeName: string,
    private currentPhotoUrl: string | null,
    private onPhoto: (data: ArrayBuffer) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    this.setTitle("Set recipe photo");
    modalEl.addClass("cooklang-photo-modal");
    contentEl.createDiv({ cls: "cooklang-photo-recipe", text: this.recipeName });

    // Drop area: shows the current or chosen photo; click, Enter or Space chooses a file.
    const drop = contentEl.createDiv({
      cls: "cooklang-photo-drop",
      attr: { tabindex: "0", role: "button", "aria-label": "Choose an image file, or drop one here" },
    });
    const img = drop.createEl("img", { cls: "cooklang-photo-img", attr: { alt: "" } });
    const hint = drop.createDiv({ cls: "cooklang-photo-hint" });
    const caption = drop.createDiv({ cls: "cooklang-photo-caption" });
    const input = contentEl.createEl("input", { attr: { type: "file", accept: "image/*", tabindex: "-1" } });
    input.hide();

    const linkRow = contentEl.createDiv({ cls: "cooklang-photo-link" });
    const link = linkRow.createEl("input", {
      attr: { type: "text", placeholder: "Or paste an image link: https://...", "aria-label": "Image link", spellcheck: "false" },
    });

    const status = contentEl.createDiv({ cls: "cooklang-photo-status" });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const save = new ButtonComponent(buttons).setButtonText("Set photo").setCta().setDisabled(true);
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());

    const showImage = (src: string | null, label: string) => {
      if (src) {
        img.src = src;
        img.show();
        drop.addClass("has-image");
      } else {
        img.removeAttribute("src");
        img.hide();
        drop.removeClass("has-image");
      }
      caption.setText(label);
      hint.setText(src ? "Click, drop or paste to use a different image" : "Drop an image here, paste one, or click to choose a file");
    };
    const setSource = (source: Source) => {
      this.source = source;
      status.setText("");
      save.setDisabled(!source);
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
      if (source?.kind === "blob") {
        this.objectUrl = URL.createObjectURL(source.blob);
        showImage(this.objectUrl, source.label);
      } else if (source?.kind === "url") {
        showImage(source.url, "From link");
      } else {
        showImage(this.currentPhotoUrl, this.currentPhotoUrl ? "Current photo" : "");
      }
    };
    img.addEventListener("error", () => {
      if (this.source?.kind === "url") status.setText("That link doesn't load as an image here; it may still work.");
    });
    setSource(null);

    // Choosing, dropping and pasting.
    const useBlob = (blob: Blob | null | undefined, label: string) => {
      if (!blob || !blob.type.startsWith("image/")) {
        status.setText("That isn't an image.");
        return;
      }
      link.value = "";
      setSource({ kind: "blob", blob, label });
    };
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) useBlob(file, file.name);
      input.value = "";
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.addClass("is-dragging");
    });
    drop.addEventListener("dragleave", () => drop.removeClass("is-dragging"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.removeClass("is-dragging");
      const file = e.dataTransfer?.files?.[0];
      if (file) useBlob(file, file.name);
      else {
        const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
        if (url) {
          link.value = url.trim();
          link.dispatchEvent(new Event("input"));
        }
      }
    });
    modalEl.addEventListener("paste", (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (!item) return; // plain text goes into the link field as usual
      e.preventDefault();
      useBlob(item.getAsFile(), "Pasted image");
    });

    link.addEventListener("input", () => {
      const url = link.value.trim();
      if (/^https?:\/\/\S+$/i.test(url)) setSource({ kind: "url", url });
      else if (this.source?.kind === "url" || !url) setSource(this.source?.kind === "blob" ? this.source : null);
    });

    const submit = async () => {
      if (!this.source) {
        status.setText("Choose, drop or paste an image, or paste an image link.");
        return;
      }
      save.setDisabled(true);
      save.setButtonText("Saving...");
      status.setText("");
      try {
        const data =
          this.source.kind === "blob"
            ? await this.source.blob.arrayBuffer()
            : (await requestUrl({ url: this.source.url, headers: { "User-Agent": USER_AGENT } })).arrayBuffer;
        await this.onPhoto(data);
        this.close();
      } catch (e) {
        save.setDisabled(false);
        save.setButtonText("Set photo");
        status.setText(`Couldn't get that image: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    save.onClick(() => void submit());
    // Enter anywhere except on a button or the drop area sets the photo.
    this.scope.register([], "Enter", (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, .cooklang-photo-drop")) return true;
      void submit();
      return false;
    });

    window.setTimeout(() => link.focus(), 0);
  }

  onClose() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.contentEl.empty();
  }
}
