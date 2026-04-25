const cheerio = require('cheerio');
const { fetchWithPlaywrightFallback } = require('../lib/browser');
const {
  absoluteUrl,
  dedupeCourses,
  extractDates,
  extractReleaseNotes,
  normalizeStatus,
  normalizeWhitespace,
  stableId
} = require('../lib/parser-utils');

function parseCourses(html, url) {
  const $ = cheerio.load(html);
  const bodyText = normalizeWhitespace($('body').text());
  const courses = [];
  const pageStatus = normalizeStatus(bodyText);

  if (/fully booked|all exam dates are fully booked/i.test(bodyText)) {
    courses.push({
      id: 'manitoba-all-dates',
      name: 'TCF Canada exam dates',
      date: null,
      status: 'full',
      rawStatus: 'All exam dates are fully booked',
      url,
      source: 'html-page'
    });
  }

  $('a, button').each((_, element) => {
    const label = normalizeWhitespace($(element).text());
    const href = $(element).attr('href');
    const candidateUrl = absoluteUrl(href, url);
    if (!/(registration|register|add to cart|ajouter|inscription|报名)/i.test(label)) return;

    const surroundingText = normalizeWhitespace($(element).closest('section, article, div, main').text()).slice(0, 700);
    const status = normalizeStatus(`${surroundingText} ${label}`);
    if (status !== 'available') return;

    const dates = extractDates(surroundingText);
    courses.push({
      id: `manitoba-${stableId([candidateUrl, surroundingText])}`,
      name: 'TCF Canada',
      date: dates[0] || null,
      status,
      rawStatus: label,
      url: candidateUrl,
      source: 'html-button'
    });
  });

  if (courses.length === 0 && /tcf/i.test(bodyText)) {
    courses.push({
      id: `manitoba-page-${stableId([bodyText.slice(0, 300)])}`,
      name: 'TCF Canada 页面状态',
      date: null,
      status: pageStatus,
      rawStatus: bodyText.slice(0, 300),
      url,
      source: 'html-page'
    });
  }

  return dedupeCourses('manitoba', courses);
}

async function check({ config, fetcher, logger }) {
  const site = config.sites.manitoba;
  const { html } = await fetchWithPlaywrightFallback(site.url, { fetcher, config, logger, label: 'Manitoba' });
  const text = normalizeWhitespace(cheerio.load(html)('body').text());

  if (!/(tcf|manitoba|alliance)/i.test(text)) {
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
  key: 'manitoba',
  name: 'Manitoba - Alliance Francaise du Manitoba',
  check
};
