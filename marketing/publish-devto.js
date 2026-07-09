#!/usr/bin/env node
// Publish a markdown file (with dev.to front matter) to dev.to.
//
// Usage:
//   DEV_TO_API_KEY=xxxx node marketing/publish-devto.js marketing/devto-article-1-complexity-routing.md
//
// The article's front matter controls everything (title, tags, published).
// Keep `published: false` in the front matter to create it as a DRAFT you can
// review at https://dev.to/dashboard before flipping it live.

const fs = require('fs');

const apiKey = process.env.DEV_TO_API_KEY;
const file = process.argv[2];

if (!apiKey) {
  console.error('Set DEV_TO_API_KEY (get one at https://dev.to/settings/extensions)');
  process.exit(1);
}
if (!file || !fs.existsSync(file)) {
  console.error('Usage: DEV_TO_API_KEY=... node marketing/publish-devto.js <article.md>');
  process.exit(1);
}

const bodyMarkdown = fs.readFileSync(file, 'utf8');

fetch('https://dev.to/api/articles', {
  method: 'POST',
  headers: {
    'api-key': apiKey,
    'content-type': 'application/json',
    accept: 'application/vnd.forem.api-v1+json',
  },
  body: JSON.stringify({ article: { body_markdown: bodyMarkdown } }),
})
  .then(async (res) => {
    const data = await res.json();
    if (!res.ok) {
      console.error(`dev.to API error ${res.status}:`, data.error || data);
      process.exit(1);
    }
    console.log(`Created: "${data.title}"`);
    console.log(`State:   ${data.published ? 'PUBLISHED' : 'draft (review at https://dev.to/dashboard)'}`);
    console.log(`URL:     ${data.url}`);
  })
  .catch((err) => {
    console.error('Request failed:', err.message);
    process.exit(1);
  });
