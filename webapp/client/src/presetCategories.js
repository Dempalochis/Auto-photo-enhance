export const CATEGORIES = [
  { key: 'nature', label: 'Nature', color: 'var(--cat-nature)', presets: ['nature_earth', 'golden_hour', 'forest_moody', 'dramatic_sky', 'autumn_glow', 'misty_morning', 'vibrant_bloom'] },
  { key: 'urban', label: 'Urban', color: 'var(--cat-urban)', presets: ['teal_orange', 'urban_fade', 'street_mono', 'concrete_cool', 'blue_hour', 'industrial_grit', 'night_market_vibrant'] },
  { key: 'night', label: 'Night', color: 'var(--cat-night)', presets: ['neon_nights', 'astro_sky', 'moonlit_blue', 'citylight_glow', 'starlit_desert', 'warm_streetlamp'] },
  { key: 'portrait', label: 'Portrait', color: 'var(--cat-portrait)', presets: ['natural_skin', 'editorial_mono', 'soft_glow', 'moody_warm', 'vintage_film_portrait', 'high_key_bright'] },
  { key: 'mood', label: 'Mood', color: 'var(--cat-mood)', presets: ['pastel_dream', 'punch_pop', 'cinematic_drama', 'vibrant_travel'] },
];

export function categoryFor(presetName) {
  return CATEGORIES.find((c) => c.presets.includes(presetName)) || null;
}
