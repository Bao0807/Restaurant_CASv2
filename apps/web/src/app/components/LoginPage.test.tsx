import axe from 'axe-core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LoginPage } from './LoginPage';

afterEach(cleanup);

describe('LoginPage accessibility', () => {
  test('không có vi phạm accessibility tự động nghiêm trọng', async () => {
    const { container } = render(
      <LoginPage busy={false} error={null} onLogin={vi.fn()} />,
    );
    const result = await axe.run(container, {
      rules: {
        'color-contrast': { enabled: false },
      },
    });
    expect(result.violations).toEqual([]);
  });
});
