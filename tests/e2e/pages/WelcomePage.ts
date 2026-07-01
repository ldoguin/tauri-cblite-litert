import { BasePage } from "./BasePage";

export class WelcomePage extends BasePage {
  get screen() { return $(".welcome-screen"); }
  get title()  { return $(".welcome-title"); }

  /** XPath: button.welcome-tile whose child title span matches `name` exactly. */
  tile(name: string) {
    return $(
      `//button[contains(@class,"welcome-tile")]` +
      `//span[contains(@class,"welcome-tile-title") and normalize-space(text())="${name}"]` +
      `/ancestor::button`
    );
  }

  async isDisplayed() {
    return this.screen.isDisplayed();
  }

  async titleText() {
    return this.text(".welcome-title");
  }

  /** Return all tile titles currently rendered.
   *  Uses browser.execute to avoid WebKit ChainablePromiseArray iteration issues. */
  async tileNames(): Promise<string[]> {
    return browser.execute(() =>
      Array.from(document.querySelectorAll(".welcome-tile-title"))
        .map(el => el.textContent?.trim() ?? "")
    ) as Promise<string[]>;
  }

  async clickTile(name: string) {
    await this.tile(name).click();
    await this.settle();
  }
}

export const welcomePage = new WelcomePage();
