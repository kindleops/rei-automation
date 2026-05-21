import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/inbox');

  const rail = await page.locator('.nx-header-telemetry-rail-v3');
  if (await rail.count() === 0) {
    console.error('❌ Telemetry Rail V3 not found');
    process.exit(1);
  }

  const background = await rail.evaluate(el => window.getComputedStyle(el).backgroundColor);
  console.log(`Rail Background: ${background}`);
  // Expect transparent or extremely subtle (rgba(0,0,0,0) or similar)
  if (!background.includes('rgba(0, 0, 0, 0)') && !background.includes('transparent')) {
    console.warn(`⚠️ Rail has background: ${background}. Ensure this is intentional.`);
  }

  const items = await page.locator('.nx-telemetry-item-v3');
  const count = await items.count();
  console.log(`Telemetry items count: ${count}`);
  if (count < 3) {
    console.error('❌ Missing telemetry items');
    process.exit(1);
  }

  console.log('✅ Telemetry Rail V3 Verified');
  await browser.close();
})();
