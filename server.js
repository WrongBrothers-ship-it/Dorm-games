const express = require('express');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const path = require('path');

const app = express();

// Serve static web pages from public/ folder
app.use(express.static(path.join(__dirname, 'public')));

const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

// Phones only allow motion sensors on https pages, so also serve over https
// with a self-signed certificate that covers this machine's LAN addresses.
// The cert is cached so the phone's "proceed anyway" choice keeps working.
function loadCert() {
  const certDir = path.join(__dirname, '.cert');
  const keyFile = path.join(certDir, 'key.pem');
  const certFile = path.join(certDir, 'cert.pem');
  const ipsFile = path.join(certDir, 'ips.json');

  const cached = fs.existsSync(ipsFile) && JSON.stringify(lanIps) === fs.readFileSync(ipsFile, 'utf8');
  if (cached && fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIps.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(ipsFile, JSON.stringify(lanIps));
  return { key: pems.private, cert: pems.cert };
}

const httpServer = http.createServer(app);
const httpsServer = https.createServer(loadCert(), app);

// One WebSocket server shared by both, so a TV on http and phones on https
// can still reach each other.
const wss = new WebSocket.Server({ noServer: true });
for (const server of [httpServer, httpsServer]) {
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

// Handle WebSocket connections for WebRTC signaling
wss.on('connection', (ws) => {
  console.log('Client connected to signaling server');

  ws.on('message', (message) => {
    // Relay signaling messages (SDP offers/answers and ICE candidates) to other connected clients
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 8080;
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;

// An old copy of the server still running is the usual reason startup fails
for (const server of [httpServer, httpsServer]) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${err.port} is already in use. An old server is probably still running.`);
      console.error('Close its terminal (or press Ctrl+C in it) and run npm start again.');
      process.exit(1);
    }
    throw err;
  });
}

httpServer.listen(PORT, () => {
  const tvUrl = `http://localhost:${PORT}/tv.html`;
  console.log(`TV view:    ${tvUrl}`);
  // Open the TV page automatically (Windows / macOS / Linux)
  const opener = { win32: 'cmd /c start ""', darwin: 'open' }[process.platform] || 'xdg-open';
  require('child_process').exec(`${opener} ${tvUrl}`, () => {});
});
httpsServer.listen(HTTPS_PORT, () => {
  for (const ip of lanIps) {
    const phoneUrl = `https://${ip}:${HTTPS_PORT}/phone.html`;
    console.log(`Phone view: ${phoneUrl}`);
    // Scan with the phone camera instead of typing the address
    require('qrcode-terminal').generate(phoneUrl, { small: true });
  }
  console.log('(Accept the browser security warning once on the phone)');
});
