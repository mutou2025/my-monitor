const cheerio = require('cheerio');
const { fetchWithPlaywrightFallback } = require('../lib/browser');
const {
  dedupeCourses,
  extractReleaseNotes,
  normalizeStatus,
  normalizeWhitespace,
  parseDateToIso,
  stableId
} = require('../lib/parser-utils');

function parseCourses(html, url) {
  const $ = cheerio.load(html);
  const courses = [];

  $('li').each((_, element) => {
    const text = normalizeWhitespace($(element).text());
    const date = parseDateToIso(text);
    if (!date) return;

    const status = normalizeStatus(text);
    courses.push({
      id: `edmonton-${date}`,
      name: 'TCF Canada',
      date,
      status,
      rawStatus: text,
      url,
      source: 'html-list'
    });
  });

  if (courses.length === 0) {
    const bodyText = normalizeWhitespace($('body').text());
    const chineseDateMatches = bodyText.match(/20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^。；;]*/g) || [];
    for (const fragment of chineseDateMatches) {
      const date = parseDateToIso(fragment);
      if (!date) continue;
      courses.push({
        id: `edmonton-${date}`,
        name: 'TCF Canada',
        date,
        status: normalizeStatus(fragment),
        rawStatus: normalizeWhitespace(fragment),
        url,
        source: 'html-text'
      });
    }
  }

  if (courses.length === 0 && /tcf/i.test($('body').text())) {
    const text = normalizeWhitespace($('body').text()).slice(0, 300);
    courses.push({
      id: `edmonton-page-${stableId([text])}`,
      name: 'TCF Canada 页面状态',
      date: null,
      status: normalizeStatus(text),
      rawStatus: text,
      url,
      source: 'html-page'
    });
  }

  return dedupeCourses('edmonton', courses);
}

async function check({ config, fetcher, logger }) {
  const site = config.sites.edmonton;
  const { html } = await fetchWithPlaywrightFallback(site.url, { fetcher, config, logger, label: 'Edmonton' });
  const text = normalizeWhitespace(cheerio.load(html)('body').text());

  if (!/(tcf|edmonton|alliance)/i.test(text)) {
    throw new Error('[Sanity Check] 页面未包含预期关键词，可能被拦截，中止快照更新以防误报。');
  }

  return {
    siteKey: site.key,
    siteName: site.name,
    registrationUrl: site.registrationUrl,
    courses: parseCourses(html, site.registrationUrl),
    notes: extractReleaseNotes(text)
  };
}

module.exports = {
  key: 'edmonton',
  name: 'Edmonton - Alliance Francaise Edmonton',
  check
};
