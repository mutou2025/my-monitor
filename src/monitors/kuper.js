const cheerio = require('cheerio');
const {
  absoluteUrl,
  dedupeCourses,
  extractDates,
  extractReleaseNotes,
  normalizeStatus,
  normalizeWhitespace,
  stableId
} = require('../lib/parser-utils');

function isUsefulRegistrationSignal(text) {
  const value = normalizeWhitespace(text);
  if (!/(tcf|registration|register|inscription|form|date|session|seat|spot|place|available|disponible)/i.test(value)) {
    return false;
  }

  if (/(tef canada|tefaq|delf|dalf)/i.test(value) && !/tcf/i.test(value)) {
    return false;
  }

  return /(tcf canada|tcfq|tcf|register|registration|inscription|form|available|disponible|session|date)/i.test(value);
}

function statusForKuperBlock(text) {
  const value = normalizeWhitespace(text);
  const normalized = normalizeStatus(value);
  if (normalized === 'available') return 'available';

  if (/(registration must be completed online|inscription.*en ligne)/i.test(value)) {
    return /href=|forms?|register|inscription/i.test(value) ? 'available' : 'unknown';
  }

  return normalized;
}

function parseKuperPage(html, site) {
  const $ = cheerio.load(html);
  const courses = [];

  $('a[href]').each((_, element) => {
    const label = normalizeWhitespace($(element).text());
    const href = $(element).attr('href');
    const url = absoluteUrl(href, site.url);
    const blockText = normalizeWhitespace($(element).closest('p, li, section, article, div, main').text()).slice(0, 900);
    const combined = normalizeWhitespace(`${label} ${url} ${blockText}`);

    if (!isUsefulRegistrationSignal(combined)) return;
    if (!/(register|registration|inscription|form|forms\.|mcgill|kuperacademy|available|disponible|session|date)/i.test(combined)) return;

    const dates = extractDates(combined);
    const status = statusForKuperBlock(combined);
    if (status !== 'available' && dates.length === 0) return;

    courses.push({
      id: `kuper-link-${stableId([url, dates[0], combined])}`,
      name: 'TCF Canada / TCFQ - Kuper Academy',
      date: dates[0] || null,
      status,
      rawStatus: combined.slice(0, 300),
      url,
      source: 'kuper-link',
      description: `${site.campus} - ${site.address}`
    });
  });

  const bodyText = normalizeWhitespace($('body').text());
  const dateFragments = bodyText
    .split(/(?=TCF Canada|TCFQ|TCF|Registration|Inscription|Session|Date)/i)
    .filter((fragment) => isUsefulRegistrationSignal(fragment) && extractDates(fragment).length > 0);

  for (const fragment of dateFragments) {
    const dates = extractDates(fragment);
    courses.push({
      id: `kuper-text-${stableId([dates[0], fragment.slice(0, 500)])}`,
      name: 'TCF Canada / TCFQ - Kuper Academy',
      date: dates[0] || null,
      status: statusForKuperBlock(fragment),
      rawStatus: fragment.slice(0, 300),
      url: site.registrationUrl,
      source: 'kuper-text',
      description: `${site.campus} - ${site.address}`
    });
  }

  if (courses.length === 0) {
    courses.push({
      id: 'kuper-page-status',
      name: 'TCF Canada / TCFQ - Kuper Academy 页面状态',
      date: null,
      status: normalizeStatus(bodyText),
      rawStatus: bodyText.slice(0, 300),
      url: site.registrationUrl,
      source: 'kuper-page',
      description: `${site.campus} - ${site.address}`
    });
  }

  return dedupeCourses(site.key, courses);
}

async function check({ config, fetcher }) {
  const site = config.sites.kuper;
  const html = await fetcher.fetchText(site.url, { timeoutMs: config.requestTimeoutMs });
  const text = normalizeWhitespace(cheerio.load(html)('body').text());

  if (!/(tcf|kuper)/i.test(text)) {
    throw new Error('[Sanity Check] 页面未包含预期关键词，可能被拦截，中止快照更新以防误报。');
  }

  return {
    siteKey: site.key,
    siteName: site.name,
    registrationUrl: site.registrationUrl,
    courses: parseKuperPage(html, site),
    notes: extractReleaseNotes(text)
  };
}

module.exports = {
  key: 'kuper',
  name: 'Montreal - Kuper Academy Kirkland',
  check
};
