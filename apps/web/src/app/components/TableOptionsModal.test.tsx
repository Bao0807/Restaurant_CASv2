import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CartItem, EmployeeRole, Table } from '../data';
import { TableOptionsModal } from './TableOptionsModal';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '');
});

const table: Table = {
  id: 'table-rbac',
  number: 9,
  seats: 4,
  status: 'cooking',
  cookingBatchId: 10,
};

const order: CartItem[] = [{
  cartId: 'cart-rbac',
  menuItem: {
    id: 'dish-rbac',
    name: 'Món phân quyền',
    description: '',
    price: 50_000,
    image: '',
    categoryId: 'category-rbac',
    available: true,
  },
  quantity: 1,
  selectedToppings: [],
  note: '',
}];

function renderForRole(role: EmployeeRole) {
  return render(
    <TableOptionsModal
      role={role}
      table={table}
      order={order}
      onClose={vi.fn()}
      onStartOrder={vi.fn()}
      onEditOrder={vi.fn()}
      onDeleteOrder={vi.fn().mockResolvedValue(undefined)}
      onMarkDone={vi.fn().mockResolvedValue(undefined)}
      onConfirmDeparture={vi.fn().mockResolvedValue(undefined)}
      onCheckInReservation={vi.fn().mockResolvedValue(undefined)}
      onPay={vi.fn()}
    />,
  );
}

describe('TableOptionsModal RBAC', () => {
  test('chef only receives kitchen actions', () => {
    renderForRole('chef');
    expect(screen.getByText('Đánh dấu xong nấu')).toBeInTheDocument();
    expect(screen.queryByText('Gọi thêm món')).not.toBeInTheDocument();
    expect(screen.queryByText('Thanh toán bàn này')).not.toBeInTheDocument();
    expect(screen.queryByText('Hủy phiếu gọi món')).not.toBeInTheDocument();
  });

  test('server can manage orders and kitchen status but cannot take payment', () => {
    renderForRole('server');
    expect(screen.getByText('Gọi thêm món')).toBeInTheDocument();
    expect(screen.getByText('Đánh dấu xong nấu')).toBeInTheDocument();
    expect(screen.getByText('Hủy phiếu gọi món')).toBeInTheDocument();
    expect(screen.queryByText('Thanh toán bàn này')).not.toBeInTheDocument();
  });

  test('cashier can manage orders and payment but not kitchen status', () => {
    renderForRole('cashier');
    expect(screen.getByText('Gọi thêm món')).toBeInTheDocument();
    expect(screen.getByText('Thanh toán bàn này')).toBeInTheDocument();
    expect(screen.getByText('Hủy phiếu gọi món')).toBeInTheDocument();
    expect(screen.queryByText('Đánh dấu xong nấu')).not.toBeInTheDocument();
  });
});
