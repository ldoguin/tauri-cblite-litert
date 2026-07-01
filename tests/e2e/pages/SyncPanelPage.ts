import { BasePage } from "./BasePage";

export class SyncPanelPage extends BasePage {
  get triggerBtn()   { return $(".sync-trigger-btn"); }
  get drawer()       { return $(".sync-drawer"); }
  get urlInput()     { return $(".sync-drawer input[type='url']"); }
  get usernameInput(){ return $(".sync-drawer input[type='text']"); }
  get passwordInput(){ return $(".sync-drawer input[type='password']"); }
  get directionSel() { return $(".sync-drawer select"); }
  get continuousCb() { return $(".sync-checkbox"); }
  // Combined "CSS-prefix=text" selectors are rejected by WebKitWebDriver;
  // use XPath to match button text inside the drawer instead.
  get startBtn() {
    return $(
      `//div[contains(@class,"sync-drawer")]` +
      `//button[contains(@class,"demo-action-btn") and normalize-space(text())="Start sync"]`,
    );
  }
  get stopBtn() {
    return $(
      `//div[contains(@class,"sync-drawer")]` +
      `//button[contains(@class,"demo-action-btn") and normalize-space(text())="Stop"]`,
    );
  }
  get statusMsg()    { return $(".sync-status-msg"); }
  get statusDot()    { return $(".sync-dot"); }
  get lastSynced()   { return $(".sync-last"); }
  get closeBtn()     { return $(".sync-drawer-header .btn-sm"); }

  async open() {
    const open = await this.drawer.isDisplayed().catch(() => false);
    if (!open) await this.triggerBtn.click();
    await this.waitFor(".sync-drawer");
  }

  async close() {
    await this.closeBtn.click();
    await this.settle(200);
  }

  async isOpen() {
    return this.drawer.isDisplayed().catch(() => false);
  }

  async setUrl(url: string) {
    await this.open();
    await this.urlInput.clearValue();
    await this.urlInput.setValue(url);
  }

  async setCredentials(username: string, password: string) {
    await this.usernameInput.clearValue();
    await this.usernameInput.setValue(username);
    await this.passwordInput.clearValue();
    await this.passwordInput.setValue(password);
  }

  async setDirection(value: "push" | "pull" | "both") {
    await this.directionSel.selectByAttribute("value", value);
  }

  async dotClass() {
    return this.statusDot.getAttribute("class");
  }
}

export const syncPanelPage = new SyncPanelPage();
