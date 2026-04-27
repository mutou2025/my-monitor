const { randomUserAgent } = require('./fetcher');

function isCaptchaInterstitial(status, html) {
  const body = String(html || '');
  if (!body) return false;
  return (
    status === 202
    || /\/\.well-known\/sgcaptcha\//i.test(body)
    || /http-equiv=["']refresh["'][^>]*sgcaptcha/i.test(body)
  );
}

/**
 * Fetch HTML via Playwright (headless Chromium).
 * Falls back gracefully if Playwright is not installed.
 */
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

/**
 * Try fetcher.fetchText() first. If the target site returns 403/401 (typical
 * Cloudflare / WAF block on datacenter IPs), automatically retry with
 * Playwright which launches a real Chromium and passes WAF checks.
 */
async function fetchWithPlaywrightFallback(url, { fetcher, config, logger, label }) {
  try {
    const response = await fetcher.request(url, {
      timeoutMs: config.requestTimeoutMs,
      responseType: 'text'
    });

    if (isCaptchaInterstitial(response.status, response.text)) {
      logger.warn(`[${label}] 检测到验证码/反爬中间页 (HTTP ${response.status})，尝试 Playwright 渲染...`);
      const rendered = await fetchRenderedHtml(url, config, logger);
      if (rendered && !isCaptchaInterstitial(200, rendered)) {
        logger.info(`[${label}] Playwright 渲染成功，继续解析。`);
        return { html: rendered, usedPlaywright: true };
      }
      throw new Error(`[${label}] 检测到 202/captcha 响应，且 Playwright 未获取到真实页面。`);
    }

    return { html: response.text, usedPlaywright: false };
  } catch (error) {
    if (/HTTP 40[13]/.test(error.message)) {
      logger.warn(`[${label}] 页面被 WAF 拦截 (${error.message})，尝试 Playwright 渲染...`);
      const rendered = await fetchRenderedHtml(url, config, logger);
      if (rendered) {
        logger.info(`[${label}] Playwright 渲染成功，继续解析。`);
        return { html: rendered, usedPlaywright: true };
      }
      throw new Error(`[${label}] 页面被 WAF 拦截且 Playwright 渲染也失败，无法获取数据。`);
    }
    throw error;
  }
}

module.exports = { fetchRenderedHtml, fetchWithPlaywrightFallback };
