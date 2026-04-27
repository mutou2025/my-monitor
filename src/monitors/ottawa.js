const {
  dedupeCourses,
  extractReleaseNotes,
  normalizeStatus,
  normalizeWhitespace,
  stableId,
  stripHtml
} = require('../lib/parser-utils');

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}

function hasRegisterLink(examination) {
  return Boolean(examination.mainRegisterLink && examination.mainRegisterLink.link);
}

function statusFromExamination(examination) {
  const label = normalizeWhitespace(examination.mainRegisterLink && examination.mainRegisterLink.label);
  const text = normalizeWhitespace(`${label} ${examination.description || ''}`);
  const used = Number.parseInt(examination.qty_student, 10);
  const capacity = Number.parseInt(examination.max_student, 10);

  if (examination.inscriptionIsInFuture) return 'closed';
  if (examination.isFull === true) return 'full';
  if (!Number.isNaN(used) && !Number.isNaN(capacity) && capacity > 0 && used >= capacity) return 'full';
  if (hasRegisterLink(examination) && /add_to_cart|add to cart|register|inscription/i.test(label)) return 'available';
  if (/not_available|not available|indisponible/i.test(label)) return 'full';
  return normalizeStatus(text);
}

function rawStatusFromExamination(examination, status) {
  const parts = [
    examination.mainRegisterLink && examination.mainRegisterLink.label,
    examination.examination_date_registration_formatted,
    examination.qty_student !== undefined && examination.max_student !== undefined
      ? `${examination.qty_student}/${examination.max_student} inscrits`
      : '',
    status
  ];
  return normalizeWhitespace(parts.filter(Boolean).join(' | '));
}

function examinationToCourse(examinationType, examination, site) {
  const status = statusFromExamination(examination);
  const url = examination.mainRegisterLink && examination.mainRegisterLink.link
    ? examination.mainRegisterLink.link
    : site.registrationUrl;
  const date = examination.examination_date || null;
  const name = normalizeWhitespace(examination.product_name || examinationType.name || 'TCF Canada');

  return {
    id: `ottawa-${examination.IDEXAMINATION || stableId([name, date, url])}`,
    name,
    date,
    status,
    rawStatus: rawStatusFromExamination(examination, status),
    url,
    source: 'aec-examinations-api',
    description: normalizeWhitespace(stripHtml(examination.description || examinationType.description || '')).slice(0, 500)
  };
}

function parseCourses(apiBody, site) {
  const targetDates = new Set(site.targetDates || []);
  const excludedDates = new Set(site.excludedDates || []);
  const courses = [];
  const ignored = [];

  for (const examinationType of arrayFrom(apiBody)) {
    if (!/tcf\s+canada/i.test(examinationType.name || '')) continue;

    for (const examination of arrayFrom(examinationType.examinations)) {
      const date = examination.examination_date;
      if (excludedDates.has(date)) {
        ignored.push(date);
        continue;
      }
      if (targetDates.size > 0 && !targetDates.has(date)) continue;

      courses.push(examinationToCourse(examinationType, examination, site));
    }
  }

  return {
    courses: dedupeCourses(site.key, courses),
    ignoredDates: [...new Set(ignored)].sort()
  };
}

async function check({ config, fetcher }) {
  const site = config.sites.ottawa;
  const response = await fetcher.request(site.apiUrl, {
    responseType: 'json',
    timeoutMs: config.requestTimeoutMs,
    headers: {
      API_KEY: site.apiKey,
      CURRENT_LANG: 'fr_FR',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: site.url
    }
  });

  if (!Array.isArray(response.body)) {
    throw new Error('[Sanity Check] Ottawa AEC API 未返回考试列表数组，中止快照更新。');
  }

  const { courses, ignoredDates } = parseCourses(response.body, site);
  if (courses.length === 0) {
    throw new Error(`[Sanity Check] Ottawa 未找到目标日期：${(site.targetDates || []).join(', ')}`);
  }

  const notes = extractReleaseNotes(JSON.stringify(response.body));
  if (ignoredDates.length > 0) notes.push(`已排除 Ottawa 日期：${ignoredDates.join(', ')}`);

  return {
    siteKey: site.key,
    siteName: site.name,
    registrationUrl: site.registrationUrl,
    courses,
    notes
  };
}

module.exports = {
  key: 'ottawa',
  name: 'Ottawa - Alliance Francaise Ottawa',
  check
};
