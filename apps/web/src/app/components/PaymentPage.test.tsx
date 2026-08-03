import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_RESTAURANT_SETTINGS } from '../config/restaurant';
import type { CartItem, PaymentRecord, PaymentResult, Table } from '../data';
import { PaymentPage } from './PaymentPage';

const { fetchPaymentReceiptMock } = vi.hoisted(() => ({
  fetchPaymentReceiptMock: vi.fn(),
}));

vi.mock('../services/api', async importOriginal => {
  const original = await importOriginal<typeof import('../services/api')>();
  return {
    ...original,
    fetchEmployees: vi.fn().mockResolvedValue([]),
    fetchPaymentReceipt: fetchPaymentReceiptMock,
    getServerNowMs: () => Date.now(),
  };
});

const table: Table = {
  id: 'table-1',
  number: 1,
  seats: 4,
  status: 'served',
  servedBatchCount: 1,
};

const order: CartItem[] = [{
  cartId: 'cart-1',
  menuItem: {
    id: 'item-1',
    name: 'Món kiểm thử',
    description: '',
    price: 100_000,
    image: '',
    categoryId: 'category-1',
    available: true,
  },
  quantity: 1,
  selectedToppings: [],
  note: '',
}];

describe('PaymentPage payment lifecycle', () => {
  test('keeps the local success invoice open when the refreshed snapshot closes the order', async () => {
    fetchPaymentReceiptMock.mockImplementation(async (invoiceCode: string) => ({
      payment: {
        id: invoiceCode,
        invoiceCode,
        transactionCode: 'CASH-SERVER',
        tableId: table.id,
        tableNumber: table.number,
        method: 'cash',
        subtotal: 100_000,
        discount: 0,
        serviceFee: 0,
        vat: 0,
        total: 100_000,
        cashReceived: 100_000,
        cashChange: 0,
        itemCount: 1,
        paidAt: new Date().toISOString(),
        staffName: 'Phục vụ server',
        cashierName: 'Thu ngân server',
      },
      items: [{ name: 'Món chính thức từ server', quantity: 1, price: 100_000 }],
      snapshot: { restaurantName: 'Nhà hàng snapshot' },
    }));
    function Harness() {
      const [tables, setTables] = useState<Table[]>([table]);
      const [orders, setOrders] = useState<Record<string, CartItem[]>>({ [table.id]: order });

      const processPayment = async (payment: PaymentRecord): Promise<PaymentResult> => {
        // Reproduce the production race: the operations snapshot is applied before
        // the payment promise resumes inside BillPanel.
        setTables([{ ...table, status: 'empty' }]);
        setOrders({});
        return {
          ...payment,
          cashChange: 0,
          requiresDepartureConfirmation: false,
          orderClosed: true,
        };
      };

      return (
        <PaymentPage
          tables={tables}
          tableOrders={orders}
          payments={[]}
          settings={{ ...DEFAULT_RESTAURANT_SETTINGS, serviceFeeRate: 0, vatRate: 0 }}
          onProcessPayment={processPayment}
          onConfirmDeparture={vi.fn()}
        />
      );
    }

    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.payment-table-row')!);
    fireEvent.change(container.querySelector<HTMLInputElement>('#payment-cash-received')!, {
      target: { value: '100000' },
    });
    fireEvent.click(container.querySelector<HTMLButtonElement>('.payment-checkout-footer button')!);

    await waitFor(() => expect(container.querySelector('.payment-dialog-shell.is-invoice')).toBeInTheDocument());
    expect(screen.getByText('Thanh toán thành công')).toBeInTheDocument();
    expect(screen.queryByText(/thiết bị khác/i)).not.toBeInTheDocument();
    expect(await screen.findByText('Món chính thức từ server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'In' })).toBeInTheDocument();
  });
});
