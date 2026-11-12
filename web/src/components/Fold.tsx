import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * A section that stays folded until its title is clicked, with a short summary (such as "3 reviews")
 * next to the title. Built on <details>, so keyboards and screen readers can open it too.
 */
export function Fold({
  title,
  summary,
  level = 3,
  className = '',
  children,
}: {
  title: string;
  summary?: string;
  level?: 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <details className={`fold ${className}`}>
      <summary>
        <Heading className="fold-title">{title}</Heading>
        {summary && <span className="badge grey">{summary}</span>}
        <Icon name="chevR" />
      </summary>
      <div className="fold-body stack">{children}</div>
    </details>
  );
}
