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
    
    // FORCE LIGHT MODE
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-nexus-theme', 'light');
      localStorage.setItem('nexus-theme', 'light');
    });
    
    // the script in main.tsx waits 4 seconds before running, wait 6
    await page.waitForTimeout(6000);
  } catch (err) {
    console.error('Error navigating:', err);
  } finally {
    await browser.close();
  }
})();
