import { request } from 'node:http';

try {
  // Node's fetch does not preserve the explicit Host required by the private origin.
  const healthy = await new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: Number(process.env.MONEYWAVE_PORT ?? 43822), path: '/healthz',
      headers: { Host: new URL(process.env.MONEYWAVE_TAILSCALE_ORIGIN).host, 'Tailscale-User-Login': process.env.MONEYWAVE_TAILSCALE_LOGIN },
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk.toString(); });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).status === 'ok'); } catch { resolve(false); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('HEALTH_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
  if (!healthy) process.exitCode = 1;
} catch { process.exitCode = 1; }
