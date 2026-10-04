'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { useCRMStore } from '@/store';
import { cn } from '@/lib/utils';
import {
  Calculator, LayoutDashboard, Plus, FolderOpen, History, BarChart3, SlidersHorizontal,
  Home, Droplets, Sigma, FileText, Wallet,
} from 'lucide-react';

// Shared frame for every estimator page: CRM shell + the estimator's own
// navigation (the sections of the original app's sidebar). History, market,
// pricing and job cost are manager-only, as in the original.

const sections = [
  { href: '/estimator', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/estimator/new', label: 'New estimate', icon: Plus },
  { href: '/estimator/saved', label: 'Saved', icon: FolderOpen },
  { href: '/estimator/history', label: 'History', icon: History, managerOnly: true },
  { href: '/estimator/market', label: 'Market', icon: BarChart3, managerOnly: true },
  { href: '/estimator/pricing', label: 'Pricing', icon: SlidersHorizontal, managerOnly: true },
];

export function useIsEstimatorManager() {
  return useCRMStore((s) => s.currentUser?.role === 'manager');
}

function TabBar({ items }: { items: { href: string; label: string; icon: typeof Home; exact?: boolean }[] }) {
  const pathname = usePathname() || '';
  return (
    <nav className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex w-max gap-1 rounded-lg bg-gray-100 p-1 sm:w-auto">
        {items.map((it) => {
          const active = it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(it.href + '/');
          return (
            <Link
              key={it.href}
              href={it.href}
              className={cn(
                'inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active ? 'bg-white text-orange-700 shadow-sm' : 'text-gray-600 hover:text-gray-900',
              )}
            >
              <it.icon className="h-4 w-4" />
              {it.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default function EstimatorShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isManager = useIsEstimatorManager();
  return (
    <AppShell>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Calculator className="mt-1 h-7 w-7 flex-shrink-0 text-orange-500" />
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
              {subtitle && <div className="text-sm text-gray-500">{subtitle}</div>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
        <TabBar items={sections.filter((s) => !s.managerOnly || isManager)} />
        {children}
      </div>
    </AppShell>
  );
}

// Per-estimate tabs: /estimator/[id] (combined review), /roof, /gutter, /proposal, /job-cost.
export function EstimateTabs({ id }: { id: string }) {
  const isManager = useIsEstimatorManager();
  const base = `/estimator/${id}`;
  const items = [
    { href: base, label: 'Combined', icon: Sigma, exact: true },
    { href: `${base}/roof`, label: 'Roof', icon: Home },
    { href: `${base}/gutter`, label: 'Gutter', icon: Droplets },
    { href: `${base}/proposal`, label: 'Proposal', icon: FileText },
    ...(isManager ? [{ href: `${base}/job-cost`, label: 'Job cost', icon: Wallet }] : []),
  ];
  return <TabBar items={items} />;
}
