/**
 * workspace-menu-rebuild.spec.ts
 * Proves the workspace menu pills render INSIDE the hovered row,
 * are clickable, and that layout state changes correctly.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve('test-results/workspace-rebuild');
fs.mkdirSync(SHOTS, { recursive: true });

async function openViewsPanel(page: import('@playwright/test').Page, theme: string) {
  await page.addInitScript((t) => {
    localStorage.setItem('nexus-settings', JSON.stringify({ nexusTheme: t, accentPalette: 'violet' }));
  }, theme);
  await page.goto('/inbox');
  await page.locator('.nx-premium-inbox').waitFor({ state: 'visible', timeout: 20000 });
  // open workspace menu
  await page.locator('.nx-topbar-view-button.nx-topbar-workspace-compact').click();
  const menu = page.locator('.nx-topbar-workspace-menu');
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  // navigate to Views
  await menu.locator('.nx-workspace-menu-item', { hasText: 'Views' }).click();
  // wait for a view row to appear
  await menu.locator('.nx-wsv-row').first().waitFor({ state: 'visible', timeout: 5000 });
  return menu;
}

test('light theme — pills inside hovered row', async ({ page }) => {
  const menu = await openViewsPanel(page, 'light');

  await page.screenshot({ path: path.join(SHOTS, 'light-menu-default.png') });

  const rows = menu.locator('.nx-wsv-row');
  const firstRow = rows.first();
  const pills = firstRow.locator('.nx-wsv-row__pills');

  // Pills should be in DOM but invisible before hover
  const opacityBefore = await pills.evaluate(el => window.getComputedStyle(el).opacity);
  expect(parseFloat(opacityBefore)).toBeLessThan(0.5);

  // Hover the row
  await firstRow.hover({ force: true });
  await page.waitForTimeout(300);

  // Screenshot: pills should now be visible INSIDE the hovered row
  await page.screenshot({ path: path.join(SHOTS, 'light-menu-pills-revealed.png') });

  const opacityAfter = await pills.evaluate(el => window.getComputedStyle(el).opacity);
  expect(parseFloat(opacityAfter)).toBeGreaterThan(0.9);

  // Assert pills are spatially INSIDE the row bounding box
  const rowBox = await firstRow.boundingBox();
  const pillsBox = await pills.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(pillsBox).not.toBeNull();

  if (rowBox && pillsBox) {
    // Pills left edge must be AFTER the row left edge
    expect(pillsBox.x).toBeGreaterThan(rowBox.x);
    // Pills right edge must be BEFORE (or equal to) the row right edge
    expect(pillsBox.x + pillsBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 2);
    // Pills vertical center must be inside the row
    const pillsCenterY = pillsBox.y + pillsBox.height / 2;
    expect(pillsCenterY).toBeGreaterThan(rowBox.y);
    expect(pillsCenterY).toBeLessThan(rowBox.y + rowBox.height);
    console.log(`[light] Row: x=${rowBox.x} w=${rowBox.width} | Pills: x=${pillsBox.x} w=${pillsBox.width}`);
  }
});

test('dark theme — pills inside hovered row', async ({ page }) => {
  const menu = await openViewsPanel(page, 'dark');

  const firstRow = menu.locator('.nx-wsv-row').first();
  await firstRow.hover({ force: true });
  await page.waitForTimeout(300);

  await page.screenshot({ path: path.join(SHOTS, 'dark-menu-pills-revealed.png') });

  const rowBox = await firstRow.boundingBox();
  const pillsBox = await firstRow.locator('.nx-wsv-row__pills').boundingBox();
  expect(rowBox).not.toBeNull();
  expect(pillsBox).not.toBeNull();
  if (rowBox && pillsBox) {
    expect(pillsBox.x + pillsBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 4);
    console.log(`[dark] Row: x=${rowBox.x} w=${rowBox.width} | Pills: x=${pillsBox.x} w=${pillsBox.width}`);
  }
});

test('red_ops theme — pills inside hovered row', async ({ page }) => {
  const menu = await openViewsPanel(page, 'red_ops');

  const firstRow = menu.locator('.nx-wsv-row').first();
  await firstRow.hover({ force: true });
  await page.waitForTimeout(300);

  await page.screenshot({ path: path.join(SHOTS, 'redops-menu-pills-revealed.png') });

  const rowBox = await firstRow.boundingBox();
  const pillsBox = await firstRow.locator('.nx-wsv-row__pills').boundingBox();
  expect(rowBox).not.toBeNull();
  expect(pillsBox).not.toBeNull();
  if (rowBox && pillsBox) {
    expect(pillsBox.x + pillsBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 4);
    console.log(`[red_ops] Row: x=${rowBox.x} w=${rowBox.width} | Pills: x=${pillsBox.x} w=${pillsBox.width}`);
  }
});

test('click 25 / 50 / 75 / Full and assert layout class', async ({ page }) => {
  const menu = await openViewsPanel(page, 'dark');

  const rows = menu.locator('.nx-wsv-row');
  const firstRow = rows.first();

  const widthsToClass: Record<string, string> = {
    '25%': 'is-width-25',
    '50%': 'is-width-50',
    '75%': 'is-width-75',
    'Full': 'is-width-100',
  };

  for (const [label, cls] of Object.entries(widthsToClass)) {
    await firstRow.hover({ force: true });
    await page.waitForTimeout(200);

    const pill = firstRow.locator('.nx-wsv-pill', { hasText: label });
    await pill.click({ force: true });
    await page.waitForTimeout(400);

    // Assert a pane has the expected width class
    const pane = page.locator('.nx-workspace-pane-surface').first();
    const classes = await pane.evaluate(el => el.className);
    const hasClass = classes.includes(cls);
    console.log(`Clicked "${label}" → pane classes: ${classes}`);
    expect(hasClass, `Expected "${cls}" in pane classes after clicking "${label}", got: ${classes}`).toBe(true);
  }

  await page.screenshot({ path: path.join(SHOTS, 'dark-pill-click-final.png') });
});
