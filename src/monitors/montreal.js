const cheerio = require('cheerio');
const { fetchRenderedHtml } = require('../lib/browser');
const {
  absoluteUrl,
  dedupeCourses,
  extractDates,
  extractReleaseNotes,
  isAvailableStatus,
  normalizeStatus,
  normalizeWhitespace,
  stableId,
  stripHtml
} = require('../lib/parser-utils');

function isTcfCanadaText(text) {
  const value = normalizeWhitespace(text).toLowerCase();
  return /\btcf\s*(canada|can)\b|tcf\s*加拿大/i.test(value);
}

function hasCommerceSignal(text) {
  return /(add\s+to\s+cart|ajouter\s+au\s+panier|添加到购物车|out\s+of\s+stock|sold\s+out|已售罄|缺货|选择其他日期|select\s+other\s+date|\$\s*\d|单价\s*\d|price\s*:?\s*\d)/i.test(text);
}

function isActionElementText(text) {
  return /(add\s+to\s+cart|ajouter\s+au\s+panier|添加到购物车|out\s+of\s+stock|sold\s+out|已售罄|缺货)/i.test(text);
}

function closestCourseBlock($, element) {
  let current = $(element);
  for (let depth = 0; depth < 10 && current.length > 0; depth += 1) {
    const text = normalizeWhitespace(current.text());
    const hasDate = extractDates(text).length > 0;
    if (text.length >= 40 && text.length <= 1200 && hasDate && isTcfCanadaText(text) && hasCommerceSignal(text)) {
      return {
        text,
        href: current.find('a[href*="addExamination"]').last().attr('href') || current.find('a[href]').last().attr('href')
      };
    }
    current = current.parent();
  }
  return null;
}

function productToCourse(product, siteUrl) {
  const name = stripHtml(product.name || product.title || '');
  const description = stripHtml(`${product.short_description || ''} ${product.description || ''}`);
  const permalink = product.permalink || product.url || siteUrl;
  const addToCartText = stripHtml(product.add_to_cart && product.add_to_cart.text);
  const stockText = stripHtml(
    `${product.stock_status || ''} ${product.stock_availability && product.stock_availability.text ? product.stock_availability.text : ''}`
  );
  const combined = normalizeWhitespace(`${name} ${description} ${addToCartText} ${stockText}`);
  if (!isTcfCanadaText(combined)) return null;

  let status = normalizeStatus(combined);
  if (status === 'unknown' && product.is_in_stock === true) status = 'available';
  if (status === 'unknown' && /add|cart|panier|购物车/i.test(addToCartText)) status = 'available';
  if (product.is_in_stock === false) status = 'full';

  const dates = extractDates(combined);
  const price = product.prices && product.prices.price ? `Price: ${product.prices.price}` : '';

  return {
    id: `montreal-product-${product.id || stableId([name, dates[0], permalink])}`,
    name: name || 'TCF Canada',
    date: dates[0] || null,
    status,
    rawStatus: normalizeWhitespace(`${addToCartText || stockText || status} ${price}`),
    description,
    url: permalink,
    source: 'woocommerce-store-api'
  };
}

async function fetchStoreProducts(siteUrl, fetcher, config, logger) {
  const origin = new URL(siteUrl).origin;
  const endpoints = [
    `${origin}/wp-json/wc/store/v1/products?search=TCF%20CAN`,
    `${origin}/wp-json/wc/store/v1/products?search=TCF%20Canada`,
    `${origin}/wp-json/wc/store/v1/products?search=TCF`
  ];
  const courses = [];

  for (const endpoint of endpoints) {
    const response = await fetcher.request(endpoint, {
      responseType: 'json',
      timeoutMs: config.requestTimeoutMs,
      throwOnHttpError: false,
      throwOnJsonError: false
    });
    if (!response.ok || !Array.isArray(response.body)) {
      logger.debug(`[Montreal] WooCommerce Store API 无可用响应：${endpoint} HTTP ${response.status}`);
      continue;
    }
    for (const product of response.body) {
      const course = productToCourse(product, siteUrl);
      if (course) courses.push(course);
    }
    if (courses.length > 0) break;
  }

  return courses;
}

function parseRenderedCourses(html, siteUrl) {
  const $ = cheerio.load(html);
  const courses = [];

  $('a, button').each((_, element) => {
    const actionText = normalizeWhitespace($(element).text());
    if (!isActionElementText(actionText)) return;

    const block = closestCourseBlock($, element);
    if (!block) return;

    const text = block.text;
    const status = normalizeStatus(`${text} ${actionText}`);
    if (status === 'unknown') return;
    const dates = extractDates(text);
    courses.push({
      id: `montreal-rendered-${stableId([block.href, dates[0], text])}`,
      name: 'TCF CAN (Canada)',
      date: dates[0] || null,
      status,
      rawStatus: text.slice(0, 300),
      url: absoluteUrl(block.href, siteUrl),
      source: 'rendered-html'
    });
  });

  if (courses.length === 0) {
    const bodyText = normalizeWhitespace($('body').text());
    const blocks = bodyText.split(/(?=TCF\s+CAN|TCF Canada|TCF加拿大)/i);
    for (const block of blocks) {
      if (!isTcfCanadaText(block)) continue;
      if (!hasCommerceSignal(block)) continue;
      if (block.length > 1200) continue;
      const status = normalizeStatus(block);
      if (status === 'unknown') continue;
      const dates = extractDates(block);
      courses.push({
        id: `montreal-text-${stableId([block.slice(0, 500)])}`,
        name: 'TCF CAN (Canada)',
        date: dates[0] || null,
        status,
        rawStatus: block.slice(0, 300),
        url: siteUrl,
        source: 'rendered-text'
      });
    }
  }

  return courses;
}

function shouldUsePlaywright(config, currentCourses) {
  if (config.playwrightMode === 'always') return true;
  if (config.playwrightMode === 'never') return false;
  return !currentCourses.some((course) => isAvailableStatus(course.status));
}

async function check({ config, fetcher, logger }) {
  const site = config.sites.montreal;
  let courses = await fetchStoreProducts(site.url, fetcher, config, logger);
  let html = '';

  if (!courses.some((course) => isAvailableStatus(course.status))) {
    html = await fetcher.fetchText(site.url, { timeoutMs: config.requestTimeoutMs });
    courses = courses.concat(parseRenderedCourses(html, site.registrationUrl));
  }

  if (shouldUsePlaywright(config, courses)) {
    const renderedHtml = await fetchRenderedHtml(site.url, config, logger);
    if (renderedHtml) {
      courses = courses.concat(parseRenderedCourses(renderedHtml, site.registrationUrl));
      html = renderedHtml;
    }
  }

  const text = html ? normalizeWhitespace(cheerio.load(html)('body').text()) : '';

  if (courses.length === 0 && html && !/(tcf|montreal|alliance)/i.test(text)) {
    throw new Error('[Sanity Check] 页面未包含预期关键词，可能被拦截，中止快照更新以防误报。');
  }

  return {
    siteKey: site.key,
    siteName: site.name,
    registrationUrl: site.registrationUrl,
    courses: dedupeCourses(site.key, courses),
    notes: extractReleaseNotes(text)
  };
}

module.exports = {
  key: 'montreal',
  name: 'Montreal - Alliance Francaise de Montreal',
  check
};
