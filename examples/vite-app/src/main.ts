import { type Hume, HumeClient } from 'hume';

const body = document.querySelector('body');
if (body === null) {
  throw new Error('The example requires a document body');
}

const container = document.createElement('div');
body.appendChild(container);

const connectionState = document.createElement('div');
container.appendChild(connectionState);

const messageHistory = document.createElement('div');
container.appendChild(messageHistory);
messageHistory.innerHTML = `<div style="margin-top:20px;">Message History:</div>`;

const appendMessage = (message: Hume.empathicVoice.SubscribeEvent) => {
  const timestamp = new Date().toLocaleTimeString();

  const messageContainer = document.createElement('div');
  // textContent, not innerHTML: transcript content is server-provided text
  // and must not be parsed as markup.
  if (message.type === 'assistant_message' || message.type === 'user_message') {
    messageContainer.textContent = `[${timestamp}] ${message.message.role}: ${message.message.content}`;
  } else {
    messageContainer.textContent = `[${timestamp}] <Audio Blob>`;
  }

  messageHistory.appendChild(messageContainer);
};

// String(...) would turn an unset env var into the literal "undefined",
// which passes non-empty credential checks and fails only at the server.
const apiKey: unknown = import.meta.env['VITE_HUME_API_KEY'];
if (typeof apiKey !== 'string' || apiKey.trim() === '') {
  connectionState.textContent =
    'Connection State: VITE_HUME_API_KEY is not set. Add it to a .env file.';
  throw new Error('VITE_HUME_API_KEY is not set');
}

const hume = new HumeClient({ apiKey });

const client = hume.empathicVoice.chat.connect();

client.on('open', () => {
  connectionState.innerHTML = 'Connection State: connected';
});

client.on('message', (message) => {
  appendMessage(message);
});

client.on('close', () => {
  connectionState.innerHTML = 'Connection State: disconnected';
});

client.connect();
