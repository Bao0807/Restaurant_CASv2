import { expect, test, type Locator, type Page } from '@playwright/test';

async function loginAsManager(page: Page) {
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  test.skip(!username || !password, 'Cần AUTH_USERNAME và AUTH_PASSWORD để chạy E2E.');

  await page.goto('/');
  await page.getByLabel('Tên đăng nhập').fill(username!);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password!);
  await page.getByRole('button', { name: /Đăng nhập/ }).click();
  await expect(page.getByRole('button', { name: 'Thanh toán', exact: true })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);

  const viewport = await page.evaluate(() => document.documentElement.clientWidth);
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBeLessThanOrEqual(viewport + 1);

  const overflowingRegions = await page.locator([
    '.payment-page-content',
    '.payment-page-toolbar',
    '.payment-view-summary',
    '.payment-unpaid-section',
    '.payment-queue-controls',
    '.payment-queue-filters',
    '.payment-table-list',
  ].join(',')).evaluateAll(elements => elements
    .filter(element => element.scrollWidth > element.clientWidth + 1)
    .map(element => ({
      className: element.className,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })));

  expect(overflowingRegions).toEqual([]);
}

async function expectTouchTarget(button: Locator) {
  const box = await button.boundingBox();
  expect(box, 'Bộ lọc phải hiển thị để có thể thao tác').not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(40);
}

async function expectFilteredTableCount(page: Page, filter: Locator) {
  const countText = await filter.locator('strong').textContent();
  const expectedCount = Number(countText?.trim());
  expect(Number.isInteger(expectedCount)).toBe(true);

  await expect(page.locator('.payment-table-list').getByRole('button', {
    name: /^Thanh toán bàn/i,
  })).toHaveCount(expectedCount);
}

test('tab Thanh toán giữ đúng nhãn, filter và layout POS', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsManager(page);

  await page.getByRole('button', { name: 'Thanh toán', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thanh toán', exact: true })).toBeAttached();
  const queueTab = page.locator('.payment-view-tabs').getByRole('tab', {
    name: /^Thanh toán(?:\s+\d+)?$/,
  });
  const historyTab = page.locator('.payment-view-tabs').getByRole('tab', {
    name: /^Lịch sử đơn(?:\s+\d+)?$/,
  });
  await expect(queueTab).toHaveAttribute('aria-selected', 'true');

  const queueTitleFontSize = await page.locator('.payment-table-title > strong').first()
    .evaluate(element => getComputedStyle(element).fontSize);
  const queueAmountFontSize = await page.locator('.payment-table-amount strong').first()
    .evaluate(element => getComputedStyle(element).fontSize);

  await queueTab.focus();
  await queueTab.press('ArrowRight');
  await expect(historyTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', {
    name: 'Lịch sử đơn đã thanh toán',
    exact: true,
  })).toBeVisible();
  const historyTabsBox = await page.locator('.payment-view-tabs').boundingBox();
  const historySummaryBox = await page.locator('.payment-view-summary').boundingBox();
  expect(historyTabsBox).not.toBeNull();
  expect(historySummaryBox).not.toBeNull();
  expect(Math.abs(historyTabsBox!.y - historySummaryBox!.y)).toBeLessThanOrEqual(1);
  await expect(page.locator('.payment-history-title-row > strong').first()).toHaveCSS(
    'font-size',
    queueTitleFontSize,
  );
  await expect(page.locator('.payment-history-amount strong').first()).toHaveCSS(
    'font-size',
    queueAmountFontSize,
  );

  await historyTab.press('ArrowLeft');
  await expect(queueTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Chưa thanh toán', exact: true })).toBeVisible();

  const tabsBox = await page.locator('.payment-view-tabs').boundingBox();
  const summaryBox = await page.locator('.payment-view-summary').boundingBox();
  expect(tabsBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(Math.abs(tabsBox!.y - summaryBox!.y)).toBeLessThanOrEqual(1);

  const filters = page.getByRole('group', { name: /Lọc.*thanh toán/i });
  const allFilter = filters.getByRole('button', { name: /^Tất cả(?:\s+\d+)?$/ });
  const completedFilter = filters.getByRole('button', { name: /^Món đã xong(?:\s+\d+)?$/ });
  const earlyFilter = filters.getByRole('button', { name: /^Có thể trả trước(?:\s+\d+)?$/ });

  await expect(filters).toBeVisible();
  await expect(allFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(completedFilter).toHaveAttribute('aria-pressed', 'false');
  await expect(earlyFilter).toHaveAttribute('aria-pressed', 'false');

  for (const filter of [allFilter, completedFilter, earlyFilter]) {
    await expectTouchTarget(filter);
  }
  await expectFilteredTableCount(page, allFilter);
  await expectNoHorizontalOverflow(page);

  await completedFilter.click();
  await expect(completedFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(allFilter).toHaveAttribute('aria-pressed', 'false');
  await expect(earlyFilter).toHaveAttribute('aria-pressed', 'false');
  await expectFilteredTableCount(page, completedFilter);
  await expectNoHorizontalOverflow(page);

  await earlyFilter.click();
  await expect(earlyFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(allFilter).toHaveAttribute('aria-pressed', 'false');
  await expect(completedFilter).toHaveAttribute('aria-pressed', 'false');
  await expectFilteredTableCount(page, earlyFilter);
  await expectNoHorizontalOverflow(page);

  await allFilter.click();
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const paidSection = page.locator('.payment-paid-section');
  if (await paidSection.count()) {
    const paidToggle = paidSection.getByRole('button', {
      name: /Đã thanh toán · đang phục vụ/i,
    });
    await expect(paidToggle).toBeVisible();

    const initialExpanded = await paidToggle.getAttribute('aria-expanded');
    expect(initialExpanded).toMatch(/^(true|false)$/);

    await paidToggle.click();
    await expect(paidToggle).toHaveAttribute(
      'aria-expanded',
      initialExpanded === 'true' ? 'false' : 'true',
    );

    if (await paidToggle.getAttribute('aria-expanded') === 'false') {
      await paidToggle.click();
      await expect(paidToggle).toHaveAttribute('aria-expanded', 'true');
    }

    const departureButton = paidSection.getByRole('button', {
      name: /^Xác nhận khách rời$/,
    });
    if (await departureButton.count()) {
      await departureButton.first().click();
      const dialog = page.getByRole('alertdialog', { name: /Xác nhận khách rời Bàn/ });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Quay lại' }).click();
      await expect(dialog).toBeHidden();
    }
  }
});
