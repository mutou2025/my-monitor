const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const projectRoot = path.resolve(__dirname, '..');

function intEnv(name, fallback, minimum = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function stringEnv(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw.trim();
}

function boolEnv(name, fallback = false) {
  const raw = stringEnv(name).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function parseJsonEnv(name, fallback) {
  const raw = stringEnv(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} 不是合法 JSON：${error.message}`);
  }
}

function loadConfig() {
  const pollIntervalBaseSeconds = intEnv('POLL_INTERVAL_BASE', 90, 10);
  const pollIntervalJitterSeconds = intEnv('POLL_INTERVAL_JITTER', 30, 0);

  return {
    projectRoot,
    dataDir: path.join(projectRoot, 'data'),
    logsDir: path.join(projectRoot, 'logs'),
    logFile: path.join(projectRoot, 'logs', 'monitor.log'),
    logLevel: stringEnv('LOG_LEVEL', 'info').toLowerCase(),
    pollIntervalBaseSeconds,
    pollIntervalJitterSeconds,
    requestTimeoutMs: 15000,
    playwrightTimeoutMs: intEnv('PLAYWRIGHT_TIMEOUT_MS', 30000, 15000),
    notificationDedupeWindowMinutes: intEnv('NOTIFICATION_DEDUPE_WINDOW', 30, 1),
    notifyOnFirstRun: boolEnv('NOTIFY_ON_FIRST_RUN', false),
    playwrightMode: stringEnv('PLAYWRIGHT_MODE', 'auto').toLowerCase(),
    gmail: {
      user: stringEnv('GMAIL_USER'),
      appPassword: stringEnv('GMAIL_APP_PASSWORD'),
      recipient: stringEnv('RECIPIENT_EMAIL')
    },
    sites: {
      toronto: {
        key: 'toronto',
        name: 'Toronto - Spadina Campus',
        url: stringEnv(
          'TORONTO_URL',
          'https://www.alliance-francaise.ca/en/exams/tests/informations-about-tcf-canada/tcf-canada'
        ),
        registrationUrl: stringEnv('TORONTO_URL', 'https://www.alliance-francaise.ca/en/exams/tests/informations-about-tcf-canada/tcf-canada'),
        campus: 'Spadina Campus',
        address: '24 Spadina Road, Toronto, ON',
        activeApiUrl: stringEnv('TORONTO_ACTIVE_API_URL'),
        activeApiMethod: stringEnv('TORONTO_ACTIVE_API_METHOD', 'GET').toUpperCase(),
        activeApiBody: stringEnv('TORONTO_ACTIVE_API_BODY'),
        activeApiHeaders: parseJsonEnv('TORONTO_ACTIVE_API_HEADERS', {})
      },
      kuper: {
        key: 'kuper',
        name: 'Montreal - Kuper Academy Kirkland',
        url: stringEnv(
          'KUPER_URL',
          'https://www.kuperacademy.ca/en/academics/tcf-canada-tcfq-language-proficiency-testing.html'
        ),
        registrationUrl: stringEnv(
          'KUPER_URL',
          'https://www.kuperacademy.ca/en/academics/tcf-canada-tcfq-language-proficiency-testing.html'
        ),
        campus: 'Kuper Academy, Kirkland',
        address: '2975 Edmond, Kirkland, Quebec, H9H 5K5'
      },
      montreal: {
        key: 'montreal',
        name: 'Montreal - Alliance Francaise de Montreal',
        url: stringEnv('MONTREAL_URL', 'https://www.afmontreal.ca/tcf/#/'),
        registrationUrl: stringEnv('MONTREAL_URL', 'https://www.afmontreal.ca/tcf/#/')
      },
      edmonton: {
        key: 'edmonton',
        name: 'Edmonton - Alliance Francaise Edmonton',
        url: stringEnv('EDMONTON_URL', 'https://www.afedmonton.com/en/exams/tcf/'),
        registrationUrl: stringEnv('EDMONTON_URL', 'https://www.afedmonton.com/en/exams/tcf/')
      },
      manitoba: {
        key: 'manitoba',
        name: 'Manitoba - Alliance Francaise du Manitoba',
        url: stringEnv('MANITOBA_URL', 'https://www.afmanitoba.ca/en/exams/tcf/'),
        registrationUrl: stringEnv('MANITOBA_URL', 'https://www.afmanitoba.ca/en/exams/tcf/')
      },
      ottawa: {
        key: 'ottawa',
        name: 'Ottawa - Alliance Francaise Ottawa',
        url: stringEnv('OTTAWA_URL', 'https://af.ca/ottawa/tests_et_examens/tcf-2/'),
        registrationUrl: stringEnv('OTTAWA_REGISTRATION_URL', 'https://af.ca/ottawa/tests_et_examens/tcf-2/'),
        apiUrl: stringEnv(
          'OTTAWA_AEC_API_URL',
          'https://afottawa.aec.app/api/v1/public/examinations/list/1/5|79?allBranches=NO'
        ),
        apiKey: stringEnv(
          'OTTAWA_AEC_API_KEY',
          'Y2QwOTc2YjhlNzU4MzcyNTMwMGI0NGUxMjY3MGQzNzY0NTdhZGI2NWQ0MjIxYjQ2NjcxYjRhZDZhZTY3ZDQ3NA=='
        ),
        targetDates: parseJsonEnv('OTTAWA_TARGET_DATES', []),
        excludedDates: parseJsonEnv('OTTAWA_EXCLUDED_DATES', ['2026-07-02'])
      }
    }
  };
}

module.exports = { loadConfig };
