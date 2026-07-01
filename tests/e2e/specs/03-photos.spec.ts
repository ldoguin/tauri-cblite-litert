import { welcomePage } from "../pages/WelcomePage";
import { photoLibraryPage } from "../pages/PhotoLibraryPage";

/**
 * Photo Library tests — focused on UI structure and navigation.
 * Actual photo import requires a native file-picker (OS dialog), so we test
 * everything reachable without dismissing a system dialog.
 */
describe("Photo Library", () => {
  before(async () => {
    await welcomePage.waitFor(".welcome-screen", 15_000);
    await welcomePage.clickTile("Photo Library");
    await photoLibraryPage.waitFor(".photo-screen");
  });

  after(async () => {
    await photoLibraryPage.back();
  });

  it("shows the photo screen", async () => {
    expect(await photoLibraryPage.isDisplayed()).toBe(true);
  });

  it("renders the topbar", async () => {
    expect(await photoLibraryPage.topbar.isDisplayed()).toBe(true);
  });

  it("shows the Import button", async () => {
    expect(await photoLibraryPage.importBtn.isDisplayed()).toBe(true);
    const label = await photoLibraryPage.importBtn.getText();
    expect(label).toMatch(/import/i);
  });

  it("shows the Sync button", async () => {
    expect(await photoLibraryPage.syncBtn.isDisplayed()).toBe(true);
  });

  it("renders the photo grid container", async () => {
    expect(await photoLibraryPage.grid.isDisplayed()).toBe(true);
  });

  describe("Tab bar", () => {
    it("has Photos and People tabs", async () => {
      expect(await photoLibraryPage.photosTab.isDisplayed()).toBe(true);
      expect(await photoLibraryPage.peopleTab.isDisplayed()).toBe(true);
    });

    it("switches to People tab", async () => {
      await photoLibraryPage.switchToPeople();
      expect(await photoLibraryPage.peopleBody.isDisplayed()).toBe(true);
    });

    it("switches back to Photos tab", async () => {
      await photoLibraryPage.switchToPhotos();
      expect(await photoLibraryPage.grid.isDisplayed()).toBe(true);
    });
  });

  describe("Select mode", () => {
    it("has a Select button in the topbar", async () => {
      expect(await photoLibraryPage.selectBtn.isDisplayed()).toBe(true);
    });

    it("entering select mode changes the grid class", async () => {
      await photoLibraryPage.enableSelectMode();
      // grid should have --select modifier or a cancel button should appear
      const gridClass = await photoLibraryPage.grid.getAttribute("class");
      const cancelVisible = await $("button*=Cancel").isDisplayed().catch(() => false);
      expect(gridClass.includes("select") || cancelVisible).toBe(true);
    });

    it("cancel exits select mode", async () => {
      // Either press Escape or click cancel
      await browser.keys("Escape").catch(() => {});
      const cancelBtn = await $("button*=Cancel");
      if (await cancelBtn.isDisplayed().catch(() => false)) {
        await cancelBtn.click();
      }
      await photoLibraryPage.settle(300);
      const gridClass = await photoLibraryPage.grid.getAttribute("class");
      expect(gridClass.includes("select")).toBe(false);
    });
  });
});
