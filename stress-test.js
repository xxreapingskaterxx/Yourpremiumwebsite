#!/usr/bin/env node
/* Stress-test: rapid scroll cycling while watching for console errors,
 * page crashes/disconnects, and JS heap growth (memory leak signal). */
const puppeteer = require('puppeteer-core');

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

let browser;
(async () => {
  const url = process.argv[2] || 'http://localhost:5544';
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--hide-scrollbars', '--no-sandbox'],
    protocolTimeout: 20000, // fail fast instead of waiting the 180s default
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push('[console.error] ' + msg.text());
  });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));
  page.on('requestfailed', req => errors.push('[requestfailed] ' + req.url() + ' - ' + (req.failure() && req.failure().errorText)));
  let crashed = false;
  page.on('error', err => { crashed = true; errors.push('[PAGE CRASHED] ' + err.message); });

  console.log('navigating to', url);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('window.__ready === true', { timeout: 45000 });
  console.log('ready. starting stress scroll...');

  async function heap() {
    try {
      const m = await page.metrics();
      return { JSHeapUsedSize: m.JSHeapUsedSize, JSHeapTotalSize: m.JSHeapTotalSize, Nodes: m.Nodes, Documents: m.Documents };
    } catch (e) { return { error: e.message }; }
  }

  console.log('heap at start:', JSON.stringify(await heap()));

  const end = await page.evaluate(() => document.getElementById('filmScroll').getBoundingClientRect().height - innerHeight + document.body.scrollHeight);
  const rounds = 8;
  for (let r = 0; r < rounds; r++) {
    if (crashed) break;
    // rapid jump scrolling, like a user aggressively scrubbing back and forth
    for (let i = 0; i < 20; i++) {
      const y = Math.random() * (end || 8000);
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await new Promise(res => setTimeout(res, 40));
    }
    const h = await heap();
    console.log(`round ${r+1}/${rounds} heap:`, JSON.stringify(h));
    if (crashed) break;
  }

  console.log('heap at end:', JSON.stringify(await heap()));
  console.log('total errors captured:', errors.length);
  errors.slice(0, 50).forEach(e => console.log(e));

  await browser.close();
  process.exit(crashed ? 2 : (errors.length > 0 ? 1 : 0));
})().catch(async (e) => {
  console.error('FATAL:', e.message);
  if (browser) { try { await browser.close(); } catch (_) {} }
  process.exit(3);
});
