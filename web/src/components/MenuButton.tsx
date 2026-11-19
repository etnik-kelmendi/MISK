import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}

interface Props {
  /** Visible content of the button (icon and text). */
  children: ReactNode;
  items: MenuItem[];
  /** Accessible name of the menu itself. */
  menuLabel: string;
  disabled?: boolean;
  className?: string;
}

/** A button that opens a small menu of actions (WAI-ARIA menu button pattern). */
export function MenuButton({ children, items, menuLabel, disabled, className = 'abtn' }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  // A click or touch outside closes the menu.
  useEffect(() => {
    if (!open) return;
    function outside(event: MouseEvent | TouchEvent) {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', outside);
    document.addEventListener('touchstart', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('touchstart', outside);
    };
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }

  function move(to: number) {
    const count = items.length;
    itemRefs.current[((to % count) + count) % count]?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(current < 0 ? items.length - 1 : current - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
    }
  }

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={className}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        // Points at the menu only while it is on the page.
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
      </button>
      {open && (
        <div id={menuId} className="menu" role="menu" tabIndex={-1} aria-label={menuLabel} onKeyDown={onMenuKeyDown}>
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
