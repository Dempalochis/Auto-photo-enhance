import { expect, test } from 'vitest';
import {
  bumpStep, clampStep, formatStep, nonZeroSteps, STEPS,
} from './correctionSteps';

test('steps are clamped to -2..+2 and formatted with a sign', () => {
  expect(clampStep(5)).toBe(2);
  expect(clampStep(-3)).toBe(-2);
  expect(clampStep('1.4')).toBe(1);
  expect(bumpStep({ exposure: 2 }, 'exposure', 1)).toEqual({ exposure: 2 });
  expect(bumpStep({}, 'clarity', -1)).toEqual({ clarity: -1 });
  expect(formatStep(1)).toBe('+1');
  expect(formatStep(-2)).toBe('-2');
  expect(formatStep(0)).toBe('0');
});

test('nonZeroSteps keeps the table order; no noise/sharpening steps in Version 2', () => {
  expect(nonZeroSteps({ tint: 1, exposure: -1 }).map((s) => s.key)).toEqual(['exposure', 'tint']);
  expect(STEPS.map((s) => s.key)).not.toContain('noiseReduction');
  expect(STEPS.map((s) => s.key)).not.toContain('sharpening');
});
