import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/inbox');

  // 1. Verify Deal Header V2 Polish
  const header = await page.locator('.nx-dossier-header-v3');
  if (await header.count() === 0) {
    console.error('❌ Deal Command Header V3 not found');
    process.exit(1);
  }

  const name = await page.locator('.nx-header-name-v3');
  const nameFontSize = await name.evaluate(el => window.getComputedStyle(el).fontSize);
  console.log(`Header Name Font Size: ${nameFontSize}`);
  if (parseInt(nameFontSize) > 17) {
    console.error('❌ Header Name typography still oversized');
    process.exit(1);
  }

  const meta = await page.locator('.nx-header-meta-v3');
  const metaText = await meta.innerText();
  console.log(`Metadata: ${metaText}`);
  if (!metaText.includes('•')) {
    console.error('❌ Metadata divider missing');
    process.exit(1);
  }

  const interest = await page.locator('.nx-header-interest-v3');
  const interestHeight = await interest.evaluate(el => el.offsetHeight);
  console.log(`Interest Card Height: ${interestHeight}px`);
  if (interestHeight > 30) {
    console.error('❌ Interest Card still too dominant');
    process.exit(1);
  }

  console.log('✅ Deal Header V2 Polish Verified');
  await browser.close();
})();
