'use strict';
// In-process event bus feeding Server-Sent Events to dashboards/spreadsheets.
const clients = new Set();

function subscribe(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => { clearInterval(ping); clients.delete(res); });
}

function publish(type, data = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify({ ...data, at: new Date().toISOString() })}\n\n`;
  for (const res of clients) res.write(msg);
}

function closeAll() {
  for (const res of clients) res.end();
  clients.clear();
}

module.exports = { subscribe, publish, closeAll };
