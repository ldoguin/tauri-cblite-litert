import { welcomePage } from "../pages/WelcomePage";

const EXPECTED_TILES = [
  "AI Assistant",
  "Fitness Coach",
  "Background Studio",
  "Scene Describer",
  "Fashion Shop",
  "Fashion Oracle",
  "Field Inspection",
  "Clinical Notes",
  "Photo Library",
  "Dataset Annotator",
  "Task Models",
  "Settings",
];

/** Ensure we are on the welcome screen before each test. */
async function resetToWelcome() {
  if (await welcomePage.isDisplayed().catch(() => false)) return;
  // Try the most common back buttons in order
  for (const sel of [".demo-back", ".nav-back-btn", "button.icon-btn"]) {
    const btn = await $(sel);
    if (await btn.isDisplayed().catch(() => false)) {
      await btn.click();
      await welcomePage.settle(300);
      if (await welcomePage.isDisplayed().catch(() => false)) return;
    }
  }
  // Nuclear fallback: reload the app
  await browser.refresh();
  await welcomePage.waitFor(".welcome-screen", 15_000);
}

describe("Welcome screen", () => {
  before(async () => {
    await welcomePage.waitFor(".welcome-screen", 15_000);
  });

  afterEach(async () => {
    await resetToWelcome();
  });

  it("displays the welcome screen on launch", async () => {
    expect(await welcomePage.isDisplayed()).toBe(true);
  });

  it("shows the correct heading", async () => {
    expect(await welcomePage.titleText()).toBe("Welcome");
  });

  it("renders all expected tiles", async () => {
    const names = await welcomePage.tileNames();
    for (const expected of EXPECTED_TILES) {
      expect(names).toContain(expected);
    }
  });

  it("navigates to Field Inspection and back", async () => {
    await welcomePage.clickTile("Field Inspection");
    await welcomePage.waitFor(".inspect-screen");
    expect(await $(".inspect-screen").isDisplayed()).toBe(true);
    await welcomePage.back();
    expect(await welcomePage.isDisplayed()).toBe(true);
  });

  it("navigates to Photo Library and back", async () => {
    await welcomePage.clickTile("Photo Library");
    await welcomePage.waitFor(".photo-screen");
    expect(await $(".photo-screen").isDisplayed()).toBe(true);
    await welcomePage.back();
    expect(await welcomePage.isDisplayed()).toBe(true);
  });

  it("navigates to Dataset Annotator and back", async () => {
    await welcomePage.clickTile("Dataset Annotator");
    await welcomePage.waitFor(".annot-screen");
    expect(await $(".annot-screen").isDisplayed()).toBe(true);
    await welcomePage.back();
    expect(await welcomePage.isDisplayed()).toBe(true);
  });

  it("navigates to Settings and back", async () => {
    await welcomePage.clickTile("Settings");
    // Settings renders as div.panel.embedded-panel — no .settings-panel class
    await welcomePage.waitFor(".panel");
    expect(await $(".panel").isDisplayed()).toBe(true);
    // Close button in SettingsPanel header
    await $("button.icon-btn").click();
    await welcomePage.settle();
    expect(await welcomePage.isDisplayed()).toBe(true);
  });

  it("navigates to AI Assistant (chat view)", async () => {
    await welcomePage.clickTile("AI Assistant");
    // Chat renders sidebar + sidebar-wrap
    await welcomePage.waitFor(".sidebar");
    expect(await $(".sidebar").isDisplayed()).toBe(true);
    // nav-back-btn is the back arrow in the sidebar header
    await $(".nav-back-btn").click();
    await welcomePage.settle(400);
    expect(await welcomePage.isDisplayed()).toBe(true);
  });
});
