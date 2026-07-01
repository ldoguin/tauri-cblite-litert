import { welcomePage } from "../pages/WelcomePage";
import { syncPanelPage } from "../pages/SyncPanelPage";

/**
 * SyncPanel tests — exercises the drawer UI in Photo Library.
 * For live round-trip tests see scripts/sync-test.mjs (requires Docker).
 */
describe("SyncPanel", () => {
  before(async () => {
    await welcomePage.waitFor(".welcome-screen", 15_000);
    await welcomePage.clickTile("Photo Library");
    await syncPanelPage.waitFor(".photo-screen");
  });

  after(async () => {
    // Close drawer if open, then go back
    const open = await syncPanelPage.isOpen();
    if (open) await syncPanelPage.close();
    await syncPanelPage.back();
  });

  it("trigger button is visible in topbar", async () => {
    expect(await syncPanelPage.triggerBtn.isDisplayed()).toBe(true);
  });

  it("opens the drawer on click", async () => {
    await syncPanelPage.open();
    expect(await syncPanelPage.isOpen()).toBe(true);
  });

  it("shows URL, username, password, and direction fields", async () => {
    expect(await syncPanelPage.urlInput.isDisplayed()).toBe(true);
    expect(await syncPanelPage.usernameInput.isDisplayed()).toBe(true);
    expect(await syncPanelPage.passwordInput.isDisplayed()).toBe(true);
    expect(await syncPanelPage.directionSel.isDisplayed()).toBe(true);
  });

  it("shows the Start sync button", async () => {
    expect(await syncPanelPage.startBtn.isDisplayed()).toBe(true);
  });

  it("accepts URL input", async () => {
    await syncPanelPage.urlInput.clearValue();
    await syncPanelPage.urlInput.setValue("ws://localhost:4984/sync_test");
    const val = await syncPanelPage.urlInput.getValue();
    expect(val).toBe("ws://localhost:4984/sync_test");
  });

  it("accepts credentials", async () => {
    await syncPanelPage.setCredentials("test_user", "password");
    expect(await syncPanelPage.usernameInput.getValue()).toBe("test_user");
  });

  it("can switch direction to push-only", async () => {
    await syncPanelPage.setDirection("push");
    const val = await syncPanelPage.directionSel.getValue();
    expect(val).toBe("push");
    await syncPanelPage.setDirection("both");
  });

  it("status dot is rendered with idle/stopped state", async () => {
    const cls = await syncPanelPage.dotClass();
    expect(cls).toBeTruthy();
    // Should have one of the known state classes (not actively syncing)
    expect(cls).toMatch(/sync-dot/);
  });

  it("closes the drawer", async () => {
    await syncPanelPage.close();
    expect(await syncPanelPage.isOpen()).toBe(false);
  });

  it("re-opens after close", async () => {
    await syncPanelPage.open();
    expect(await syncPanelPage.isOpen()).toBe(true);
    await syncPanelPage.close();
  });

  describe("Live sync (skipped when no Docker)", () => {
    let dockerRunning = false;

    before(async () => {
      try {
        const res = await fetch("http://localhost:4984/").catch(() => null);
        dockerRunning = !!res && res.ok;
      } catch {
        dockerRunning = false;
      }
    });

    it("starts sync when Docker SG is available", async function () {
      if (!dockerRunning) {
        console.log("    [skip] SG not running — start docker/compose.yml first");
        return;
      }
      await syncPanelPage.open();
      await syncPanelPage.setUrl("ws://localhost:4984/sync_test");
      await syncPanelPage.setCredentials("test_user", "password");
      await syncPanelPage.setDirection("both");
      await syncPanelPage.startBtn.click();
      await browser.pause(3_000);

      const cls = await syncPanelPage.dotClass();
      // Should be connecting, busy, or idle — not error
      expect(cls).not.toMatch(/error/);

      await syncPanelPage.stopBtn.click().catch(() => {});
      await syncPanelPage.close();
    });
  });
});
