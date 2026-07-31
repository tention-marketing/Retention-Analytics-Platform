import { Route, Routes } from 'react-router';
import { FoundationPage } from '@/pages/FoundationPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

/**
 * Route table.
 *
 * Two routes, both temporary. The real map — /login, /accounts, /accounts/new,
 * /accounts/:accountId, /accounts/:accountId/onboarding — arrives with the
 * checkpoints that implement those pages. Declaring them now would mean five
 * routes rendering placeholders, which reads as progress and is not.
 *
 * `<Routes>` rather than a data router: no loaders or actions are wanted here.
 * Data fetching goes through TanStack Query so that caching, invalidation and
 * retry policy live in exactly one place.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<FoundationPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
