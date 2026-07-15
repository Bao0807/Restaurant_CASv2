import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { formatVND } from '../data';
import type { ReportTimelineRow } from '../reporting';

function formatShort(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}tỷ`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}tr`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function RevenueChart({ data }: { data: ReportTimelineRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={184}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -12, bottom: 0 }} accessibilityLayer>
        <defs><linearGradient id="dashboardRevenue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0D9488" stopOpacity={0.28} /><stop offset="95%" stopColor="#0D9488" stopOpacity={0} /></linearGradient></defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748B' }} tickLine={false} axisLine={false} minTickGap={14} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} tickFormatter={value => formatShort(Number(value))} tickLine={false} axisLine={false} />
        <Tooltip
          formatter={(value: number) => [formatVND(Number(value)), 'Doanh thu']}
          labelFormatter={(label, payload) => (payload?.[0]?.payload as ReportTimelineRow | undefined)?.detail ?? String(label)}
          contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 8px 20px rgba(15,23,42,0.14)' }}
        />
        <Area type="monotone" dataKey="revenue" stroke="#0D9488" strokeWidth={2.5} fill="url(#dashboardRevenue)" dot={false} connectNulls={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function OrdersChart({ data }: { data: ReportTimelineRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -12, bottom: 0 }} accessibilityLayer>
        <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748B' }} tickLine={false} axisLine={false} minTickGap={14} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip
          formatter={(value: number) => [`${Number(value)} đơn`, 'Số hóa đơn']}
          labelFormatter={(label, payload) => (payload?.[0]?.payload as ReportTimelineRow | undefined)?.detail ?? String(label)}
          contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 8px 20px rgba(15,23,42,0.14)' }}
        />
        <Bar dataKey="orders" fill="#2563EB" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}
