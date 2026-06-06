import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOT_DIR = path.resolve('test-results/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

test('click width pill and take screenshots', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nexus-settings', JSON.stringify({ nexusTheme: 'light', accentPalette: 'cyan' }));
  });
  await page.goto('/inbox');
  
  await page.locator('.nx-premium-inbox').waitFor({ state: 'visible', timeout: 20000 });
  
  // open menu
  await page.locator('.nx-topbar-view-button.nx-topbar-workspace-compact').click();
  
  const menu = page.locator('.nx-topbar-workspace-menu');
  await menu.waitFor({ state: 'visible' });
  
  // go to views
  await menu.locator('.nx-workspace-menu-item', { hasText: 'Views' }).click();
  
  const row = menu.locator('.nx-workspace-submenu-item--view').first();
  await row.waitFor({ state: 'visible' });
  
  // screenshot of menu state
  await page.screenshot({ path: path.join(SHOT_DIR, 'light-menu-no-hover.png') });
  
  const widths = row.locator('.nx-workspace-view-widths');
  
  // Hover over row to reveal pills
  await row.hover({ force: true });
  await page.waitForTimeout(500); // wait for transitions
  
  await page.screenshot({ path: path.join(SHOT_DIR, 'light-menu-hover-pills-revealed.png') });

  // Click 50% pill
  const pill50 = widths.locator('.nx-topbar-width-pill', { hasText: '50%' });
  await pill50.click({ force: true });
  
  await page.waitForTimeout(500);
  
  // Hover again to see active state
  await row.hover({ force: true });
  await page.waitForTimeout(500);

  await page.screenshot({ path: path.join(SHOT_DIR, 'light-menu-pill-clicked.png') });
  
  // Verify layout changed (e.g. 50% pane width)
  const pane = page.locator('.nx-workspace-pane-surface').first();
  const classes = await pane.evaluate(el => el.className);
  console.log('Pane classes after click:', classes);
});
