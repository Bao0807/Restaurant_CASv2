import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, ChefHat, CirclePlus, Pause, Play, RotateCcw, Save, StepForward, Trash2, UserRoundPlus, UsersRound, UtensilsCrossed } from 'lucide-react';
import type { Employee, EmployeeRole, KitchenStaleBatch, KitchenStatus, MenuCategory, MenuItem, Table } from '../data';
import { formatVND, STATUS_CONFIG } from '../data';
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
type ManagementSection = 'kitchen' | 'menu' | 'tables' | 'employees';

function TableEditor({ table, onChanged, report, confirmAction }: { table: Table; onChanged: Props['onChanged']; report: (message: string, error?: boolean) => void; confirmAction: ConfirmAction }) {
  const [draft, setDraft] = useState(table);
  useEffect(() => setDraft(table), [table.number, table.seats, table.status]);

  const persist = async () => {
    try {
      await saveTable({
        ...draft,
        status: table.orderNumber ? table.status : 'empty',
      });
      await onChanged();
      report(`Đã cập nhật bàn ${draft.number}`);
    } catch (error) { report(error instanceof Error ? error.message : 'Không thể cập nhật bàn', true); }
  };

  const remove = async () => {
    if (!await confirmAction('Xóa bàn?', `Bàn ${table.number} sẽ bị xóa khỏi sơ đồ. Chỉ bàn không có phiếu phục vụ mới xóa được.`, 'Xóa bàn')) return;
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
      <div className="management-table-status" title="Trạng thái được đồng bộ từ đặt bàn và hàng đợi bếp">
        <strong>{STATUS_CONFIG[table.status].label}</strong>
        <small>{table.nextReservation
          ? `${new Date(table.nextReservation.reservedAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })} · ${table.nextReservation.customerName}`
          : table.orderNumber ? 'Bếp tự đồng bộ' : 'Sẵn sàng phục vụ'}</small>
      </div>
      <button className="management-icon-button primary" aria-label={`Lưu bàn ${table.number}`} onClick={() => void persist()} title="Lưu bàn"><Save size={16} /></button>
      <button className="management-icon-button danger" aria-label={`Xóa bàn ${table.number}`} onClick={() => void remove()} title="Xóa bàn"><Trash2 size={16} /></button>
    </div>
  );
}

export function ManagementPanel({ tables, categories, menuItems, kitchen, onChanged }: Props) {
  const [activeSection, setActiveSection] = useState<ManagementSection>('kitchen');
  const [concurrency, setConcurrency] = useState(kitchen.concurrency);
  const [staleAfterMinutes, setStaleAfterMinutes] = useState(kitchen.staleAfterMinutes);
  const [automationEnabled, setAutomationEnabled] = useState(kitchen.automationEnabled);
  const [paused, setPaused] = useState(kitchen.paused);
  const [kitchenVersion, setKitchenVersion] = useState(kitchen.version);
  const [kitchenBusy, setKitchenBusy] = useState(false);
  const kitchenBusyRef = useRef(false);
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
  const staleBatches = kitchen.staleBatches ?? [];

  useEffect(() => {
    if (kitchen.version <= kitchenVersion) return;
    setConcurrency(kitchen.concurrency);
    setStaleAfterMinutes(kitchen.staleAfterMinutes);
    setAutomationEnabled(kitchen.automationEnabled);
    setPaused(kitchen.paused);
    setKitchenVersion(kitchen.version);
  }, [kitchen.automationEnabled, kitchen.concurrency, kitchen.paused, kitchen.staleAfterMinutes, kitchen.version, kitchenVersion]);
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
    if (!dish.id || !await confirmAction('Ngừng bán món?', `${dish.name} sẽ không còn xuất hiện trong lượt gọi mới.`, 'Ngừng bán')) return;
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
  const resolveStaleOrder = async (batch: KitchenStaleBatch, action: 'requeue' | 'done') => {
    if (kitchenBusyRef.current) return;
    kitchenBusyRef.current = true;
    setKitchenBusy(true);
    try {
      if (action === 'requeue') await requeueOrder(batch.tableId, batch.batchId);
      else await updateTableStatus(batch.tableId, 'done', batch.batchId);
      await onChanged();
      report(action === 'requeue'
        ? `Đã đưa lượt #${batch.batchNumber} của bàn ${batch.tableNumber} về cuối hàng chờ`
        : `Đã hoàn tất lượt #${batch.batchNumber} của bàn ${batch.tableNumber}`);
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể xử lý phiếu quá hạn', true);
    } finally {
      kitchenBusyRef.current = false;
      setKitchenBusy(false);
    }
  };

  /** Chỉ gửi trường vừa đổi và dùng version để không ghi đè cấu hình từ máy POS khác. */
  const persistKitchen = async (changes: Partial<Pick<KitchenStatus, 'concurrency' | 'staleAfterMinutes' | 'automationEnabled' | 'paused'>>) => {
    if (kitchenBusyRef.current) return;
    kitchenBusyRef.current = true;
    setKitchenBusy(true);
    try {
      const saved = await saveKitchenConfig(kitchenVersion, changes);
      setConcurrency(saved.concurrency);
      setStaleAfterMinutes(saved.staleAfterMinutes);
      setAutomationEnabled(saved.automationEnabled);
      setPaused(saved.paused);
      setKitchenVersion(saved.version);
      await onChanged();
      report('Đã cập nhật chế độ vận hành bếp');
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể lưu cấu hình bếp', true);
      await Promise.resolve(onChanged()).catch(() => {});
    } finally {
      kitchenBusyRef.current = false;
      setKitchenBusy(false);
    }
  };

  const dispatchNext = async () => {
    if (kitchenBusyRef.current) return;
    kitchenBusyRef.current = true;
    setKitchenBusy(true);
    try {
      const count = await dispatchNextKitchenOrder();
      await onChanged();
      report(count > 0 ? 'Đã đưa phiếu đầu hàng chờ vào bếp' : 'Không có phiếu chờ hoặc bếp đã đủ công suất');
    } catch (error) {
      report(error instanceof Error ? error.message : 'Không thể điều phối phiếu', true);
    } finally {
      kitchenBusyRef.current = false;
      setKitchenBusy(false);
    }
  };

  const canDispatch = !kitchen.paused && !kitchen.automationEnabled && kitchen.waitingCount > 0
    && kitchen.cookingCount < kitchen.concurrency && !kitchenBusy;

  return (
    <div className="management-panel">
      {notice && <div className={`management-notice ${notice.error ? 'error' : ''}`}>{notice.message}</div>}

      <nav className="management-section-nav" aria-label="Khu vực quản trị">
        <div className="management-section-tabs" role="group" aria-label="Chọn khu vực quản trị">
          {([
            { id: 'kitchen', label: 'Bếp', detail: staleBatches.length ? `${staleBatches.length} phiếu quá hạn` : `${kitchen.cookingCount} nấu · ${kitchen.waitingCount} chờ`, icon: staleBatches.length ? <AlertTriangle size={18} /> : <ChefHat size={18} /> },
            { id: 'menu', label: 'Thực đơn', detail: `${menuItems.length} món · ${categories.length} danh mục`, icon: <UtensilsCrossed size={18} /> },
            { id: 'tables', label: 'Bàn', detail: `${tables.length} bàn`, icon: <CirclePlus size={18} /> },
            { id: 'employees', label: 'Nhân viên', detail: `${employees.filter(row => row.active).length} hoạt động`, icon: <UsersRound size={18} /> },
          ] as const).map(section => (
            <button
              key={section.id}
              id={`management-tab-${section.id}`}
              type="button"
              aria-pressed={activeSection === section.id}
              aria-controls={`management-panel-${section.id}`}
              className={activeSection === section.id ? 'active' : ''}
              onClick={() => setActiveSection(section.id)}
            >
              {section.icon}
              <span><strong>{section.label}</strong><small>{section.detail}</small></span>
            </button>
          ))}
        </div>
      </nav>

      {activeSection === 'kitchen' && staleBatches.length > 0 && (
        <section className="management-stale-alert">
          <div className="management-title"><AlertTriangle size={21} /><div><strong>{staleBatches.length} phiếu bếp quá hạn</strong><span>Đã vượt ETA thêm {kitchen.staleAfterMinutes} phút và đang chiếm công suất bếp</span></div></div>
          <div className="management-stale-list">
            {staleBatches.map(batch => (
              <div key={batch.batchId} className="management-stale-row">
                <strong>Bàn {batch.tableNumber}</strong>
                <span>Lượt #{batch.batchNumber}{batch.isAddition ? ' · gọi thêm' : ''}</span>
                <button type="button" className="management-button secondary" disabled={kitchenBusy} onClick={() => void resolveStaleOrder(batch, 'requeue')}><RotateCcw size={15} /> Xếp lại</button>
                <button type="button" className="management-button" disabled={kitchenBusy} onClick={() => void resolveStaleOrder(batch, 'done')}><Save size={15} /> Đã xong</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeSection === 'kitchen' && <section
        id="management-panel-kitchen"
        role="region"
        aria-labelledby="management-tab-kitchen"
        className="management-card management-primary-card"
      >
        <div className="management-title"><ChefHat size={20} /><div><strong>Cấu hình bếp</strong><span>{kitchen.cookingCount} đang nấu · {kitchen.waitingCount} đang chờ</span></div><span className={`kitchen-mode-badge ${paused ? 'paused' : automationEnabled ? 'auto' : 'manual'}`}>{paused ? 'Đang tạm dừng' : automationEnabled ? 'Tự động FIFO' : 'Điều phối thủ công'}</span></div>
        <div className="management-actions"><label>Số phiếu nấu song song<input className={inputClass} type="number" min={1} max={20} value={concurrency} disabled={kitchenBusy} onChange={event => setConcurrency(Number(event.target.value))} /></label><label>Cảnh báo sau ETA (phút)<input className={inputClass} type="number" min={15} max={1440} value={staleAfterMinutes} disabled={kitchenBusy} onChange={event => setStaleAfterMinutes(Number(event.target.value))} /></label><button type="button" className="management-button" disabled={kitchenBusy} onClick={() => void persistKitchen({ concurrency, staleAfterMinutes })}><Save size={16} /> {kitchenBusy ? 'Đang lưu…' : 'Lưu cấu hình'}</button></div>
        <div className="kitchen-control-grid">
          <button type="button" aria-pressed={automationEnabled} className={`kitchen-control ${automationEnabled ? 'active' : ''}`} disabled={kitchenBusy} onClick={() => void persistKitchen({ automationEnabled: !automationEnabled })}><Bot size={18} /><span><strong>Tự động FIFO</strong><small>{automationEnabled ? 'Tự lấy phiếu theo thứ tự chờ' : 'Bật chế độ vận hành tự động'}</small></span></button>
          <button type="button" aria-pressed={paused} className={`kitchen-control ${paused ? 'warning' : ''}`} disabled={kitchenBusy} onClick={() => void persistKitchen({ paused: !paused })}>{paused ? <Play size={18} /> : <Pause size={18} />}<span><strong>{paused ? 'Tiếp tục bếp' : 'Tạm dừng bếp'}</strong><small>Chỉ dừng nhận phiếu; món đang nấu vẫn chạy</small></span></button>
          <button type="button" className="kitchen-control" disabled={!canDispatch} onClick={() => void dispatchNext()}><StepForward size={18} /><span><strong>{kitchenBusy ? 'Đang điều phối…' : 'Lấy phiếu tiếp'}</strong><small>{automationEnabled ? 'Chỉ dùng khi điều phối thủ công' : kitchen.waitingCount === 0 ? 'Không có phiếu đang chờ' : 'Đưa đúng một phiếu đầu hàng chờ vào bếp'}</small></span></button>
        </div>
      </section>}

      {activeSection === 'employees' && <section
        id="management-panel-employees"
        role="region"
        aria-labelledby="management-tab-employees"
        className="management-card management-primary-card"
      >
        <div className="management-title">
          <UsersRound size={20} />
          <div><strong>Quản lý nhân viên</strong><span>{employees.filter(row => row.active).length} đang hoạt động · {employees.length} hồ sơ</span></div>
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
      </section>}

      {activeSection === 'tables' && <section
        id="management-panel-tables"
        role="region"
        aria-labelledby="management-tab-tables"
        className="management-card management-primary-card"
      >
        <div className="management-title"><CirclePlus size={20} /><div><strong>Quản lý bàn</strong><span>Thêm, sửa bàn; trạng thái phục vụ được đồng bộ với bếp</span></div></div>
        <div className="management-row add-row"><input className={inputClass} type="number" value={newTable.number} onChange={event => setNewTable({ ...newTable, number: Number(event.target.value) })} placeholder="Số bàn" /><input className={inputClass} type="number" value={newTable.seats} onChange={event => setNewTable({ ...newTable, seats: Number(event.target.value) })} placeholder="Số ghế" /><button className="management-button" onClick={() => void addTable()}><CirclePlus size={16} /> Thêm bàn</button></div>
        <div className="management-table-head"><span>Số bàn</span><span>Số ghế</span><span>Trạng thái</span><span></span></div>
        <div className="management-list">{tables.map(table => <TableEditor key={table.id} table={table} onChanged={onChanged} report={report} confirmAction={confirmAction} />)}</div>
      </section>}

      {activeSection === 'menu' && <div
        id="management-panel-menu"
        role="region"
        aria-labelledby="management-tab-menu"
        className="management-section-stack"
      >
      <section className="management-card management-menu-card management-primary-card">
        <div className="management-title"><UtensilsCrossed size={20} /><div><strong>Thực đơn & thời gian nấu</strong><span>Giá và thời gian áp dụng cho lượt gọi mới</span></div></div>
        <select className={inputClass} value={selectedItemId} onChange={event => { const id = event.target.value; setSelectedItemId(id); if (id === 'new') setDish({ ...emptyDish, categoryId: categories[0]?.id ?? '' }); }}><option value="new">＋ Thêm món mới</option>{menuItems.map(item => <option key={item.id} value={item.id}>{item.name} — {formatVND(item.price)}{!item.available ? ' (ngừng bán)' : ''}</option>)}</select>
        <div className="management-form-grid">
          <label>Tên món<input className={inputClass} value={dish.name ?? ''} onChange={event => setDish({ ...dish, name: event.target.value })} /></label>
          <label>Danh mục<select className={inputClass} value={dish.categoryId ?? ''} onChange={event => setDish({ ...dish, categoryId: event.target.value })}>{categories.map(category => <option key={category.id} value={category.id}>{category.emoji} {category.name}</option>)}</select></label>
          <label>Giá bán<input className={inputClass} type="number" min={0} value={dish.price ?? 0} onChange={event => setDish({ ...dish, price: Number(event.target.value) })} /></label>
          <label>Thời gian nấu (phút)<input className={inputClass} type="number" min={1} max={240} value={dish.cookMinutes ?? 10} onChange={event => setDish({ ...dish, cookMinutes: Number(event.target.value) })} /></label>
          <label className="wide">Liên kết hình ảnh<input className={inputClass} value={dish.image ?? ''} onChange={event => setDish({ ...dish, image: event.target.value })} /></label>
          <label className="wide">Mô tả<textarea className={inputClass} rows={3} value={dish.description ?? ''} onChange={event => setDish({ ...dish, description: event.target.value })} /></label>
          <label className="management-check"><input type="checkbox" checked={dish.available !== false} onChange={event => setDish({ ...dish, available: event.target.checked })} /> Đang phục vụ</label>
        </div>
        <div className="management-actions"><button className="management-button" onClick={() => void persistDish()}><Save size={16} /> Lưu món</button>{dish.id && <button className="management-button secondary" onClick={() => void deactivate()}><Trash2 size={16} /> Ngừng bán</button>}</div>
      </section>

      <section className="management-card compact"><div className="management-title"><CirclePlus size={20} /><div><strong>Thêm danh mục</strong><span>Tạo nhóm món cho thực đơn</span></div></div><div className="management-row add-row"><input className={inputClass} value={newCategory.emoji} onChange={event => setNewCategory({ ...newCategory, emoji: event.target.value })} aria-label="Biểu tượng" /><input className={inputClass} value={newCategory.name} onChange={event => setNewCategory({ ...newCategory, name: event.target.value })} placeholder="Tên danh mục" /><button className="management-button" onClick={() => void addCategory()}>Thêm</button></div></section>
      </div>}
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
