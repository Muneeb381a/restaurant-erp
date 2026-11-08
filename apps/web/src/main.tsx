import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Health = 'checking' | 'ok' | 'down';

function App() {
  const [health, setHealth] = useState<Health>('checking');
  useEffect(() => {
    fetch('/health')
      .then((r) => setHealth(r.ok ? 'ok' : 'down'))
      .catch(() => setHealth('down'));
  }, []);
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Restaurant ERP</h1>
      <p>API: {health}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
