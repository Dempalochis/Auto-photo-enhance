import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import Hint from './Hint';

describe('Hint', () => {
  test('renders its children and a hint trigger', () => {
    render(
      <Tooltip.Provider>
        <Hint text="Explanation">Some label</Hint>
      </Tooltip.Provider>,
    );
    expect(screen.getByText('Some label')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});
