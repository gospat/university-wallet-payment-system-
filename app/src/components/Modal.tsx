import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: ModalSize;
}

const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, footer, size = 'md' }) => {
  const titleId = useId();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const lastActiveRef = useRef<HTMLElement | null>(null);
  const didOpenRef = useRef(false);

  // Open-focus: fire ONLY on the false → true transition of isOpen.
  // NEVER re-run on subsequent re-renders or onClose identity changes
  // (that would steal focus from form inputs back to the X on every keystroke).
  useEffect(() => {
    if (!isOpen) {
      didOpenRef.current = false;
      return;
    }
    if (didOpenRef.current) return;
    didOpenRef.current = true;
    lastActiveRef.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const dialogEl = closeBtnRef.current?.closest('[role="dialog"]') as HTMLElement | null;
      const firstInput = dialogEl?.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (firstInput && typeof firstInput.focus === 'function') {
        firstInput.focus({ preventScroll: true });
      } else {
        closeBtnRef.current?.focus?.();
      }
    });
  }, [isOpen]);

  // Close-restore: fire ONLY on the true → false transition of isOpen.
  useEffect(() => {
    if (isOpen) return;
    return () => {
      if (didOpenRef.current) {
        didOpenRef.current = false;
        requestAnimationFrame(() => {
          lastActiveRef.current?.focus?.();
          lastActiveRef.current = null;
        });
      }
    };
  }, [isOpen]);

  // Escape-key listener. Safe to re-bind when onClose / isOpen changes.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-opacity"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={`bg-white rounded-2xl shadow-xl w-full ${SIZE_CLASSES[size]} transform transition-all scale-100 flex flex-col max-h-[90vh] overflow-hidden`}
      >
        {/* Header */}
        {title !== undefined && title !== null ? (
          <div className="flex items-center justify-between p-6 border-b border-gray-100 shrink-0">
            <h3 id={titleId} className="text-xl font-bold text-gray-900">{title}</h3>
            <button
              onClick={onClose}
              ref={closeBtnRef}
              aria-label="Close dialog"
              className="text-gray-400 hover:text-gray-500 hover:bg-gray-100 p-2 rounded-full transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-end p-2 shrink-0 z-10 relative">
            <button
              onClick={onClose}
              ref={closeBtnRef}
              aria-label="Close dialog"
              className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 p-2 rounded-full transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* Body — scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          {children}
        </div>

        {/* Footer — sticky */}
        {footer && (
          <div className="shrink-0 px-6 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
