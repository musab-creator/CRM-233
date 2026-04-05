'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCRMStore } from '@/store';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, Users, FileText, Shield, ClipboardCheck,
  Camera, Megaphone, Settings, ChevronLeft, ChevronRight,
  LogOut, Building2, FileSignature
} from 'lucide-react';
import { useState } from 'react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/leads', label: 'Leads & Jobs', icon: Users },
  { href: '/policies', label: 'Policies', icon: Shield },
  { href: '/claims', label: 'Claims Tracker', icon: FileText },
  { href: '/inspections', label: 'Inspections', icon: Camera },
  { href: '/contingency', label: 'Contingency', icon: FileSignature },
  { href: '/marketing', label: 'Marketing', icon: Megaphone, managerOnly: true },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { currentUser, setCurrentUser, users } = useCRMStore();
  const [collapsed, setCollapsed] = useState(false);
  const [showUserSwitch, setShowUserSwitch] = useState(false);

  if (!currentUser) return null;

  const filteredNav = navItems.filter(item =>
    !item.managerOnly || currentUser.role === 'manager'
  );

  return (
    <aside className={cn(
      'fixed left-0 top-0 h-full bg-slate-900 text-white transition-all duration-300 z-50 flex flex-col',
      collapsed ? 'w-16' : 'w-64'
    )}>
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-700">
        <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-red-600 rounded-lg flex items-center justify-center flex-shrink-0">
          <Building2 className="w-5 h-5 text-white" />
        </div>
        {!collapsed && (
          <div>
            <h1 className="font-bold text-sm leading-tight">StormShield</h1>
            <p className="text-[10px] text-slate-400">Roofing CRM</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 overflow-y-auto">
        {filteredNav.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors',
                isActive
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              )}
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className="border-t border-slate-700 p-3">
        {showUserSwitch && !collapsed && (
          <div className="mb-2 bg-slate-800 rounded-lg p-2">
            <p className="text-[10px] text-slate-400 mb-1 px-2">Switch User</p>
            {users.map(user => (
              <button
                key={user.id}
                onClick={() => { setCurrentUser(user); setShowUserSwitch(false); }}
                className={cn(
                  'w-full text-left px-2 py-1.5 rounded text-xs transition-colors',
                  user.id === currentUser.id ? 'bg-orange-600' : 'hover:bg-slate-700'
                )}
              >
                {user.name} <span className="text-slate-400">({user.role === 'manager' ? 'Mgr' : 'Rep'})</span>
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => setShowUserSwitch(!showUserSwitch)}
          className="flex items-center gap-3 w-full text-left px-2 py-2 rounded-lg hover:bg-slate-800 transition-colors"
        >
          <div className="w-8 h-8 bg-orange-600 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold">
            {currentUser.name.split(' ').map(n => n[0]).join('')}
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{currentUser.name}</p>
              <p className="text-[10px] text-slate-400 capitalize">{currentUser.role.replace('_', ' ')}</p>
            </div>
          )}
        </button>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-8 w-6 h-6 bg-slate-700 rounded-full flex items-center justify-center hover:bg-slate-600 transition-colors"
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>
    </aside>
  );
}
