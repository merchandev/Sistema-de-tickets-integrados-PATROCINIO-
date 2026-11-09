// Minimal local SMTP server for end-to-end tests: accepts every message and saves it as .eml.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });
let count = 0;

net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  let data = [];
  const reply = (line) => socket.write(line + '\r\n');
  reply('220 sink.local ESMTP test');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('binary');
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          fs.writeFileSync(path.join(outDir, `${String(++count).padStart(3, '0')}.eml`), Buffer.from(data.join('\r\n'), 'binary'));
          data = [];
          reply('250 OK queued');
        } else {
          data.push(line.startsWith('..') ? line.slice(1) : line);
        }
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') { reply('250-sink.local'); reply('250-SIZE 52428800'); reply('250 8BITMIME'); }
      else if (cmd === 'HELO') reply('250 sink.local');
      else if (cmd === 'DATA') { inData = true; reply('354 End data with <CR><LF>.<CR><LF>'); }
      else if (cmd === 'QUIT') { reply('221 Bye'); socket.end(); }
      else reply('250 OK');
    }
  });
  socket.on('error', () => {});
}).listen(Number(process.argv[3] || 2525), '127.0.0.1', () => console.log('smtp sink ready'));
