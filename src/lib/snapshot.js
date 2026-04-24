const fs = require('fs');
const path = require('path');
const { courseFingerprint, dedupeCourses, isAvailableStatus } = require('./parser-utils');

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempFile, file);
}

function siteSnapshotFile(config, siteKey) {
  return path.join(config.dataDir, `snapshot-${siteKey}.json`);
}

function indexCourses(courses) {
  const map = new Map();
  for (const course of courses || []) {
    map.set(course.id, course);
  }
  return map;
}

function hasBecomeAvailable(previousStatus, currentStatus) {
  return !isAvailableStatus(previousStatus) && isAvailableStatus(currentStatus);
}

function courseChange(type, siteKey, siteName, course, registrationUrl, extra = {}) {
  return {
    type,
    siteKey,
    siteName,
    ...extra,
    course,
    registrationUrl,
    detectedAt: new Date().toISOString(),
    fingerprint: courseFingerprint(siteKey, course)
  };
}

function compareCourses(siteKey, siteName, oldCourses, newCourses, registrationUrl) {
  const oldIndex = indexCourses(oldCourses);
  const changes = [];

  for (const course of newCourses) {
    const previous = oldIndex.get(course.id);
    if (!previous) {
      if (isAvailableStatus(course.status)) {
        changes.push(courseChange('new_available_course', siteKey, siteName, course, registrationUrl));
      }
      continue;
    }

    if (hasBecomeAvailable(previous.status, course.status)) {
      changes.push(courseChange('became_available', siteKey, siteName, course, registrationUrl, {
        previousStatus: previous.status
      }));
    }
  }

  return changes;
}

function firstRunChanges(config, siteKey, siteName, courses, registrationUrl) {
  if (!config.notifyOnFirstRun) return [];
  return courses
    .filter((course) => isAvailableStatus(course.status))
    .map((course) => courseChange('first_run_available_course', siteKey, siteName, course, registrationUrl));
}

function updateSiteSnapshot(config, siteKey, siteName, courses, registrationUrl) {
  const file = siteSnapshotFile(config, siteKey);
  const previous = readJson(file, null);
  const cleanCourses = dedupeCourses(siteKey, courses);
  const isFirstRun = !previous;

  if (previous && Array.isArray(previous.courses) && previous.courses.length > 0 && cleanCourses.length === 0) {
    throw new Error(
      `[${siteName}] 本次解析结果为空，但上次快照有 ${previous.courses.length} 条课程；为避免覆盖有效基线，已跳过快照更新。`
    );
  }

  // First run: only establish baseline, do not trigger notifications
  const changes = isFirstRun
    ? firstRunChanges(config, siteKey, siteName, cleanCourses, registrationUrl)
    : compareCourses(
        siteKey,
        siteName,
        previous.courses,
        cleanCourses,
        registrationUrl
      );

  writeJson(file, {
    site_name: siteName,
    last_check: new Date().toISOString(),
    courses: cleanCourses
  });

  return {
    changes,
    currentCount: cleanCourses.length,
    previousCount: previous ? previous.courses.length : 0,
    isFirstRun
  };
}

module.exports = {
  readJson,
  siteSnapshotFile,
  updateSiteSnapshot,
  writeJson
};
