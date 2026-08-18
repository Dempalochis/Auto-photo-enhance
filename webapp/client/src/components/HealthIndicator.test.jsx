import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import HealthIndicator from './HealthIndicator';
import * as api from '../api';

vi.mock('../api', () => ({
  getHealth: vi.fn(),
}));

function renderIndicator() {
  return render(<Tooltip.Provider><HealthIndicator /></Tooltip.Provider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HealthIndicator', () => {
  test('shows "Healthy" when there are no errors or warnings', async () => {
    api.getHealth.mockResolvedValue({ ok: true, errors: [], warnings: [] });
    renderIndicator();
    expect(await screen.findByText('Healthy')).toBeInTheDocument();
  });

  test('shows "Degraded" when there are warnings but no errors', async () => {
    api.getHealth.mockResolvedValue({ ok: true, errors: [], warnings: ['exiftool missing'] });
    renderIndicator();
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
  });

  test('shows "Error" when the health check reports ok: false', async () => {
    api.getHealth.mockResolvedValue({ ok: false, errors: ['rtPath not found'], warnings: [] });
    renderIndicator();
    expect(await screen.findByText('Error')).toBeInTheDocument();
  });

  test('shows "Error" when the server cannot be reached at all', async () => {
    api.getHealth.mockRejectedValue(new Error('Failed to fetch'));
    renderIndicator();
    expect(await screen.findByText('Error')).toBeInTheDocument();
  });

  test('renders a hoverable trigger element regardless of status', async () => {
    api.getHealth.mockResolvedValue({ ok: true, errors: [], warnings: [] });
    renderIndicator();
    await screen.findByText('Healthy');
    expect(screen.getByText('Healthy').closest('[tabindex]')).toBeInTheDocument();
  });
});
