import { expect, test } from '@playwright/test';

test('quản lý đăng nhập bằng session cookie và nhìn thấy đúng điều hướng', async ({ page }) => {
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  test.skip(!username || !password, 'Cần AUTH_USERNAME và AUTH_PASSWORD để chạy E2E.');

  await page.goto('/');
  await page.getByLabel('Tên đăng nhập').fill(username!);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password!);
  await page.getByRole('button', { name: /Đăng nhập/ }).click();

  await expect(page.getByRole('button', { name: 'Vận hành', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thanh toán', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quản trị', exact: true })).toBeVisible();
  await expect(page.getByText('Quản lý', { exact: true })).toBeVisible();

  const cookies = await page.context().cookies();
  const session = cookies.find(cookie => cookie.name === 'cas_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');
});
