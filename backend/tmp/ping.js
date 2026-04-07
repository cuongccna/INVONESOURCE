// Quick HTTP test of POST /api/declarations/calculate
// Need a valid JWT — just test that the endpoint exists and recognizes auth

const http = require('http');
const req = http.request({
  host: 'localhost',
  port: 3001,
  path: '/api/declarations/calculate',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}, (res) => {
  console.log('Status:', res.statusCode);
  // 401 = endpoint exists, requires auth — expected behavior
  // 404 = route not found — bad
  if (res.statusCode === 401) console.log('✓ Backend is up and route is registered');
  else console.log('Unexpected status');
  req.destroy();
});
req.on('error', e => console.error('Connection error:', e.message));
req.write(JSON.stringify({ quarter: 1, year: 2026 }));
req.end();
