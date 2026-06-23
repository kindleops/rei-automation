import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[Diagnostic]') || text.includes('SUSPECT') || text.includes('---') || text.includes('document.')) {
      console.log(text);
    }
  });

  try {
    await page.goto('http://localhost:5173/inbox', { waitUntil: 'networkidle', timeout: 15000 });
    
    // Evaluate in page context to switch theme
    await page.evaluate(() => {
      // Find the settings module if exposed, or just trigger a custom event that might switch it
      localStorage.setItem('nexus-settings', JSON.stringify({ nexusTheme: 'light' }));
      localStorage.setItem('nexus-theme', 'light');
      window.dispatchEvent(new Event('storage'));
    });
    
    // Reload so it boots in light mode
    await page.reload({ waitUntil: 'networkidle' });
    
    await page.waitForTimeout(6000);
  } catch (err) {
    console.error('Error navigating:', err);
  } finally {
    await browser.close();
  }
})();
