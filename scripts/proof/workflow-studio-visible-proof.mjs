#!/usr/bin/env node

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROOF_DIR = join(__dirname, '../../apps/dashboard/proof');
const BASE_URL = process.env.DASHBOARD_SMOKE_BASE_URL || 'http://127.0.0.1:5173/';

if (!existsSync(PROOF_DIR)) {
  mkdirSync(PROOF_DIR, { recursive: true });
}

let failures = 0;
let warnings = 0;

function mark(label, condition, detail = '', warnOnly = false) {
  const prefix = condition ? 'PASS' : warnOnly ? 'WARN' : 'FAIL';
  const line = `${prefix} ${label}${detail ? ` ${detail}` : ''}`;
  if (condition) {
    console.log(line);
    return true;
  }
  if (warnOnly) {
    warnings += 1;
    console.warn(line);
    return false;
  }
  failures += 1;
  console.error(line);
  return false;
}

async function main() {
  console.log(`Starting Workflow Studio Visibility Proof on ${BASE_URL}...`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    // Click on the Workspace trigger button (it should say something like "Deal Desk" or "Workspace")
    // Let's try clicking the title area that opens the layout menu.
    const workspaceToggle = page.locator('.nx-topbar-view-button.nx-topbar-workspace-compact');
    await workspaceToggle.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Hover or click the Views option in the menu
    const viewsOption = page.locator('text=Views').first();
    await viewsOption.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Locate Workflow Studio in the submenu
    const workflowStudioOption = page.locator('.nx-workspace-submenu-item--view:has-text("Workflow Studio")').first();
    const isVisible = await workflowStudioOption.isVisible();
    mark('Workflow Studio option is visible in Views menu', isVisible);

    // Take screenshot of the dropdown showing Workflow Studio
    if (isVisible) {
      await workflowStudioOption.hover();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(PROOF_DIR, 'workflow-studio-menu.png') });
      console.log('Saved screenshot: proof/workflow-studio-menu.png');
      
      // Select it and its full width option
      const fullWidthOption = workflowStudioOption.locator('text=Full').first();
      if (await fullWidthOption.isVisible()) {
         await fullWidthOption.click();
      } else {
         await workflowStudioOption.click();
      }
    } else {
      await page.screenshot({ path: join(PROOF_DIR, 'workflow-studio-menu-failed.png') });
    }

    await page.waitForTimeout(2000);
    
    // Take screenshot of the Workflow Studio view active
    const isStudioActive = await page.locator('.nx-workspace-surface--workflow-studio').isVisible();
    mark('Workflow Studio surface rendered successfully', isStudioActive);
    
    if (isStudioActive) {
      await page.screenshot({ path: join(PROOF_DIR, 'workflow-studio-full-width.png') });
      console.log('Saved screenshot: proof/workflow-studio-full-width.png');
    }

  } catch (err) {
    console.error('Unhandled error during test:', err);
    failures++;
  } finally {
    await browser.close();
  }

  console.log(`\nProof Complete: ${failures} failed, ${warnings} warnings`);
  process.exit(failures > 0 ? 1 : 0);
}

main();