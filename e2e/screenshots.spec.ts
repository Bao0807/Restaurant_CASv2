import path from 'node:path';
import { expect, test } from '@playwright/test';

const screenshotDir = path.resolve('docs/screenshots');

test('cập nhật ảnh README từ giao diện đang chạy', async ({ page }) => {
  test.skip(process.env.UPDATE_SCREENSHOTS !== '1', 'Chỉ chạy khi chủ động cập nhật ảnh README.');
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  test.skip(!username || !password, 'Cần AUTH_USERNAME và AUTH_PASSWORD.');

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.screenshot({ path: path.join(screenshotDir, '01-login-desktop.png') });

  await page.getByLabel('Tên đăng nhập').fill(username!);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password!);
  await page.getByRole('button', { name: /Đăng nhập/ }).click();
  await expect(page.getByRole('button', { name: 'Vận hành', exact: true })).toBeVisible();
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  await page.screenshot({ path: path.join(screenshotDir, '02-table-overview-desktop.png') });

  await page.getByRole('button', { name: 'Sơ đồ', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, '09-floor-plan-desktop.png') });

  await page.getByRole('button', { name: 'Đặt bàn', exact: true }).click();
  await expect(page.getByRole('heading', { name: /đặt bàn/i })).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, '07-reservations-desktop.png') });

  await page.getByRole('button', { name: 'Thanh toán', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chưa thanh toán' })).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, '10-payment-desktop.png') });

  await page.getByRole('button', { name: 'Báo cáo', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, '05-reports-desktop.png') });

  await page.getByRole('button', { name: 'Quản trị', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, '04-kitchen-dashboard-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Đặt bàn', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, '08-reservations-mobile.png') });

  await page.getByRole('button', { name: 'Vận hành', exact: true }).click();
  await page.locator('[data-table-id]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, '06-table-modal-mobile.png') });

  await page.getByRole('button', { name: 'Đóng tùy chọn bàn' }).click();
  await page.locator('button[aria-label^="Gọi món cho bàn"]').first().click();
  await page.locator('[data-menu-item-id]:not([disabled])').first().click();
  await page.locator('[data-action="save-cart-item"]').click();
  await page.locator('[data-action="open-cart"]').click();
  await page.locator('[data-action="confirm-cart"]').click();
  await expect(page.getByText('Xác nhận gọi món', { exact: true })).toBeVisible();
  const mobileLayout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(mobileLayout.documentWidth).toBe(mobileLayout.viewport);
  await page.screenshot({ path: path.join(screenshotDir, '03-order-eta-mobile.png') });
});
