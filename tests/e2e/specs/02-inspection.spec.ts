import { welcomePage } from "../pages/WelcomePage";
import { inspectionPage } from "../pages/InspectionPage";

describe("Field Inspection", () => {
  before(async () => {
    await welcomePage.waitFor(".welcome-screen", 15_000);
    await welcomePage.clickTile("Field Inspection");
    await inspectionPage.waitFor(".inspect-screen");
  });

  after(async () => {
    await inspectionPage.back();
  });

  it("shows the inspection screen", async () => {
    expect(await inspectionPage.isDisplayed()).toBe(true);
  });

  it("has a search input and New button", async () => {
    expect(await inspectionPage.searchInput.isDisplayed()).toBe(true);
    expect(await inspectionPage.newBtn.isDisplayed()).toBe(true);
  });

  describe("Create", () => {
    let countBefore = 0;

    before(async () => {
      countBefore = await inspectionPage.cardCount();
    });

    it("opens the compose form on clicking New", async () => {
      await inspectionPage.openNew();
      // A form should appear — check for the location input
      expect(await inspectionPage.locationInput.isDisplayed()).toBe(true);
    });

    it("fills in location and notes", async () => {
      await inspectionPage.fillLocation("Warehouse A");
      await inspectionPage.fillNotes("Leaking pipe in section 3. Immediate action required.");
      expect(await inspectionPage.locationInput.getValue()).toBe("Warehouse A");
    });

    it("saves the record and returns to the list", async () => {
      await inspectionPage.save();
      // Should be back on the list
      await inspectionPage.waitFor(".inspect-card", 5_000);
      const countAfter = await inspectionPage.cardCount();
      expect(countAfter).toBe(countBefore + 1);
    });
  });

  describe("Search / Filter", () => {
    it("filters cards by notes text", async () => {
      // The FTS index on _default.inspections covers only the `notes` field.
      // "pipe" appears in the notes created above ("Leaking pipe in section 3").
      const before = await inspectionPage.cardCount();
      expect(before).toBeGreaterThan(0);

      await inspectionPage.search("pipe");
      const filtered = await inspectionPage.cardCount();
      expect(filtered).toBeLessThanOrEqual(before);
      expect(filtered).toBeGreaterThan(0);
    });

    it("shows no results for nonsense query", async () => {
      await inspectionPage.search("xyzzy-no-match-12345");
      const none = await inspectionPage.cardCount();
      expect(none).toBe(0);
    });

    it("restores full list after clearing search", async () => {
      await inspectionPage.clearSearch();
      const restored = await inspectionPage.cardCount();
      expect(restored).toBeGreaterThan(0);
    });
  });

  describe("Create second record", () => {
    it("creates a second distinct record", async () => {
      const before = await inspectionPage.cardCount();
      await inspectionPage.openNew();
      await inspectionPage.fillLocation("Rooftop B");
      await inspectionPage.fillNotes("HVAC unit missing mounting bolt.");
      await inspectionPage.save();
      await inspectionPage.waitFor(".inspect-card", 5_000);
      expect(await inspectionPage.cardCount()).toBe(before + 1);
    });
  });

  describe("Delete", () => {
    it("opens a record detail view", async () => {
      await inspectionPage.openCard(0);
      // Detail view should have a delete button
      await inspectionPage.waitFor("button.btn-sm.danger", 5_000);
      expect(await inspectionPage.deleteBtn.isDisplayed()).toBe(true);
    });

    it("deletes the record and returns to the list", async () => {
      const back = await $(".inspect-detail-back, .demo-back");
      // Read list count from title
      await back.click().catch(() => {});
      const before = await inspectionPage.cardCount();

      await inspectionPage.openCard(0);
      await inspectionPage.waitFor("button.btn-sm.danger", 5_000);
      await inspectionPage.deleteCurrentRecord();
      // Should be back on list with one fewer card
      await inspectionPage.waitFor(".inspect-cards", 5_000);
      const after = await inspectionPage.cardCount();
      expect(after).toBe(before - 1);
    });
  });
});
