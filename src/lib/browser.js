const fs = require('fs');
const path = require('path');
const { randomUserAgent, USER_AGENTS } = require('./fetcher');

/** Maximum time (ms) to wait inside a Queue-Fair virtual waiting room. */
const QUEUE_FAIR_WAIT_MS = 90_000;
/** Polling interval (ms) while waiting in the Queue-Fair queue. */
const QUEUE_FAIR_POLL_MS = 2_000;

function isQueueFairPage(html) {
  const body = String(html || '');
  return /queue-fair/i.test(body) && /waiting\s*room|queue|your\s*(estimated\s*)?wait/i.test(body);
}

function stableUserAgent(label, url) {
  const key = `${label}:${url}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return USER_AGENTS[hash % USER_AGENTS.length] || randomUserAgent();
}

function safePathSegment(value) {
  return String(value || 'playwright')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'playwright';
}

function profileDirForUrl(url, config, label) {
  let host = 'site';
  try {
    host = new URL(url).hostname;
  } catch (_) {
    host = safePathSegment(url);
  }
  const root = config.playwrightProfileDir
    || path.join(config.projectRoot || process.cwd(), 'data', 'playwright-profiles');
  return path.join(root, `${safePathSegment(label)}-${safePathSegment(host)}`);
}

async function newPageSession(chromium, url, config, logger, label) {
  const pageOptions = {
    userAgent: config.playwrightPersistSession ? stableUserAgent(label, url) : randomUserAgent(),
    locale: 'fr-CA',
    viewport: { width: 1440, height: 1100 }
  };

  if (config.playwrightPersistSession) {
    const userDataDir = profileDirForUrl(url, config, label);
    fs.mkdirSync(userDataDir, { recursive: true });
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        ...pageOptions
      });
      const page = context.pages()[0] || await context.newPage();
      logger.debug(`[${label}] 使用持久化 Playwright 会话：${userDataDir}`);
      return {
        page,
        close: () => context.close().catch(() => {})
      };
    } catch (error) {
      logger.warn(`[${label}] 持久化 Playwright 会话启动失败，改用临时会话：${error.message}`);
    }
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(pageOptions);
  return {
    page,
    close: () => browser.close().catch(() => {})
  };
}

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
    // Queue-Fair virtual waiting room (HTTP 202 or JS-based redirect)
    || isQueueFairPage(body)
    // Very short body with meta-refresh (generic interstitial)
    || (body.length < 4000 && /http-equiv=["']refresh["']/i.test(body) && !/tcf|alliance|exam/i.test(body))
  );
}

/**
 * Wait for a Queue-Fair virtual waiting room to redirect to the real page.
 * Queue-Fair uses JS polling to check queue position and redirects the browser
 * once the visitor reaches the front (typically 10–60 seconds).
 * Returns the final page HTML, or null if the queue never resolved.
 */
async function waitForQueueFair(page, logger, label) {
  const deadline = Date.now() + QUEUE_FAIR_WAIT_MS;
  logger.info(`[${label}] Queue-Fair 排队页面已检测到，等待排队完成（最多 ${QUEUE_FAIR_WAIT_MS / 1000} 秒）...`);

  while (Date.now() < deadline) {
    await page.waitForTimeout(QUEUE_FAIR_POLL_MS);
    const html = await page.content();
    if (!isQueueFairPage(html)) {
      logger.info(`[${label}] Queue-Fair 排队完成，已加载真实页面。`);
      // Give the real page a moment to fully render
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      return await page.content();
    }
    const remaining = Math.round((deadline - Date.now()) / 1000);
    logger.debug(`[${label}] 仍在 Queue-Fair 排队中，剩余等待 ${remaining} 秒...`);
  }

  logger.warn(`[${label}] Queue-Fair 排队超时（${QUEUE_FAIR_WAIT_MS / 1000} 秒），未能通过排队。`);
  return null;
}

/**
 * Fetch HTML via Playwright (headless Chromium).
 * Falls back gracefully if Playwright is not installed.
 * Automatically detects and waits through Queue-Fair virtual waiting rooms.
 */
async function fetchRenderedHtml(url, config, logger, label = 'Playwright') {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (error) {
    logger.warn(`Playwright 未安装，跳过动态页面渲染：${error.message}`);
    return null;
  }

  let session;
  try {
    session = await newPageSession(chromium, url, config, logger, label);
    const { page } = session;
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.playwrightTimeoutMs
    });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);

    let html = await page.content();

    // Detect Queue-Fair and wait through the queue
    if (isQueueFairPage(html)) {
      const resolved = await waitForQueueFair(page, logger, label);
      if (resolved) {
        html = resolved;
      }
      // If waitForQueueFair returned null, html still contains the queue page
      // and the caller's isCaptchaInterstitial / expectedPattern checks will catch it
    }

    return html;
  } catch (error) {
    logger.warn(`Playwright 渲染失败：${url} - ${error.message}`);
    return null;
  } finally {
    if (session) {
      await session.close();
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
  // ── preferPlaywright: 只用 Playwright，不走 fetch（服务器 IP 上 fetch 过不了 Cloudflare）
  if (preferPlaywright) {
    logger.debug(`[${label}] preferPlaywright 已启用，直接使用 Playwright 渲染。`);
    const rendered = await fetchRenderedHtml(url, config, logger, label);
    if (!rendered) {
      throw new Error(`[${label}] Playwright 渲染失败，无法获取页面。`);
    }
    if (isCaptchaInterstitial(200, rendered)) {
      throw new Error(`[${label}] Playwright 渲染后仍为验证码/反爬页面，无法获取真实内容。`);
    }
    if (expectedPattern && !expectedPattern.test(rendered)) {
      throw new Error(`[${label}] Playwright 渲染成功但页面缺少预期关键词，疑似内容异常。`);
    }
    logger.info(`[${label}] Playwright 渲染成功，继续解析。`);
    return { html: rendered, usedPlaywright: true };
  }

  // ── 普通 fetch（原有逻辑 + 内容验证增强）───────────────────────────
  try {
    const response = await fetcher.request(url, {
      timeoutMs: config.requestTimeoutMs,
      responseType: 'text'
    });

    if (isCaptchaInterstitial(response.status, response.text)) {
      logger.warn(`[${label}] 检测到验证码/反爬中间页 (HTTP ${response.status})，尝试 Playwright 渲染...`);
      const rendered = await fetchRenderedHtml(url, config, logger, label);
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
        const rendered = await fetchRenderedHtml(url, config, logger, label);
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
      const rendered = await fetchRenderedHtml(url, config, logger, label);
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
