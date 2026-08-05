import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  /** Right-aligned annotation in the title bar — a count, a unit, a hint. */
  meta?: ReactNode;
  /** Marks this panel as holding the selected instrument (grows the amber tick). */
  active?: boolean;
  className?: string;
  bodyClassName?: string;
  testId?: string;
  children: ReactNode;
}

export function Panel({
  title,
  meta,
  active = false,
  className = "",
  bodyClassName = "",
  testId,
  children,
}: PanelProps) {
  return (
    <section
      data-testid={testId}
      className={`panel ${active ? "panel-active" : ""} ${className}`.trim()}
    >
      <header className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {meta ? <div className="panel-meta">{meta}</div> : null}
      </header>
      <div className={`panel-body ${bodyClassName}`.trim()}>{children}</div>
    </section>
  );
}

/** Shared empty/placeholder treatment: an invitation, never a dead panel. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[11px] tracking-wide text-faint">
      {children}
    </div>
  );
}
