const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
  });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2, // retina-sharp source
  });

  const file = 'file://' + path.resolve(__dirname, 'og-card.html');
  await page.goto(file, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  await page.screenshot({
    path: path.resolve(__dirname, 'og-diversity-roofing@2x.png'),
    clip: { x: 0, y: 0, width: 1200, height: 630 },
  });

  // 1x version — the one to actually ship
  const page1 = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page1.goto(file, { waitUntil: 'networkidle' });
  await page1.waitForTimeout(600);
  await page1.screenshot({
    path: path.resolve(__dirname, 'og-diversity-roofing.png'),
    clip: { x: 0, y: 0, width: 1200, height: 630 },
  });

  await browser.close();
  console.log('rendered');
})();
