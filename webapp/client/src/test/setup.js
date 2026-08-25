import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement ResizeObserver - @tanstack/react-virtual (PhotoPicker's photo-grid
// virtualization, added for the V8 Phase 1 scale fix) uses it internally to dynamically remeasure
// row heights. A no-op stub is enough for tests: they don't need real resize behavior, just for
// the constructor to exist so mounting a virtualized component doesn't throw.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}

    unobserve() {}

    disconnect() {}
  };
}
