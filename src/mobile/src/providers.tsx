import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';

import { useAppTheme } from './theme';

export function AppProviders({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <PaperProvider theme={theme}>{children}</PaperProvider>
    </QueryClientProvider>
  );
}
