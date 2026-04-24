const path = require('path');
const nodemailer = require('nodemailer');
const { readJson, writeJson } = require('./snapshot');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function validateMailConfig(config) {
  const missing = [];
  if (!config.gmail.user) missing.push('GMAIL_USER');
  if (!config.gmail.appPassword) missing.push('GMAIL_APP_PASSWORD');
  if (!config.gmail.recipient) missing.push('RECIPIENT_EMAIL');
  if (missing.length > 0) {
    throw new Error(`邮件配置缺失：${missing.join(', ')}。请先复制 .env.example 为 .env 并填写。`);
  }
}

function createTransport(config) {
  validateMailConfig(config);
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: config.gmail.user,
      pass: config.gmail.appPassword
    }
  });
}

function siteNotificationFile(config, siteKey) {
  return path.join(config.dataDir, `notifications-${siteKey}.json`);
}

function isAutoAddCartUrl(url) {
  return /\/panier\/#\/addExamination\//i.test(String(url || ''));
}

function getEmailTargets(change) {
  const course = change.course;
  const courseUrl = course.url || '';
  const registrationUrl = change.registrationUrl || courseUrl;
  const isAutoAddCart = isAutoAddCartUrl(courseUrl);

  return {
    primaryUrl: isAutoAddCart ? registrationUrl : (courseUrl || registrationUrl),
    directCartUrl: isAutoAddCart ? courseUrl : '',
    isAutoAddCart
  };
}

function buildHtml(change) {
  const course = change.course;
  const targets = getEmailTargets(change);
  const rows = [
    ['考场', change.siteName],
    ['课程', course.name],
    ['日期', course.date || '页面未明确写出日期，请点报名页确认'],
    ['ID', course.id],
    ['状态', course.rawStatus || course.status],
    ['说明', course.description || ''],
    ['检测时间', change.detectedAt]
  ].filter(([, value]) => value !== '');

  const detailRows = rows
    .map(([label, value]) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;width:96px;">${escapeHtml(label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(value)}</td>
      </tr>`)
    .join('');

  const cartWarning = targets.isAutoAddCart
    ? `
      <p style="font-size:14px;color:#9a3412;background:#fff7ed;border:1px solid #fed7aa;padding:12px 14px;border-radius:6px;margin:18px 0;">
        Montreal 的直接报名链接会复用当前浏览器购物车。如果购物车里已有旧场次，请先清空购物车，或从报名页重新选择本邮件中的日期。
      </p>
      <p style="font-size:14px;margin:12px 0;">
        直接加入购物车链接：<br>
        <a href="${escapeHtml(targets.directCartUrl)}" style="color:#d6002a;">${escapeHtml(targets.directCartUrl)}</a>
      </p>`
    : '';

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;line-height:1.6;color:#222;max-width:680px;margin:0 auto;">
      <h1 style="font-size:24px;margin:0 0 16px;color:#d6002a;">发现新的 TCF 考位</h1>
      <p style="font-size:16px;margin:0 0 18px;">监控脚本检测到一个可报名的 TCF Canada 场次，请尽快打开报名页确认。</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0;border:1px solid #eee;">
        ${detailRows}
      </table>
      ${cartWarning}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(targets.primaryUrl)}" style="display:inline-block;background:#d6002a;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:6px;">
          立即打开报名页
        </a>
      </p>
      <p style="font-size:13px;color:#777;margin-top:20px;">如果按钮打不开，请复制这个链接到浏览器：<br>${escapeHtml(targets.primaryUrl)}</p>
    </div>`;
}

function buildText(change) {
  const course = change.course;
  const targets = getEmailTargets(change);
  const lines = [
    '发现新的 TCF 考位',
    '',
    `考场：${change.siteName}`,
    `课程：${course.name}`,
    `日期：${course.date || '页面未明确写出日期，请点报名页确认'}`,
    `ID：${course.id}`,
    `状态：${course.rawStatus || course.status}`,
    `检测时间：${change.detectedAt}`,
    '',
    `报名页：${targets.primaryUrl}`
  ];

  if (targets.isAutoAddCart) {
    lines.push(
      '',
      '注意：Montreal 的直接报名链接会复用当前浏览器购物车。如购物车里已有旧场次，请先清空购物车，或从报名页重新选择本邮件中的日期。',
      `直接加入购物车链接：${targets.directCartUrl}`
    );
  }

  return lines.join('\n');
}

function isWithinDedupeWindow(config, timestamp) {
  if (!timestamp) return false;
  const last = new Date(timestamp).getTime();
  if (Number.isNaN(last)) return false;
  const windowMs = config.notificationDedupeWindowMinutes * 60 * 1000;
  return Date.now() - last < windowMs;
}

function createNotifier(config, logger, options = {}) {
  const dryRun = options.dryRun === true;
  const transport = dryRun ? null : createTransport(config);

  async function send(change, sendOptions = {}) {
    const subjectPrefix = sendOptions.test ? '测试邮件 - ' : '';
    const subject = `${subjectPrefix}🚨 [${change.siteName}] 发现新 TCF 考位!`;
    const html = buildHtml(change);
    const text = buildText(change);

    if (dryRun) {
      logger.info('[dry-run] 邮件不会真正发送', { to: config.gmail.recipient, subject, text });
      return { dryRun: true };
    }

    return transport.sendMail({
      from: `"TCF Monitor" <${config.gmail.user}>`,
      to: config.gmail.recipient,
      subject,
      text,
      html
    });
  }

  async function notifyChange(change) {
    if (dryRun) {
      await send(change);
      logger.info(`[${change.siteName}] dry-run 模式未写入通知去重记录：${change.course.name} ${change.course.date || ''}`);
      return { dryRun: true };
    }

    const notifFile = siteNotificationFile(config, change.siteKey);
    const state = readJson(notifFile, {});
    if (isWithinDedupeWindow(config, state[change.fingerprint])) {
      logger.info(`[${change.siteName}] 跳过重复通知：${change.course.name} ${change.course.date || ''}`);
      return { skipped: true };
    }

    const result = await send(change);
    const freshState = readJson(notifFile, {});
    freshState[change.fingerprint] = new Date().toISOString();
    writeJson(notifFile, freshState);
    logger.info(`[${change.siteName}] 已发送邮件通知：${change.course.name} ${change.course.date || ''}`);
    return result;
  }

  async function sendTestEmail() {
    const change = {
      type: 'test',
      siteKey: 'test',
      siteName: '测试考场',
      registrationUrl: 'https://www.afmanitoba.ca/en/exams/tcf/',
      detectedAt: new Date().toISOString(),
      fingerprint: `test-${Date.now()}`,
      course: {
        id: 'TEST-TCF-CANADA',
        name: 'TCF Canada 测试考位',
        date: '2026-06-09',
        status: 'available',
        rawStatus: '测试模式：模拟发现可报名考位',
        url: 'https://www.afmanitoba.ca/en/exams/tcf/'
      }
    };
    return send(change, { test: true });
  }

  return {
    notifyChange,
    sendTestEmail
  };
}

module.exports = {
  createNotifier
};
