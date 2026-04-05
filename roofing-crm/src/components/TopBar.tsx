'use client';

import { useCRMStore } from '@/store';
import { Bell, Search, Plus } from 'lucide-react';
import { useState } from 'react';
import Link from 'next/link';

export default function TopBar() {
  const { currentUser } = useCRMStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showQuickAdd, setShowQuickAdd] = useState(false);

  const notifications = [
    { id: 1, text: 'Adjuster Mike Anderson assigned to Thompson claim', time: '2h ago', unread: true },
    { id: 2, text: 'Maria Garcia signed contingency agreement', time: '5h ago', unread: true },
    { id: 3, text: 'New lead from website - Linda Martinez', time: '1d ago', unread: false },
    { id: 4, text: 'Inspection report generated for Wilson property', time: '2d ago', unread: false },
  ];

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 sticky top-0 z-40">
      {/* Search */}
      <div className="flex items-center gap-4 flex-1">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search leads, homeowners, claims..."
            className="w-full pl-10 pr-4 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Quick Add */}
        <div className="relative">
          <button
            onClick={() => { setShowQuickAdd(!showQuickAdd); setShowNotifications(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Quick Add
          </button>
          {showQuickAdd && (
            <div className="absolute right-0 top-full mt-2 w-48 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50">
              <Link href="/leads?new=true" className="block px-4 py-2 text-sm hover:bg-gray-50" onClick={() => setShowQuickAdd(false)}>
                New Lead
              </Link>
              <Link href="/inspections?new=true" className="block px-4 py-2 text-sm hover:bg-gray-50" onClick={() => setShowQuickAdd(false)}>
                Schedule Inspection
              </Link>
              <Link href="/claims?new=true" className="block px-4 py-2 text-sm hover:bg-gray-50" onClick={() => setShowQuickAdd(false)}>
                File Claim
              </Link>
              <Link href="/policies?new=true" className="block px-4 py-2 text-sm hover:bg-gray-50" onClick={() => setShowQuickAdd(false)}>
                Upload Policy
              </Link>
            </div>
          )}
        </div>

        {/* Notifications */}
        <div className="relative">
          <button
            onClick={() => { setShowNotifications(!showNotifications); setShowQuickAdd(false); }}
            className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <Bell className="w-5 h-5" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
          </button>
          {showNotifications && (
            <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-lg shadow-xl border border-gray-200 z-50">
              <div className="px-4 py-3 border-b border-gray-100">
                <h3 className="font-semibold text-sm">Notifications</h3>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {notifications.map(n => (
                  <div key={n.id} className={`px-4 py-3 border-b border-gray-50 hover:bg-gray-50 cursor-pointer ${n.unread ? 'bg-orange-50/50' : ''}`}>
                    <p className="text-sm">{n.text}</p>
                    <p className="text-xs text-gray-400 mt-1">{n.time}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
