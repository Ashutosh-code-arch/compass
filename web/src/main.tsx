import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import './styles.css';

// A single-user local tool reading a corpus that syncs on cron: nothing changes while you look at
// it, so refetching on every window focus is noise. Decisions invalidate explicitly instead.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
});

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
