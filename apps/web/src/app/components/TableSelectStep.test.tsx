import { fireEvent, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { KitchenStatus, Table } from '../data';
import { TableSelectStep } from './TableSelectStep';

const kitchen: KitchenStatus = {
  concurrency: 2,
  cookingCount: 2,
  waitingCount: 0,
  staleCount: 0,
  staleBatches: [],
  staleAfterMinutes: 120,
  automationEnabled: true,
  paused: false,
  version: 1,
};

const tables: Table[] = [
  {
    id: 'mixed-ready',
    number: 1,
    seats: 4,
    status: 'cooking',
    batchCount: 2,
    cookingBatchCount: 1,
    doneBatchCount: 1,
    readyBatchIds: [101],
  },
  {
    id: 'cooking-only',
    number: 2,
    seats: 4,
    status: 'cooking',
    batchCount: 1,
    cookingBatchCount: 1,
    doneBatchCount: 0,
  },
];

describe('TableSelectStep overlapping progress filters', () => {
  test('keeps a mixed cooking/done table visible in the Cần phục vụ filter', () => {
    const { container } = render(
      <TableSelectStep
        role="server"
        tables={tables}
        tableOrders={{}}
        waitingBatchesByTable={{}}
        kitchen={kitchen}
        onStartOrder={vi.fn()}
        onEditOrder={vi.fn()}
        onDeleteOrder={vi.fn()}
        onMarkDone={vi.fn()}
        onMarkServed={vi.fn()}
        onConfirmDeparture={vi.fn()}
        onCheckInReservation={vi.fn()}
        onPay={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-table-id="mixed-ready"]')?.closest('article'))
      .toHaveClass('status-cooking');
    expect(container.querySelector('.table-ready-chip')).toHaveTextContent('Cần phục vụ');

    const readyFilter = Array.from(container.querySelectorAll<HTMLButtonElement>('.table-filter-chip'))
      .find(button => button.textContent?.includes('Cần phục vụ'));
    expect(readyFilter).toBeDefined();
    fireEvent.click(readyFilter!);

    expect(container.querySelector('[data-table-id="mixed-ready"]')).toBeInTheDocument();
    expect(container.querySelector('[data-table-id="cooking-only"]')).not.toBeInTheDocument();
  });
});
