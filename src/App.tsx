import { HashRouter, Routes, Route } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toast';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const EditorPage = lazy(() => import('./pages/EditorPage'));
const PreviewPage = lazy(() => import('./pages/PreviewPage'));

export function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <HashRouter>
        <Suspense
          fallback={
            <div className="flex h-screen items-center justify-center">
              <div className="animate-pulse text-muted-foreground">Laden…</div>
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/project/:id" element={<EditorPage />} />
            <Route path="/project/:id/preview" element={<PreviewPage />} />
          </Routes>
        </Suspense>
      </HashRouter>
      {/* One viewport for the whole app: every temporary message goes through
          `toast`, wherever it is raised. */}
      <Toaster />
    </TooltipProvider>
  );
}
