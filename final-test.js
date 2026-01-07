const http = require('http');

const data = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "Say hello" }]
});

const req = http.request({
  hostname: 'localhost',
  port: 8081,
  path: '/v1/messages',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    if (res.statusCode === 200) {
      const json = JSON.parse(body);
      console.log('✅ SUCCESS!');
      console.log('Model:', json.model);
      console.log('Response:', json.content[0].text.substring(0, 150));
    } else {
      console.log('❌ Error:', body.substring(0, 300));
    }
  });
});

req.on('error', e => console.error('Request failed:', e.message));
req.write(data);
req.end();
