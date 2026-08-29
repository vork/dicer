import { App } from './app';

const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
if (!canvas) throw new Error('missing #stage canvas');

const app = new App(canvas);
(window as unknown as { dicer: App }).dicer = app;

app.start().catch((error) => {
  console.error(error);
  const loader = document.getElementById('loader');
  if (loader) {
    loader.textContent = '';
    const message = document.createElement('div');
    message.className = 'loader-text';
    message.textContent = 'could not start — see console';
    loader.appendChild(message);
  }
});
