import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/index.css';

// No service worker is registered here, and none exists in this project. A
// worker can cache authenticated responses to disk and outlive a logout, which
// is precisely the storage rule this app is built around.

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
