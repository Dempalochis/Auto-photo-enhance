import * as Tooltip from '@radix-ui/react-tooltip';

// Wraps a control with a small "?" hint that shows explanatory text on hover/focus.
// Use for anything whose behavior isn't obvious at a glance (e.g. what a toggle actually does).
export default function Hint({ text, children }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <Tooltip.Root delayDuration={200}>
        <Tooltip.Trigger asChild>
          <span
            tabIndex={0}
            className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-[var(--border)] text-[var(--text-dim)] text-[10px] leading-none cursor-help select-none"
          >
            ?
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="max-w-[220px] text-xs leading-snug bg-[var(--panel-raised)] border border-[var(--border)] text-[var(--text)] rounded-[3px] px-2.5 py-1.5 shadow-lg z-50"
          >
            {text}
            <Tooltip.Arrow className="fill-[var(--panel-raised)]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </span>
  );
}
