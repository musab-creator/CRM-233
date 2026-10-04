'use client';

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from './ui';

// Toasts ("Saved DR-1004", "Report applied — ...") and a confirm dialog that
// is a bottom sheet on phones, like the CRM's other dialogs.

let toastText = '';
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string) {
  toastText = text;
  emit();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastText = '';
    emit();
  }, 2800);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function Toaster({ raised }: { raised?: boolean }) {
  const text = useSyncExternalStore(subscribe, () => toastText, () => '');
  if (!text) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4 ${raised ? 'bottom-24' : 'bottom-6'}`}
    >
      <div className="max-w-md rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg">{text}</div>
    </div>
  );
}

export interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  secondary?: { label: string; onClick: () => void };
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onClose]);
  if (!request) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        className="w-full max-w-md rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-900">{request.title}</h2>
        {request.body ? <div className="mt-2 text-sm text-gray-600">{request.body}</div> : null}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose}>Cancel</Button>
          {request.secondary ? (
            <Button
              variant="danger"
              onClick={() => {
                request.secondary!.onClick();
                onClose();
              }}
            >
              {request.secondary.label}
            </Button>
          ) : null}
          <Button
            variant={request.danger ? 'danger' : 'primary'}
            className={request.danger ? '!bg-red-600 !text-white hover:!bg-red-700' : ''}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              try {
                request.onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
