const crypto = require('crypto');
const cheerio = require('cheerio');

const MONTHS = {
  january: 1,
  jan: 1,
  janvier: 1,
  february: 2,
  feb: 2,
  fevrier: 2,
  février: 2,
  march: 3,
  mar: 3,
  mars: 3,
  april: 4,
  apr: 4,
  avril: 4,
  may: 5,
  mai: 5,
  june: 6,
  jun: 6,
  juin: 6,
  july: 7,
  jul: 7,
  juillet: 7,
  august: 8,
  aug: 8,
  aout: 8,
  août: 8,
  september: 9,
  sep: 9,
  sept: 9,
  septembre: 9,
  october: 10,
  oct: 10,
  octobre: 10,
  november: 11,
  nov: 11,
  novembre: 11,
  december: 12,
  dec: 12,
  decembre: 12,
  décembre: 12
};

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  if (!value) return '';
  return normalizeWhitespace(cheerio.load(`<body>${value}</body>`).text());
}

function stableId(parts) {
  const normalized = parts.filter(Boolean).map((part) => normalizeWhitespace(part)).join('|');
  return crypto.createHash('sha1').update(normalized || 'empty').digest('hex').slice(0, 16);
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function toIsoDate(year, month, day) {
  const y = Number.parseInt(year, 10);
  const m = Number.parseInt(month, 10);
  const d = Number.parseInt(day, 10);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parseDateToIso(text) {
  const value = normalizeWhitespace(text);
  if (!value) return null;

  let match = value.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (match) return toIsoDate(match[1], match[2], match[3]);

  match = value.match(/\b(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\b/);
  if (match) return toIsoDate(match[1], match[2], match[3]);

  match = value.match(/\b([A-Za-zÀ-ÿ]+)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (match) {
    const month = MONTHS[match[1].toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')] || MONTHS[match[1].toLowerCase()];
    if (month) return toIsoDate(match[3], month, match[2]);
  }

  match = value.match(/\b(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(20\d{2})\b/i);
  if (match) {
    const month = MONTHS[match[2].toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')] || MONTHS[match[2].toLowerCase()];
    if (month) return toIsoDate(match[3], month, match[1]);
  }

  return null;
}

function extractDates(text) {
  const value = normalizeWhitespace(text);
  const dates = new Set();
  const patterns = [
    /\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
    /\b20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?\b/g,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+\d{1,2},?\s+20\d{2}\b/gi,
    /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+20\d{2}\b/gi
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const parsed = parseDateToIso(match[0]);
      if (parsed) dates.add(parsed);
    }
  }

  return [...dates].sort();
}

function normalizeStatus(text) {
  const value = normalizeWhitespace(stripHtml(text)).toLowerCase();
  if (!value) return 'unknown';

  if (/(fully booked|sold\s*out|out\s+of\s+stock|no\s+dates?\s+available|no\s+places?\s+available|no\s+seats?\s+available|waitlist|closed|unavailable|已售罄|售罄|已满|满员|complet|complete|complète|complets|completement|complètement)/i.test(value)) {
    return 'full';
  }

  if (/(will\s+be\s+available|opens?\s+on|opening\s+on|registration\s+will\s+open|inscriptions?\s+ouvrir|new\s+dates?\s+will|not\s+yet\s+open|coming\s+soon|sera\s+disponible)/i.test(value)) {
    return 'closed';
  }

  if (/(add\s+to\s+cart|ajouter\s+au\s+panier|添加到购物车|register\s+now|registration\s+open|open\s+for\s+registration|available|in\s+stock|places?\s+available|seats?\s+available|book\s+now|buy\s+now|inscription\s+ouverte|disponible)/i.test(value)) {
    return 'available';
  }

  return 'unknown';
}

function isAvailableStatus(status) {
  return status === 'available';
}

function courseFingerprint(siteKey, course) {
  return stableId([
    siteKey,
    course.id,
    course.name,
    course.date,
    course.url || course.registrationUrl
  ]);
}

function cleanCourse(siteKey, course) {
  const name = normalizeWhitespace(course.name || 'TCF Canada');
  const date = course.date || parseDateToIso(`${course.name || ''} ${course.rawStatus || ''} ${course.description || ''}`);
  const status = course.status || normalizeStatus(`${course.rawStatus || ''} ${course.name || ''} ${course.description || ''}`);
  const url = course.url || course.registrationUrl || '';
  const id = normalizeWhitespace(course.id || `${siteKey}-${stableId([name, date, url, course.rawStatus])}`);

  return {
    id,
    name,
    date: date || null,
    status,
    rawStatus: normalizeWhitespace(course.rawStatus || status),
    url,
    source: course.source || 'page',
    description: normalizeWhitespace(course.description || '')
  };
}

function dedupeCourses(siteKey, courses) {
  const seen = new Map();
  for (const course of courses) {
    const clean = cleanCourse(siteKey, course);
    const key = clean.id || stableId([clean.name, clean.date, clean.url]);
    const existing = seen.get(key);
    if (!existing || (existing.status !== 'available' && clean.status === 'available')) {
      seen.set(key, clean);
    }
  }
  return [...seen.values()].sort((a, b) => `${a.date || ''}${a.name}`.localeCompare(`${b.date || ''}${b.name}`));
}

function extractReleaseNotes(text) {
  const value = normalizeWhitespace(text);
  const notes = [];
  const patterns = [
    /new dates? will be available[^.。]*[.。]?/gi,
    /registration (?:will )?(?:open|opens)[^.。]*[.。]?/gi,
    /注册将于[^。]*。?/g,
    /开放[^。]*。?/g
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      notes.push(normalizeWhitespace(match[0]));
    }
  }
  return [...new Set(notes)].slice(0, 5);
}

function absoluteUrl(href, baseUrl) {
  if (!href) return baseUrl;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

module.exports = {
  absoluteUrl,
  cleanCourse,
  courseFingerprint,
  dedupeCourses,
  extractDates,
  extractReleaseNotes,
  isAvailableStatus,
  normalizeStatus,
  normalizeWhitespace,
  parseDateToIso,
  stableId,
  stripHtml
};
