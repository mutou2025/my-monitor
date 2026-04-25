const cheerio = require('cheerio');
const { fetchWithPlaywrightFallback } = require('../lib/browser');
const {
  absoluteUrl,
  dedupeCourses,
  extractDates,
  extractReleaseNotes,
  normalizeStatus,
  normalizeWhitespace,
  stableId,
  stripHtml
} = require('../lib/parser-utils');

function valueFromKeys(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return null;
}

function statusFromApiObject(object, text) {
  const numericKeys = ['availableSpots', 'openings', 'spotsAvailable', 'remaining', 'vacancy', 'vacancies', 'available'];
  for (const key of numericKeys) {
    const value = Number.parseInt(object[key], 10);
    if (!Number.isNaN(value)) return value > 0 ? 'available' : 'full';
  }

  if (object.isFull === true || object.full === true) return 'full';
  if (object.isAvailable === true || object.canRegister === true || object.isOpen === true) return 'available';
  if (object.isAvailable === false || object.canRegister === false) return 'full';
  return normalizeStatus(text);
}

function collectApiCourses(value, output, registrationUrl) {
  if (Array.isArray(value)) {
    for (const item of value) collectApiCourses(item, output, registrationUrl);
    return;
  }

  if (!value || typeof value !== 'object') return;

  const text = normalizeWhitespace(JSON.stringify(value));
  const name = stripHtml(valueFromKeys(value, [
    'name',
    'title',
    'activityName',
    'activity_name',
    'programName',
    'program_name',
    'displayName',
    'description'
  ]));
  const looksLikeTcf = /tcf/i.test(`${name} ${text}`);
  const hasCourseShape = Boolean(name) || /activity|course|program/i.test(Object.keys(value).join(' '));

  if (looksLikeTcf && hasCourseShape) {
    const id = String(valueFromKeys(value, [
      'id',
      'activityId',
      'activity_id',
      'activityNumber',
      'activity_no',
      'programId',
      'program_id',
      'code'
    ]) || `toronto-api-${stableId([name, text.slice(0, 500)])}`);
    const dateText = normalizeWhitespace(String(valueFromKeys(value, [
      'date',
      'startDate',
      'start_date',
      'beginDate',
      'eventDate',
      'firstMeetingDate',
      'startTime'
    ]) || text));
    const dates = extractDates(dateText);
    const status = statusFromApiObject(value, text);
    output.push({
      id: `toronto-${id}`,
      name: name || 'TCF Canada',
      date: dates[0] || null,
      status,
      rawStatus: normalizeWhitespace(String(valueFromKeys(value, [
        'status',
        'availabilityStatus',
        'enrollmentStatus',
        'registrationStatus'
      ]) || status)),
      url: registrationUrl,
      source: 'active-network-api',
      description: stripHtml(value.description || value.shortDescription || '')
    });
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectApiCourses(child, output, registrationUrl);
  }
}

async function fetchActiveApiCourses(site, fetcher, config, logger) {
  if (!site.activeApiUrl) return [];

  const body = site.activeApiBody || undefined;
  let response;
  try {
    response = await fetcher.request(site.activeApiUrl, {
      method: site.activeApiMethod,
      headers: site.activeApiHeaders,
      body,
      responseType: 'json',
      timeoutMs: config.requestTimeoutMs,
      throwOnHttpError: false,
      throwOnJsonError: false
    });
  } catch (error) {
    logger.warn(`[Toronto] Active API 请求失败，继续解析官方页面：${error.message}`);
    return [];
  }

  if (!response.ok) {
    logger.warn(`[Toronto] Active API HTTP ${response.status}，继续解析官方页面。`);
    return [];
  }

  if (!response.body) {
    logger.warn('[Toronto] Active API 返回的不是 JSON，继续解析官方页面。');
    return [];
  }

  const courses = [];
  collectApiCourses(response.body, courses, site.registrationUrl);
  return courses;
}

function parseOfficialPage(html, site) {
  const $ = cheerio.load(html);
  const courses = [];

  $('a, button').each((_, element) => {
    const label = normalizeWhitespace($(element).text());
    const href = $(element).attr('href');
    const candidateUrl = absoluteUrl(href, site.url);
    const surroundingText = normalizeWhitespace($(element).closest('section, article, div, main').text()).slice(0, 900);
    const combined = `${label} ${href || ''} ${surroundingText}`;
    if (!/tcf/i.test(combined)) return;
    if (!/(spadina|24\s+spadina|downtown toronto)/i.test(combined) && /north york|mississauga|markham|oakville/i.test(combined)) return;
    if (!/(register|registration|session|date|time|activecommunities|book|cart|inscription)/i.test(combined)) return;

    const status = normalizeStatus(combined);
    if (status !== 'available') return;

    const dates = extractDates(combined);
    courses.push({
      id: `toronto-page-${stableId([candidateUrl, combined])}`,
      name: 'TCF Canada',
      date: dates[0] || null,
      status,
      rawStatus: label || 'Registration link found',
      url: candidateUrl,
      source: 'official-page'
    });
  });

  const bodyText = normalizeWhitespace($('body').text());
  if (courses.length === 0 && /tcf/i.test(bodyText)) {
    courses.push({
      id: `toronto-page-status-${stableId([bodyText.slice(0, 300)])}`,
      name: 'TCF Canada - Spadina Campus 页面状态',
      date: null,
      status: normalizeStatus(bodyText),
      rawStatus: bodyText.slice(0, 300),
      url: site.url,
      source: 'official-page',
      description: `${site.campus} - ${site.address}`
    });
  }

  return courses;
}

async function check({ config, fetcher, logger }) {
  const site = config.sites.toronto;
  const apiCourses = await fetchActiveApiCourses(site, fetcher, config, logger);
  const { html } = await fetchWithPlaywrightFallback(site.url, { fetcher, config, logger, label: 'Toronto' });

  const pageCourses = parseOfficialPage(html, site);
  const text = normalizeWhitespace(cheerio.load(html)('body').text());

  if (apiCourses.length === 0 && pageCourses.length === 0 && !/(tcf|toronto|alliance)/i.test(text)) {
    throw new Error('[Sanity Check] 页面未包含预期关键词，可能被拦截，中止快照更新以防误报。');
  }

  return {
    siteKey: site.key,
    siteName: site.name,
    registrationUrl: site.url,
    courses: dedupeCourses(site.key, apiCourses.concat(pageCourses)),
    notes: extractReleaseNotes(text)
  };
}

module.exports = {
  key: 'toronto',
  name: 'Toronto - Spadina Campus',
  check
};
