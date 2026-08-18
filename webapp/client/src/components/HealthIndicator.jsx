import { useEffect, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { getHealth } from '../api';
import { healthStatus } from '../healthStatus';

// Config problems (a broken rtPath, a missing scripts folder, ...) don't change from second to
// second - a slow poll is plenty, unlike the job queue's fast poll for live progress.
const POLL_MS = 15000;

const DOT_CLASS = {
  ok: 'bg-[var(--cat-nature)]',
  warning: 'bg-[var(--amber)]',
  error: 'bg-[var(--danger)]',
  unknown: 'bg-[var(--text-dim)]',
};

const LABEL = {
  ok: 'Healthy',
  warning: 'Degraded',
  error: 'Error',
  unknown: 'Checking…',
};

// Small header status pill polling GET /api/health, so a broken rtPath/missing exiftool/etc. is
// visible on the page itself instead of only in the server console (see startupChecks.js). A
// fetch failure (backend unreachable, not just misconfigured) is treated the same as an 'error'
// health response - both mean "something needs attention," just with a different message.
export default function HealthIndicator() {
  const [health, setHealth] = useState(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const data = await getHealth();
        if (!cancelled) { setHealth(data); setUnreachable(false); }
      } catch {
        if (!cancelled) { setHealth(null); setUnreachable(true); }
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const status = unreachable ? 'error' : healthStatus(health);
  const messages = unreachable
    ? ['Cannot reach the server - is it still running?']
    : [...(health?.errors || []), ...(health?.warnings || [])];

  return (
    <Tooltip.Root delayDuration={200}>
      <Tooltip.Trigger asChild>
        <span tabIndex={0} className="inline-flex items-center gap-1.5 cursor-default select-none">
          <span className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLASS[status]}`} aria-hidden="true" />
          <span className="text-[11px] text-[var(--text-dim)]">{LABEL[status]}</span>
        </span>
      </Tooltip.Trigger>
      {messages.length > 0 && (
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            sideOffset={6}
            className="max-w-[320px] text-xs leading-snug bg-[var(--panel-raised)] border border-[var(--border)] text-[var(--text)] rounded-[3px] px-2.5 py-1.5 shadow-lg z-50"
          >
            <ul className="list-disc pl-4 space-y-1">
              {messages.map((m) => <li key={m}>{m}</li>)}
            </ul>
            <Tooltip.Arrow className="fill-[var(--panel-raised)]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      )}
    </Tooltip.Root>
  );
}
