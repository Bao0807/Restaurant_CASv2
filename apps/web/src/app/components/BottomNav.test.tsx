import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BottomNav } from './BottomNav';

afterEach(cleanup);

describe('BottomNav RBAC', () => {
  test('quản lý nhìn thấy toàn bộ khu vực chức năng', () => {
    render(<BottomNav view="order" role="manager" onViewChange={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Quản trị' })).toBeInTheDocument();
  });

  test('phục vụ không nhìn thấy thanh toán, báo cáo và quản trị', () => {
    render(<BottomNav view="order" role="server" onViewChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Vận hành' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Đặt bàn' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thanh toán' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quản trị' })).not.toBeInTheDocument();
  });

  test('bếp chỉ nhìn thấy màn hình vận hành', () => {
    render(<BottomNav view="order" role="chef" onViewChange={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Vận hành' })).toBeInTheDocument();
  });
});
