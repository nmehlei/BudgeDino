import { render, screen } from '@testing-library/react-native';

import Home from '../../app/index';
import { AppProviders } from '../providers';

describe('app shell', () => {
  it('renders the home screen inside the Paper and QueryClient providers', async () => {
    await render(
      <AppProviders>
        <Home />
      </AppProviders>,
    );
    expect(screen.getByText('BudgeDino')).toBeTruthy();
  });
});
