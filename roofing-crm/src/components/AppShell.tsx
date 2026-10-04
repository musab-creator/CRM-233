'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { cn } from '@/lib/utils';
import { useCRMStore } from '@/store';

// Below lg the sidebar is a slide-out drawer opened from the top bar;
// from lg up it is fixed and can be collapsed to icons.
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Load persisted CRM data (roof reports) once on the client.
  useEffect(() => {
    void useCRMStore.persist.rehydrate();
  }, []);

  // Close the drawer after navigating.
  useEffect(() => {
    setMobileOpen(false); // eslint-disable-line react-hooks/set-state-in-effect
  }, [pathname]);

  return (
    <div className="min-h-screen">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(!collapsed)}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-slate-900/50 lg:hidden" onClick={() => setMobileOpen(false)} aria-hidden />
      )}
      <div className={cn('min-h-screen min-w-0 transition-[margin] duration-300', collapsed ? 'lg:ml-16' : 'lg:ml-64')}>
        <TopBar onMenu={() => setMobileOpen(true)} />
        <main className="p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
