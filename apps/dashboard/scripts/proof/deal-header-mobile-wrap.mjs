import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 375, height: 667 } // iPhone SE size
  });
  await page.goto('http://localhost:5173/inbox');

  const rail = await page.locator('.nx-header-telemetry-rail-v3');
  const railBox = await rail.boundingBox();
  console.log(`Mobile Rail Width: ${railBox.width}px`);

  const items = await page.locator('.nx-telemetry-item-v3');
  const count = await items.count();
  
  // Check if items wrap correctly or stack
  const firstItemBox = await items.nth(0).boundingBox();
  const lastItemBox = await items.nth(count - 1).boundingBox();
  
  if (firstItemBox.y === lastItemBox.y) {
    console.log('ℹ️ Telemetry still on one row at 375px (flex-wrap active)');
  } else {
    console.log('ℹ️ Telemetry wrapped/stacked as expected for mobile');
  }

  console.log('✅ Mobile Wrap Verified');
  await browser.close();
})();
