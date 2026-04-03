'use client';

import { cn } from '@/lib/utils';

interface StatusBadgeProps {
  label: string;
  colorClass: string;
  size?: 'sm' | 'md';
}

export default function StatusBadge({ label, colorClass, size = 'sm' }: StatusBadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center font-medium rounded-full',
      colorClass,
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'
    )}>
      {label}
    </span>
  );
}
