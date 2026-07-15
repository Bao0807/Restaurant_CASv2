import { useEffect, useState } from 'react';
import { AlertTriangle, Bot, ChefHat, CirclePlus, Pause, Play, RotateCcw, Save, StepForward, Trash2, UserRoundPlus, UsersRound, UtensilsCrossed } from 'lucide-react';
import type { Employee, EmployeeRole, KitchenStatus, MenuCategory, MenuItem, Table, TableStatus } from '../data';
import { formatVND } from '../data';
import {
  createTable,
  deactivateEmployee,
  deactivateMenuItem,
  dispatchNextKitchenOrder,
  fetchEmployees,
  removeTable,
  requeueOrder,
  saveCategory,
  saveEmployee,
  saveKitchenConfig,
  saveMenuItem,
  saveTable,
  updateTableStatus,
} from '../services/api';
import { ConfirmationDialog } from './ConfirmationDialog';

interface Props {
  tables: Table[];
  categories: MenuCategory[];
  menuItems: MenuItem[];
  kitchen: KitchenStatus;
  onChanged: () => void | Promise<void>;
}

const inputClass = 'management-input';
const EMPTY_EMPLOYEE: Partial<Employee> = {
  code: '', name: '', role: 'server', phone: '', shiftStart: '08:00', shiftEnd: '16:00', active: true,
};
const EMPLOYEE_ROLE_LABELS: Record<EmployeeRole, string> = {
  manager: 'Quản lý', cashier: 'Thu ngân', server: 'Phục vụ', chef: 'Bếp',
};

type ConfirmAction = (title: string, message: string, confirmLabel: string) => Promise<boolean>;

function TableEditor({ table, onChanged, report, confirmAction }: { table: Table; onChanged: Props['onChanged']; report: (message: string, error?: boolean) => void; confirmAction: ConfirmAction }) {
  const [draft, setDraft] = useState(table);
  useEffect(() => setDraft(table), [table.number, table.seats, table.status, table.reservedTime]);

  const persist = async () => {
    try {
      await saveTable(draft);
      await onChanged();
      report(`Đã cập nhật bàn ${draft.number}`);
    } catch (error) { report(error instanceof Error ? error.message : 'Không thể cập nhật bàn', true); }
  };

  const remove = async () => {
    if (!await confirmAction('Xóa bàn?', `Bàn ${table.number} sẽ bị xóa khỏi sơ đồ. Chỉ bàn không có order mới thực hiện được.`, 'Xóa bàn')) return;
    try {
      await removeTable(table.id);
      await onChanged();
      report(`Đã xóa bàn ${table.number}`);
    } catch (error) { report(error instanceof Error ? error.message : 'Không thể xóa bàn', true); }
  };

  return (
    <div className="management-row">
      <input aria-label="Số bàn" className={inputClass} type="number" min={1} value={draft.number} onChange={event => setDraft({ ...draft, number: Number(event.target.value) })} />
      <input aria-label="Số ghế" className={inputClass} type="number" min={1} value={draft.seats} onChange={event => setDraft({ ...draft, seats: Number(event.target.value) })} />
      <select
        aria-label={table.orderNumber ? 'Trạng thái do hàng đợi bếp quản lý' : 'Trạng thái'}
        title={table.orderNumber ? 'Dùng thao tác order/bếp để đổi trạng thái' : 'Trạng thái bàn'}
        className={inputClass}
        value={draft.status}
        disabled={Boolean(table.orderNumber)}
        onChange={event => setDraft({ ...draft, status: event.target.value as TableStatus })}
      >
        <option value="empty">Trống</option><option value="reserved">Đặt trước</option>
        {table.orderNumber && <><option value="waiting">Đang chờ</option><option value="cooking">Đang nấu</option><option value="done">Đã xong</option></>}
      </select>
      <button className="management-icon-button primary" aria-label={`Lưu bàn ${table.number}`} onClick={() => void persist()} title="Lưu bàn"><Save size={16} /></button>
      <button className="management-icon-button danger" aria-label={`Xóa bàn ${table.number}`} onClick={() => void remove()} title="Xóa bàn"><Trash2 size={16} /></button>
    </div>
  );
}

export function ManagementPanel({ tables, categories, menuItems, kitchen, onChanged }: Props) {
  const [concurrency, setConcurrency] = useState(kitchen.concurrency);
  const [staleAfterMinutes, setStaleAfterMinutes] = useState(kitchen.staleAfterMinutes);
  const [automationEnabled, setAutomationEnabled] = useState(kitchen.automationEnabled);
  const [paused, setPaused] = useState(kitchen.paused);
  const [newTable, setNewTable] = useState({ number: Math.max(0, ...tables.map(table => table.number)) + 1, seats: 4 });
  const [selectedItemId, setSelectedItemId] = useState('new');
  const emptyDish = { name: '', description: '', price: 0, image: '', categoryId: categories[0]?.id ?? '', cookMinutes: 10, available: true };
  const [dish, setDish] = useState<Partial<MenuItem>>(emptyDish);
  const [newCategory, setNewCategory] = useState({ name: '', emoji: '🍽️' });
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('new');
  const [employee, setEmployee] = useState<Partial<Employee>>(EMPTY_EMPLOYEE);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string; message: string; confirmLabel: string; resolve: (confirmed: boolean) => void;
  } | null>(null);
  const staleTables = tables.filter(table => table.kitchenStale);

  useEffect(() => setConcurrency(kitchen.concurrency), [kitchen.concurrency]);
  useEffect(() => setStaleAfterMinutes(kitchen.staleAfterMinutes), [kitchen.staleAfterMinutes]);
  useEffect(() => setAutomationEnabled(kitchen.automationEnabled), [kitchen.automationEnabled]);
  useEffect(() => setPaused(kitchen.paused), [kitchen.paused]);
  useEffect(() => {
    if (selectedItemId === 'new') return;
    const selected = menuItems.find(item => item.id === selectedItemId);
    if (selected) setDish(selected);
  }, [selectedItemId, menuItems]);
  useEffect(() => {
    let active = true;
    setEmployeesLoading(true);
    fetchEmployees()
      .then(rows => { if (active) setEmployees(rows); })
      .catch(error => { if (active) setNotice({ message: error instanceof Error ? error.message : 'Không thể tải nhân viên', error: true }); })
      .finally(() => { if (active) setEmployeesLoading(false); });
    return () => { active = false; };
  }, []);

  const report = (message: string, error = false) => {
    setNotice({ message, error });
    window.setTimeout(() => setNotice(null), 3000);
  };

  const confirmAction: ConfirmAction = (title, message, confirmLabel) => new Promise(resolve => {
    setConfirmation({ title, message, confirmLabel, resolve });
  });

  const settleConfirmation = (confirmed: boolean) => {
    confirmation?.resolve(confirmed);
    setConfirmation(null);
  };

  const addTable = async () => {
    try { await createTable(newTable.number, newTable.seats); await onChanged(); setNewTable(current => ({ ...current, number: current.number + 1 })); report('Đã thêm bàn mới'); }
    catch (error) { report(error instanceof Error ? error.message : 'Không thể thêm bàn', true); }
  };

  const persistDish = async () => {
    try {
      const saved = await saveMenuItem(dish);
      await onChanged();
      setSelectedItemId(saved.id);
      report(`Đã lưu món ${saved.name}`);
    } catch (error) { report(error instanceof Error ? error.message : 'Không thể lưu món', true); }
  };

  const deactivate = async () => {
    if (!dish.id || !await confirmAction('Ngừng bán món?', `${dish.name} sẽ không còn xuất hiện trong order mới.`, 'Ngừng bán')) return;
    try { await deactivateMenuItem(dish.id); await onChanged(); report('Đã ngừng phục vụ món'); }
    catch (error) { report(error instanceof Error ? error.message : 'Không thể cập nhật món', true); }
  };

  const addCategory = async () => {
    try { await saveCategory(newCategory); await onChanged(); setNewCategory({ name: '', emoji: '🍽️' }); report('Đã thêm danh mục'); }
    catch (error) { report(error instanceof Error ? error.message : 'Không thể thêm danh mục', true); }
  };

  const reloadEmployees = async () => {
    const rows = await fetchEmployees();
    setEmployees(rows);
    return rows;
  };

  const chooseEmployee = (employeeId: string) => {
    setSelectedEmployeeId(employeeId);
    const selected = employees.find(row => row.id === employeeId);
    setEmployee(selected ? { ...selected } : { ...EMPTY_EMPLOYEE });
  };

  const persistEmployee = async () => {
    try {
      const saved = await saveEmployee(employee);
      await reloadEmployees();
      setSelectedEmployeeId(saved.id);
      setEmployee(saved);
      report(`Đã lưu nhân viên ${saved.name}`);
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể lưu nhân viên', true);
    }
  };

  const deactivateCurrentEmployee = async () => {
    if (!employee.id || !await confirmAction('Ngừng hoạt động?', `Hồ sơ ${employee.name} được giữ lại trên hóa đơn cũ nhưng không còn được phân công mới.`, 'Ngừng hoạt động')) return;
    try {
      await deactivateEmployee(employee.id);
      await reloadEmployees();
      setSelectedEmployeeId('new');
      setEmployee({ ...EMPTY_EMPLOYEE });
      report('Đã ngừng hoạt động nhân viên');
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể cập nhật nhân viên', true);
    }
  };

  const reactivateCurrentEmployee = async () => {
    if (!employee.id) return;
    try {
      const saved = await saveEmployee({ ...employee, active: true });
      await reloadEmployees();
      setEmployee(saved);
      report(`Đã kích hoạt lại ${saved.name}`);
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể kích hoạt nhân viên', true);
    }
  };

  /** Cho quản lý giải phóng slot bị giữ bởi order nấu quá lâu. */
  const resolveStaleOrder = async (table: Table, action: 'requeue' | 'done') => {
    try {
      if (!table.cookingBatchId) throw new Error('Phiếu đang nấu đã thay đổi. Hãy tải lại dữ liệu.');
      if (action === 'requeue') await requeueOrder(table.id, table.cookingBatchId);
      else await updateTableStatus(table.id, 'done', table.cookingBatchId);
      await onChanged();
      report(action === 'requeue' ? `Đã đưa bàn ${table.number} về cuối hàng chờ` : `Đã hoàn tất order bàn ${table.number}`);
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể xử lý order quá hạn', true);
    }
  };

  /** Lưu toàn bộ state bếp cùng lúc để UI và queue không lệch chế độ. */
  const persistKitchen = async (nextAutomation = automationEnabled, nextPaused = paused) => {
    try {
      await saveKitchenConfig(concurrency, staleAfterMinutes, nextAutomation, nextPaused);
      setAutomationEnabled(nextAutomation);
      setPaused(nextPaused);
      await onChanged();
      report('Đã cập nhật chế độ vận hành bếp');
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể lưu cấu hình bếp', true);
    }
  };

  const dispatchNext = async () => {
    try {
      const count = await dispatchNextKitchenOrder();
      await onChanged();
      report(count > 0 ? 'Đã lấy order đầu hàng chờ vào bếp' : 'Không có order chờ hoặc bếp đã đủ công suất');
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể điều phối order', true);
    }
  };

  return (
    <div className="management-panel">
      {notice && <div className={`management-notice ${notice.error ? 'error' : ''}`}>{notice.message}</div>}

      {staleTables.length > 0 && (
        <section className="management-stale-alert">
          <div className="management-title"><AlertTriangle size={21} /><div><strong>{staleTables.length} order bếp quá hạn</strong><span>Đã nấu quá {kitchen.staleAfterMinutes} phút và đang chiếm công suất bếp</span></div></div>
          <div className="management-stale-list">
            {staleTables.map(table => (
              <div key={table.id} className="management-stale-row">
                <strong>Bàn {table.number}</strong>
                <span>Order #{table.orderNumber}</span>
                <button className="management-button secondary" onClick={() => void resolveStaleOrder(table, 'requeue')}><RotateCcw size={15} /> Xếp lại</button>
                <button className="management-button" onClick={() => void resolveStaleOrder(table, 'done')}><Save size={15} /> Đã xong</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="management-card">
        <div className="management-title"><ChefHat size={20} /><div><strong>Cấu hình bếp</strong><span>{kitchen.cookingCount} đang nấu · {kitchen.waitingCount} đang chờ</span></div><span className={`kitchen-mode-badge ${paused ? 'paused' : automationEnabled ? 'auto' : 'manual'}`}>{paused ? 'Đang tạm dừng' : automationEnabled ? 'Tự động FIFO' : 'Điều phối thủ công'}</span></div>
        <div className="management-actions"><label>Số order nấu song song<input className={inputClass} type="number" min={1} max={20} value={concurrency} onChange={event => setConcurrency(Number(event.target.value))} /></label><label>Cảnh báo quá hạn (phút)<input className={inputClass} type="number" min={15} max={1440} value={staleAfterMinutes} onChange={event => setStaleAfterMinutes(Number(event.target.value))} /></label><button className="management-button" onClick={() => void persistKitchen()}><Save size={16} /> Lưu cấu hình</button></div>
        <div className="kitchen-control-grid">
          <button className={`kitchen-control ${automationEnabled ? 'active' : ''}`} onClick={() => void persistKitchen(!automationEnabled, paused)}><Bot size={18} /><span><strong>Tự động</strong><small>{automationEnabled ? 'Queue tự lấy order theo FIFO' : 'Bật để queue tự vận hành'}</small></span></button>
          <button className={`kitchen-control ${paused ? 'warning' : ''}`} onClick={() => void persistKitchen(automationEnabled, !paused)}>{paused ? <Play size={18} /> : <Pause size={18} />}<span><strong>{paused ? 'Tiếp tục bếp' : 'Tạm dừng bếp'}</strong><small>Không ảnh hưởng order đang nấu</small></span></button>
          <button className="kitchen-control" disabled={paused} onClick={() => void dispatchNext()}><StepForward size={18} /><span><strong>Lấy order tiếp</strong><small>Điều phối 1 order đầu hàng chờ</small></span></button>
        </div>
      </section>

      <section className="management-card">
        <div className="management-title">
          <UsersRound size={20} />
          <div><strong>Quản lý nhân viên</strong><span>{employees.filter(row => row.active).length} đang hoạt động · {employees.length} hồ sơ</span></div>
          <span className="kitchen-mode-badge auto">Phân ca & hóa đơn</span>
        </div>
        <select
          className={inputClass}
          value={selectedEmployeeId}
          disabled={employeesLoading}
          onChange={event => chooseEmployee(event.target.value)}
          aria-label="Chọn nhân viên"
        >
          <option value="new">＋ Thêm nhân viên mới</option>
          {employees.map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}{!row.active ? ' (ngừng hoạt động)' : ''}</option>)}
        </select>
        <div className="management-form-grid" style={{ marginTop: 12 }}>
          <label>Mã nhân viên<input className={inputClass} maxLength={24} value={employee.code ?? ''} onChange={event => setEmployee({ ...employee, code: event.target.value.toUpperCase() })} placeholder="NV005" /></label>
          <label>Họ và tên<input className={inputClass} maxLength={120} value={employee.name ?? ''} onChange={event => setEmployee({ ...employee, name: event.target.value })} placeholder="Nguyễn Văn A" /></label>
          <label>Vai trò<select className={inputClass} value={employee.role ?? 'server'} onChange={event => setEmployee({ ...employee, role: event.target.value as EmployeeRole })}>{Object.entries(EMPLOYEE_ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></label>
          <label>Số điện thoại<input className={inputClass} maxLength={32} value={employee.phone ?? ''} onChange={event => setEmployee({ ...employee, phone: event.target.value })} placeholder="0901 234 567" /></label>
          <label>Bắt đầu ca<input className={inputClass} type="time" value={employee.shiftStart ?? ''} onChange={event => setEmployee({ ...employee, shiftStart: event.target.value })} /></label>
          <label>Kết thúc ca<input className={inputClass} type="time" value={employee.shiftEnd ?? ''} onChange={event => setEmployee({ ...employee, shiftEnd: event.target.value })} /></label>
          <label className="management-check"><input type="checkbox" checked={employee.active !== false} onChange={event => setEmployee({ ...employee, active: event.target.checked })} /> Đang hoạt động</label>
        </div>
        <div className="management-actions">
          <button className="management-button" onClick={() => void persistEmployee()}><Save size={16} /> {employee.id ? 'Lưu hồ sơ' : 'Thêm nhân viên'}</button>
          {employee.id && employee.active !== false && <button className="management-button secondary" onClick={() => void deactivateCurrentEmployee()}><Trash2 size={16} /> Ngừng hoạt động</button>}
          {employee.id && employee.active === false && <button className="management-button secondary" onClick={() => void reactivateCurrentEmployee()}><RotateCcw size={16} /> Kích hoạt lại</button>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 16 }}>
          {employeesLoading && <div style={{ color: '#94A3B8', fontSize: 13 }}>Đang tải hồ sơ nhân viên…</div>}
          {!employeesLoading && employees.map(row => (
            <button
              key={row.id}
              type="button"
              onClick={() => chooseEmployee(row.id)}
              style={{ border: selectedEmployeeId === row.id ? '1px solid #0D9488' : '1px solid #E2E8F0', borderRadius: 12, padding: 12, background: selectedEmployeeId === row.id ? '#F0FDFA' : '#fff', textAlign: 'left', cursor: 'pointer', opacity: row.active ? 1 : 0.62, display: 'flex', gap: 10, alignItems: 'center' }}
            >
              <span style={{ width: 38, height: 38, flex: '0 0 38px', borderRadius: 10, background: row.active ? '#CCFBF1' : '#F1F5F9', color: row.active ? '#0F766E' : '#64748B', display: 'grid', placeItems: 'center' }}><UserRoundPlus size={18} /></span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ display: 'block', color: '#0F172A', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</strong>
                <small style={{ display: 'block', color: '#64748B', marginTop: 3 }}>{row.code} · {EMPLOYEE_ROLE_LABELS[row.role]}</small>
                <small style={{ display: 'block', color: '#94A3B8', marginTop: 2 }}>{row.shiftStart && row.shiftEnd ? `${row.shiftStart}–${row.shiftEnd}` : 'Chưa thiết lập ca'} · {row.active ? 'Đang hoạt động' : 'Đã nghỉ'}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="management-card">
        <div className="management-title"><CirclePlus size={20} /><div><strong>Quản lý bàn</strong><span>Thêm, sửa bàn; trạng thái order do hàng đợi bếp quản lý</span></div></div>
        <div className="management-row add-row"><input className={inputClass} type="number" value={newTable.number} onChange={event => setNewTable({ ...newTable, number: Number(event.target.value) })} placeholder="Số bàn" /><input className={inputClass} type="number" value={newTable.seats} onChange={event => setNewTable({ ...newTable, seats: Number(event.target.value) })} placeholder="Số ghế" /><button className="management-button" onClick={() => void addTable()}><CirclePlus size={16} /> Thêm bàn</button></div>
        <div className="management-table-head"><span>Số bàn</span><span>Số ghế</span><span>Trạng thái</span><span></span></div>
        <div className="management-list">{tables.map(table => <TableEditor key={table.id} table={table} onChanged={onChanged} report={report} confirmAction={confirmAction} />)}</div>
      </section>

      <section className="management-card management-menu-card">
        <div className="management-title"><UtensilsCrossed size={20} /><div><strong>Thực đơn & thời gian nấu</strong><span>Giá và thời gian được áp dụng cho order mới</span></div></div>
        <select className={inputClass} value={selectedItemId} onChange={event => { const id = event.target.value; setSelectedItemId(id); if (id === 'new') setDish({ ...emptyDish, categoryId: categories[0]?.id ?? '' }); }}><option value="new">＋ Thêm món mới</option>{menuItems.map(item => <option key={item.id} value={item.id}>{item.name} — {formatVND(item.price)}{!item.available ? ' (ngừng bán)' : ''}</option>)}</select>
        <div className="management-form-grid">
          <label>Tên món<input className={inputClass} value={dish.name ?? ''} onChange={event => setDish({ ...dish, name: event.target.value })} /></label>
          <label>Danh mục<select className={inputClass} value={dish.categoryId ?? ''} onChange={event => setDish({ ...dish, categoryId: event.target.value })}>{categories.map(category => <option key={category.id} value={category.id}>{category.emoji} {category.name}</option>)}</select></label>
          <label>Giá bán<input className={inputClass} type="number" min={0} value={dish.price ?? 0} onChange={event => setDish({ ...dish, price: Number(event.target.value) })} /></label>
          <label>Thời gian nấu (phút)<input className={inputClass} type="number" min={1} max={240} value={dish.cookMinutes ?? 10} onChange={event => setDish({ ...dish, cookMinutes: Number(event.target.value) })} /></label>
          <label className="wide">URL hình ảnh<input className={inputClass} value={dish.image ?? ''} onChange={event => setDish({ ...dish, image: event.target.value })} /></label>
          <label className="wide">Mô tả<textarea className={inputClass} rows={3} value={dish.description ?? ''} onChange={event => setDish({ ...dish, description: event.target.value })} /></label>
          <label className="management-check"><input type="checkbox" checked={dish.available !== false} onChange={event => setDish({ ...dish, available: event.target.checked })} /> Đang phục vụ</label>
        </div>
        <div className="management-actions"><button className="management-button" onClick={() => void persistDish()}><Save size={16} /> Lưu món</button>{dish.id && <button className="management-button secondary" onClick={() => void deactivate()}><Trash2 size={16} /> Ngừng bán</button>}</div>
      </section>

      <section className="management-card compact"><div className="management-title"><CirclePlus size={20} /><div><strong>Thêm danh mục</strong><span>Tạo nhóm món mới cho thực đơn</span></div></div><div className="management-row add-row"><input className={inputClass} value={newCategory.emoji} onChange={event => setNewCategory({ ...newCategory, emoji: event.target.value })} aria-label="Biểu tượng" /><input className={inputClass} value={newCategory.name} onChange={event => setNewCategory({ ...newCategory, name: event.target.value })} placeholder="Tên danh mục" /><button className="management-button" onClick={() => void addCategory()}>Thêm</button></div></section>
      {confirmation && (
        <ConfirmationDialog
          title={confirmation.title}
          message={confirmation.message}
          confirmLabel={confirmation.confirmLabel}
          onCancel={() => settleConfirmation(false)}
          onConfirm={() => settleConfirmation(true)}
        />
      )}
    </div>
  );
}
