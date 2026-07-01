import { BasePage } from "./BasePage";

export class PhotoLibraryPage extends BasePage {
  get screen()        { return $(".photo-screen"); }
  get topbar()        { return $(".photo-topbar"); }
  get importBtn()     { return $("button.demo-action-btn"); }
  get grid()          { return $(".photo-grid"); }
  get cards()         { return $$(".photo-card"); }
  get searchInput()   { return $(".photo-search"); }
  get privacyBanner() { return $(".photo-privacy-banner"); }

  // Tab bar
  get photosTab()     { return $("button.photo-tab=Photos"); }
  get peopleTab()     { return $("button.photo-tab=People"); }

  // Select mode
  get selectBtn()     { return $("button.btn-sm=Select"); }
  get cancelSelectBtn() { return $("button.demo-back"); }

  // Detail view
  get detailImg()     { return $(".photo-detail-img"); }
  get faceBoxes()     { return $$(".photo-face-box"); }
  get deleteBtn()     { return $("button.btn-sm.danger"); }

  // People tab
  get peopleBody()    { return $(".photo-people-body"); }
  get faceStrip()     { return $(".photo-face-strip"); }
  get syncBtn()       { return $(".sync-trigger-btn"); }

  async isDisplayed() {
    return this.screen.isDisplayed();
  }

  async cardCount() {
    return (await this.cards).length;
  }

  async switchToPhotos() {
    await this.photosTab.click();
    await this.settle();
  }

  async switchToPeople() {
    await this.peopleTab.click();
    await this.settle();
  }

  async openCard(index = 0) {
    const cards = await this.cards;
    await cards[index].click();
    await this.settle();
  }

  async enableSelectMode() {
    await this.selectBtn.click();
    await this.settle(200);
  }

  async search(query: string) {
    await this.searchInput.setValue(query);
    await this.settle(400);
  }
}

export const photoLibraryPage = new PhotoLibraryPage();
