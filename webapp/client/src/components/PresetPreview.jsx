import * as RadioGroup from '@radix-ui/react-radio-group';
import { CATEGORIES } from '../presetCategories';

function Tile({ label, status, url, isSelected, accentColor }) {
  const value = label === '00_base_only' ? 'none' : label;
  const caption = label === '00_base_only' ? 'None (color correction only)' : label;
  return (
    <RadioGroup.Item
      value={value}
      style={{ borderLeftColor: isSelected ? accentColor : undefined, borderLeftWidth: accentColor ? 3 : undefined }}
      className="text-left rounded-[4px] overflow-hidden card data-[state=checked]:border-[var(--amber-dim)] focus:outline-none"
    >
      <div className="w-full aspect-[3/2] bg-[var(--panel-raised)] flex items-center justify-center relative">
        {status === 'done' && url ? (
          <img src={url} alt={caption} className="w-full h-full object-cover" />
        ) : status === 'failed' ? (
          <span className="text-xs text-[var(--danger)]">failed</span>
        ) : status === 'running' ? (
          <span className="text-xs text-[var(--text-dim)] animate-pulse">rendering…</span>
        ) : status === 'pending' ? (
          <span className="text-xs text-[var(--text-dim)] opacity-50">queued</span>
        ) : null /* 'idle' - no preview rendered yet; the caption below still names/selects it */}
        {isSelected && (
          <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--amber)] border border-black/40" />
        )}
      </div>
      <p className="text-[11px] px-2 py-1.5 truncate">{caption}</p>
    </RadioGroup.Item>
  );
}

// Always renders every known preset as a selectable tile, whether or not a preview has ever been
// rendered - a look can be picked (and queued for Run) before clicking "Preview" at all. Once a
// preview job exists for a photo, each tile's status/thumbnail comes from that job's progress and
// is filled in / overwritten in place as it renders, live - the grid itself never disappears or
// goes blank while that happens (previously this whole panel was hidden until a job existed).
export default function PresetPreview({ previewPhoto, job, presetNames = [], selectedPreset, onSelectPreset }) {
  const jobItems = job?.progress?.items || [];
  const tileFor = (label) => {
    const found = jobItems.find((i) => i.label === label);
    return { label, status: found?.status || 'idle', url: found?.url || null };
  };

  const baseItem = tileFor('00_base_only');
  const byCategory = CATEGORIES.map((cat) => ({
    ...cat,
    items: cat.presets.filter((name) => presetNames.includes(name)).map(tileFor),
  })).filter((cat) => cat.items.length > 0);

  const doneCount = jobItems.filter((i) => i.status === 'done' || i.status === 'failed').length;
  const total = jobItems.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">2. Pick a look</h2>
        <span className="eyebrow">
          {previewPhoto
            ? `${previewPhoto}${total > 0 ? ` · ${doneCount}/${total}` : ''}`
            : 'Click "Preview" on a photo above to render every look on it'}
        </span>
      </div>

      <RadioGroup.Root value={selectedPreset} onValueChange={onSelectPreset} className="space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          <Tile
            label={baseItem.label}
            status={baseItem.status}
            url={baseItem.url}
            isSelected={selectedPreset === 'none'}
            accentColor="var(--text-dim)"
          />
        </div>

        {byCategory.map((cat) => (
          <div key={cat.key}>
            <div className="flex items-center gap-2 mb-2 pl-3" style={{ borderLeft: `3px solid ${cat.color}` }}>
              <h3 className="eyebrow" style={{ color: cat.color }}>{cat.label}</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {cat.items.map((item) => (
                <Tile
                  key={item.label}
                  label={item.label}
                  status={item.status}
                  url={item.url}
                  isSelected={selectedPreset === item.label}
                  accentColor={cat.color}
                />
              ))}
            </div>
          </div>
        ))}
      </RadioGroup.Root>
    </div>
  );
}
