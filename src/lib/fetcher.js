const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

class HttpError extends Error {
  constructor(message, status, url, body = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelayMs(baseSeconds, jitterSeconds) {
  const jitterRange = jitterSeconds * 2;
  const randomOffset = jitterRange === 0 ? 0 : Math.floor(Math.random() * (jitterRange + 1)) - jitterSeconds;
  const seconds = Math.max(10, baseSeconds + randomOffset);
  return seconds * 1000;
}

function headersToObject(headers) {
  const result = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function request(url, options = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node.js 版本没有内置 fetch，请安装 Node.js 18.17 或更高版本。');
  }

  const timeoutMs = options.timeoutMs || 15000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const method = options.method || 'GET';
  const ua = randomUserAgent();
  // Extract Chrome version from UA for sec-ch-ua header
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const chromeMajor = chromeMatch ? chromeMatch[1] : '125';
  const headers = {
    'User-Agent': ua,
    'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7',
    Accept: options.responseType === 'json'
      ? 'application/json,text/plain,*/*'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    // Cloudflare checks these sec-ch-ua / sec-fetch-* headers to fingerprint bots
    'sec-ch-ua': `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not-A.Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': options.responseType === 'json' ? 'empty' : 'document',
    'Sec-Fetch-Mode': options.responseType === 'json' ? 'cors' : 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...options.headers
  };

  let body = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: options.redirect || 'follow',
      signal: controller.signal
    });

    const text = await response.text();
    const result = {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: headersToObject(response.headers),
      text
    };

    if (!response.ok && options.throwOnHttpError !== false) {
      throw new HttpError(`请求失败：HTTP ${response.status}`, response.status, response.url, text.slice(0, 500));
    }

    if (options.responseType === 'json') {
      try {
        result.body = text ? JSON.parse(text) : null;
      } catch (error) {
        if (options.throwOnJsonError === false) {
          result.body = null;
          result.jsonError = error;
        } else {
          throw new Error(`JSON 解析失败：${url} - ${error.message}`);
        }
      }
    } else {
      result.body = text;
    }

    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`请求超时：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options = {}) {
  const response = await request(url, { ...options, responseType: 'text' });
  return response.body;
}

async function fetchJson(url, options = {}) {
  const response = await request(url, { ...options, responseType: 'json' });
  return response.body;
}

function isRateLimitOrServerError(error) {
  if (error instanceof HttpError) {
    // 403 = Cloudflare/WAF block (common on datacenter IPs), treat as retriable
    return error.status === 403 || error.status === 429 || error.status >= 500;
  }
  return /timeout|network|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(error.message || '');
}

module.exports = {
  HttpError,
  USER_AGENTS,
  fetchJson,
  fetchText,
  isRateLimitOrServerError,
  jitteredDelayMs,
  randomUserAgent,
  request,
  sleep
};
