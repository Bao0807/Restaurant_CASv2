import { BarChart3, CalendarCheck2, ClipboardList, CreditCard, Settings2, type LucideIcon } from 'lucide-react';
import type { AppView } from '../data';

interface BottomNavProps {
  view: AppView;
  onViewChange: (v: AppView) => void;
}

const TABS: { id: AppView; label: string; Icon: LucideIcon }[] = [
  { id: 'order',     label: 'Vận hành',   Icon: ClipboardList },
  { id: 'reservations', label: 'Đặt bàn', Icon: CalendarCheck2 },
  { id: 'payment',   label: 'Thanh toán', Icon: CreditCard    },
  { id: 'reports',   label: 'Báo cáo',    Icon: BarChart3     },
  { id: 'dashboard', label: 'Quản trị',   Icon: Settings2     },
];

export function BottomNav({ view, onViewChange }: BottomNavProps) {
  return (
    <nav
      className="cas-nav"
      style={{
        background: '#111827',
        boxShadow: '0 -1px 0 rgba(255,255,255,0.06)',
        position: 'relative', width: '100%', zIndex: 40, flexShrink: 0,
        display: 'flex',
      }}
    >
      {TABS.map(({ id, label, Icon }) => {
        const active = view === id;
        return (
          <button
            className="cas-nav-button"
            data-view={id}
            aria-current={active ? 'page' : undefined}
            key={id}
            onClick={() => onViewChange(id)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: 3, paddingTop: 10, paddingBottom: 12,
              background: 'none', border: 'none', cursor: 'pointer', position: 'relative',
              color: active ? '#2DD4BF' : '#6B7280',
            }}
          >
            <Icon size={22} strokeWidth={active ? 2.5 : 1.8} />
            <span style={{
              fontSize: '10px', fontWeight: active ? 700 : 400, letterSpacing: '0.02em',
            }}>
              {label}
            </span>
            {active && (
              <span className="cas-nav-indicator" style={{
                position: 'absolute', bottom: 0, width: 28, height: 3,
                background: '#2DD4BF', borderRadius: '2px 2px 0 0',
              }} />
            )}
          </button>
        );
      })}
    </nav>
  );
}
