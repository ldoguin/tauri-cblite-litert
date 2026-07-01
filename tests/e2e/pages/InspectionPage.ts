import { BasePage } from "./BasePage";

export class InspectionPage extends BasePage {
  get screen()       { return $(".inspect-screen"); }
  get newBtn()       { return $(".inspect-new-btn"); }
  get searchInput()  { return $(".inspect-search"); }
  get countLabel()   { return $(".inspect-count"); }

  // Compose form
  get locationInput()  { return $("input.inspect-input"); }
  get notesTextarea()  { return $("textarea.inspect-textarea"); }

  // Detail view
  get deleteBtn()      { return $("button.btn-sm.danger"); }

  async isDisplayed() {
    return this.screen.isDisplayed();
  }

  /** Count cards via DOM — avoids ChainablePromiseArray issues in WebKit. */
  async cardCount(): Promise<number> {
    return browser.execute(() =>
      document.querySelectorAll(".inspect-card").length
    ) as Promise<number>;
  }

  async openNew() {
    await this.newBtn.click();
    await this.settle();
  }

  async fillLocation(value: string) {
    const el = await this.locationInput;
    await el.clearValue();
    await el.setValue(value);
  }

  async fillNotes(value: string) {
    const el = await this.notesTextarea;
    await el.clearValue();
    await el.setValue(value);
  }

  /**
   * Save the current compose form via Tauri IPC, bypassing the
   * photo-required guard in the UI (disabled={!photoDataUrl}).
   *
   * After saving, navigates away and back so the FieldInspection
   * component remounts and its useEffect triggers reload(), making
   * the new record visible in the list.
   */
  async save() {
    const loc   = await this.locationInput.getValue().catch(() => "e2e-location");
    const notes = await this.notesTextarea.getValue().catch(() => "e2e-notes");

    // browser.executeAsync properly awaits async Tauri IPC.
    await browser.executeAsync((
      location: string,
      nt: string,
      done: (r?: unknown) => void,
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
      if (!invoke) { done(); return; }
      const now = new Date().toISOString();
      invoke("plugin:cblite|save_document", {
        collection: "_default.inspections",
        docId: `e2e-${Date.now()}`,
        body: {
          createdAt: now, updatedAt: now,
          location, assetId: "", category: "General", severity: "low",
          notes: nt, photoRef: "", detections: [], aiReport: "", synced: false,
        },
        encryptedFields: null,
      }).then(() => done()).catch(() => done());
    }, loc, notes);

    // Go back: compose → list → welcome
    await $(".demo-back").click();
    await this.settle(200);
    await $(".demo-back").click();
    await this.settle(200);

    // Re-enter inspection. Component remounts → useEffect → reload() → new card visible.
    await $(
      `//button[contains(@class,"welcome-tile")]` +
      `//span[contains(@class,"welcome-tile-title") and normalize-space(text())="Field Inspection"]` +
      `/ancestor::button`,
    ).click();
    await this.waitFor(".inspect-screen");
    await this.settle(800);
  }

  async search(query: string) {
    await this.searchInput.clearValue();
    await this.searchInput.setValue(query);
    await this.settle(500);
  }

  async clearSearch() {
    // element.clearValue() uses WebDriver's element.clear which does NOT fire
    // React's `input` event (just clears the DOM value internally).
    // Instead: focus → Ctrl+A → Backspace generates real WebKit keyboard events
    // that produce a native `input` event; React intercepts it at its root
    // listener and calls setSearchQ("").
    await this.searchInput.click();
    await browser.keys(["Control", "a"]);
    await browser.keys(["Backspace"]);
    await this.settle(700);
  }

  /** Open a card by 0-based index via DOM click — bypasses wdio $$-indexing issues. */
  async openCard(index = 0) {
    await browser.execute((i: number) => {
      const cards = document.querySelectorAll(".inspect-card");
      (cards[i] as HTMLElement | undefined)?.click();
    }, index);
    await this.settle();
  }

  async deleteCurrentRecord() {
    await this.deleteBtn.click();
    await this.settle(600);
  }
}

export const inspectionPage = new InspectionPage();
