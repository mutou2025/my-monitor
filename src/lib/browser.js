const { randomUserAgent } = require('./fetcher');

function isCaptchaInterstitial(status, html) {
  const body = String(html || '');
  if (!body) return false;
  return (
    status === 202
    || /\/\.well-known\/sgcaptcha\//i.test(body)
    || /http-equiv=["']refresh["'][^>]*sgcaptcha/i.test(body)
    // Cloudflare JS challenge / Turnstile / managed challenge
    || /challenges\.cloudflare\.com/i.test(body)
    || /cdn-cgi\/challenge-platform/i.test(body)
    || (/just a moment/i.test(body) && /cloudflare/i.test(body))
    // Very short body with meta-refresh (generic interstitial)
    || (body.length < 4000 && /http-equiv=["']refresh["']/i.test(body) && !/tcf|alliance|exam/i.test(body))
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
 *
 * Options:
 *   - expectedPattern: RegExp to validate page content; triggers Playwright
 *     fallback if the fetched HTML doesn't match (catches Cloudflare HTTP-200
 *     JS challenges that isCaptchaInterstitial misses).
 *   - preferPlaywright: if true, try Playwright first (for sites with
 *     aggressive anti-bot that almost always block plain fetch on datacenter IPs).
 */
async function fetchWithPlaywrightFallback(url, { fetcher, config, logger, label, expectedPattern, preferPlaywright }) {
  // ── preferPlaywright: try Playwright first ──────────────────────────
  if (preferPlaywright) {
    logger.debug(`[${label}] preferPlaywright 已启用，优先使用 Playwright 渲染。`);
    const rendered = await fetchRenderedHtml(url, config, logger);
    if (rendered && !isCaptchaInterstitial(200, rendered)) {
      const passesValidation = !expectedPattern || expectedPattern.test(rendered);
      if (passesValidation) {
        logger.info(`[${label}] Playwright 渲染成功，继续解析。`);
        return { html: rendered, usedPlaywright: true };
      }
      logger.warn(`[${label}] Playwright 渲染页面缺少预期关键词，降级为普通请求重试。`);
    } else {
      logger.warn(`[${label}] Playwright 渲染失败或遇到验证码，降级为普通请求重试。`);
    }
  }

  // ── 普通 fetch（原有逻辑 + 内容验证增强）───────────────────────────
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

    // Content validation: page looks like a response but lacks expected keywords
    // → probably a Cloudflare HTTP-200 JS challenge that slipped past isCaptchaInterstitial
    if (expectedPattern && !expectedPattern.test(response.text)) {
      logger.warn(`[${label}] 页面内容缺少预期关键词（疑似 HTTP 200 反爬页面），尝试 Playwright 渲染...`);
      if (!preferPlaywright) {
        // Only try Playwright here if we haven't already tried it above
        const rendered = await fetchRenderedHtml(url, config, logger);
        if (rendered && expectedPattern.test(rendered)) {
          logger.info(`[${label}] Playwright 渲染成功，页面包含预期内容。`);
          return { html: rendered, usedPlaywright: true };
        }
      }
      logger.warn(`[${label}] Playwright 渲染后仍缺少预期关键词，使用原始响应继续。`);
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
