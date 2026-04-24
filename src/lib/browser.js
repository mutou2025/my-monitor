const { randomUserAgent } = require('./fetcher');

async function fetchRenderedHtml(url, config, logger) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (error) {
    logger.warn(`Playwright 未安装，跳过动态页面渲染：${error.message}`);
    return null;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent: randomUserAgent(),
      locale: 'fr-CA',
      viewport: { width: 1440, height: 1100 }
    });
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.playwrightTimeoutMs
    });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);
    return await page.content();
  } catch (error) {
    logger.warn(`Playwright 渲染失败：${url} - ${error.message}`);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { fetchRenderedHtml };
