export class BasePage {
  /** Wait for a React render cycle after navigation. */
  async settle(ms = 400) {
    await browser.pause(ms);
  }

  /** Click the back/breadcrumb button present in every feature screen. */
  async back() {
    await $(".demo-back").click();
    await this.settle();
  }

  /** True when the welcome screen is currently visible. */
  async onWelcome() {
    return $(".welcome-screen").isDisplayed();
  }

  /** Wait until an element matching `selector` is displayed, up to `ms`. */
  async waitFor(selector: string, ms = 8_000) {
    await $(selector).waitForDisplayed({ timeout: ms });
  }

  /** Return the trimmed text content of an element. */
  async text(selector: string) {
    return (await $(selector).getText()).trim();
  }
}
