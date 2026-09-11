import { spawn } from 'node:child_process';
import { APP_URL } from './constants.js';
import { createApplication } from './app.js';
import { listen } from './server.js';

function openBrowser(url) {
  const commands = {
    win32: ['cmd', ['/c', 'start', '', url]],
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]],
  };
  const command = commands[process.platform];
  if (!command) return false;
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
    child.once('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

let application;
try {
  application = createApplication();
  await listen(application.server);
} catch (error) {
  if (error.code === 'EADDRINUSE') console.error('xmsync could not start because localhost port 8787 is already in use.');
  else console.error(`xmsync could not start: ${error.message}`);
  process.exit(1);
}

console.log(`xmsync is running at ${APP_URL}`);
if (!process.argv.includes('--no-open') && !openBrowser(APP_URL)) console.log(`Open ${APP_URL} in your browser.`);
application.scheduler.resume();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  application.scheduler.disarm();
  const serverClosed = new Promise((resolve) => application.server.close(resolve));
  await Promise.all([serverClosed, application.coordinator.close()]);
  application.database.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
