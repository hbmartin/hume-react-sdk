import { EmbeddedVoice } from '@humeai/voice-embed-react';
import { useState } from 'react';

import './App.css';

function App() {
  const apiKey = String(import.meta.env['VITE_PUBLIC_HUME_API_KEY'] ?? '');
  const rendererUrl =
    String(import.meta.env['VITE_PUBLIC_RENDERER_URL'] ?? '').trim() ||
    'https://voice-widget.hume.ai/';
  const [isEmbedOpen, setIsEmbedOpen] = useState(false);
  const [openOnMount] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('launchWidget') === 'true';
  });

  return (
    <>
      <div>Demo of embedding voice as an iframe</div>
      <button onClick={() => setIsEmbedOpen(true)}>Open widget</button>
      <EmbeddedVoice
        auth={{ type: 'apiKey', value: apiKey }}
        debug={true}
        rendererUrl={rendererUrl}
        onMessage={(msg) => {
          console.log('we got a message', msg);
        }}
        onClose={() => {
          setIsEmbedOpen(false);
        }}
        isEmbedOpen={isEmbedOpen}
        hostname={String(
          import.meta.env['VITE_PUBLIC_HOSTNAME'] ?? 'api.hume.ai',
        )}
        openOnMount={openOnMount}
      />
    </>
  );
}

export default App;
