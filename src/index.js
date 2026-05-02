#!/usr/bin/env node

const { loadConfig } = require('./config');
const fetcher = require('./lib/fetcher');
const { createLogger } = require('./lib/logger');
const { createNotifier } = require('./lib/notifier');
const { updateSiteSnapshot } = require('./lib/snapshot');
const { courseFingerprint, isAvailableStatus } = require('./lib/parser-utils');
const { QueueFairSkipError } = require('./lib/browser');

const toronto = require('./monitors/toronto');
const kuper = require('./monitors/kuper');
const montreal = require('./monitors/montreal');
const edmonton = require('./monitors/edmonton');
const manitoba = require('./monitors/manitoba');
const ottawa = require('./monitors/ottawa');

const BACKOFF_DELAYS_MS = [60_000, 120_000, 300_000, 600_000];

function hasFlag(name) {
  return process.argv.includes(name);
}

function nextBackoffDelay(state) {
  const index = Math.min(state.failures, BACKOFF_DELAYS_MS.length - 1);
  state.failures += 1;
  return BACKOFF_DELAYS_MS[index];
}

function resetBackoff(state) {
  state.failures = 0;
}

function describeDelay(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

async function runMonitorOnce(monitor, context) {
  const { logger, config, notifier } = context;
  logger.info(`[${monitor.name}] 开始检查`);

  const result = await monitor.check(context);
  let snapshotResult;
  if (context.dryRun) {
    snapshotResult = {
      currentCount: result.courses.length,
      previousCount: 0,
      isFirstRun: false,
      changes: result.courses
        .filter((course) => isAvailableStatus(course.status))
        .map((course) => ({
          type: 'dry_run_available_course',
          siteKey: result.siteKey,
          siteName: result.siteName,
          course,
          registrationUrl: result.registrationUrl,
          detectedAt: new Date().toISOString(),
          fingerprint: courseFingerprint(result.siteKey, course)
        }))
    };
    logger.info(`[${result.siteName}] dry-run 模式未写入快照文件。`);
  } else {
    snapshotResult = updateSiteSnapshot(
      config,
      result.siteKey,
      result.siteName,
      result.courses,
      result.registrationUrl
    );
  }

  if (snapshotResult.isFirstRun) {
    logger.info(
      `[${result.siteName}] 首次运行，建立基线快照：${snapshotResult.currentCount} 条课程，不触发通知。`
    );
  } else {
    logger.info(
      `[${result.siteName}] 检查完成：当前 ${snapshotResult.currentCount} 条，新增可报名变化 ${snapshotResult.changes.length} 条`
    );
  }

  if (result.notes && result.notes.length > 0) {
    logger.info(`[${result.siteName}] 页面提示：${result.notes.join(' | ')}`);
  }

  for (const change of snapshotResult.changes) {
    await notifier.notifyChange(change);
  }

  return snapshotResult;
}

/**
 * Resolve poll interval for a given monitor key.
 * Each site can override global defaults via SITE_POLL_INTERVAL_BASE / _JITTER.
 */
function siteInterval(config, monitorKey) {
  const siteKeys = Object.keys(config.sites);
  const site = siteKeys.includes(monitorKey) ? config.sites[monitorKey] : null;
  return {
    base: (site && site.pollIntervalBaseSeconds) || config.pollIntervalBaseSeconds,
    jitter: (site && site.pollIntervalJitterSeconds) || config.pollIntervalJitterSeconds
  };
}

async function runLoop(monitor, context, initialDelayMs) {
  const { logger, config } = context;
  const backoff = { failures: 0 };
  const interval = siteInterval(config, monitor.key);

  logger.info(
    `[${monitor.name}] 轮询间隔：${interval.base}±${interval.jitter} 秒`
  );

  if (initialDelayMs > 0) {
    logger.info(`[${monitor.name}] 错峰启动，${describeDelay(initialDelayMs)} 后首次检查`);
    await fetcher.sleep(initialDelayMs);
  }

  while (true) {
    try {
      await runMonitorOnce(monitor, context);
      resetBackoff(backoff);
      const delay = fetcher.jitteredDelayMs(interval.base, interval.jitter);
      logger.info(`[${monitor.name}] 下次检查：${describeDelay(delay)} 后`);
      await fetcher.sleep(delay);
    } catch (error) {
      // Queue-Fair 跳过：上次已排过队，本轮主动跳过，不算失败
      if (error instanceof QueueFairSkipError) {
        logger.info(`[${monitor.name}] ${error.message}`);
        const delay = fetcher.jitteredDelayMs(interval.base, interval.jitter);
        logger.info(`[${monitor.name}] 下次检查：${describeDelay(delay)} 后`);
        await fetcher.sleep(delay);
        continue;
      }
      const delay = fetcher.isRateLimitOrServerError(error)
        ? nextBackoffDelay(backoff)
        : fetcher.jitteredDelayMs(interval.base, interval.jitter);
      logger.warn(`[${monitor.name}] 检查失败：${error.message}`);
      logger.warn(`[${monitor.name}] 下次重试：${describeDelay(delay)} 后`);
      await fetcher.sleep(delay);
    }
  }
}

async function runTestMode(config, logger, dryRun) {
  logger.info('进入测试模式：不抓网站，只发送一封模拟考位邮件。');
  const notifier = createNotifier(config, logger, { dryRun });
  await notifier.sendTestEmail();
  logger.info('测试模式完成。');
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const dryRun = hasFlag('--dry-run');

  process.on('unhandledRejection', (error) => {
    logger.error('未处理的异步错误', error);
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获的运行错误', error);
    logger.close();
    process.exit(1);
  });

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`收到 ${signal}，正在关闭...`);
      logger.close();
      process.exit(0);
    });
  }

  if (hasFlag('--test')) {
    await runTestMode(config, logger, dryRun);
    return;
  }

  const notifier = createNotifier(config, logger, { dryRun });
  const context = { config, logger, fetcher, notifier, dryRun };
  const monitors = [kuper, toronto, montreal, edmonton, manitoba, ottawa];

  logger.info(`TCF Monitor 启动。监控 ${monitors.length} 个考点。`);
  if (dryRun) logger.info('当前是 dry-run 模式：会检查网站，但不会发送邮件或写入快照。');

  if (hasFlag('--once')) {
    let failures = 0;
    for (const monitor of monitors) {
      try {
        await runMonitorOnce(monitor, context);
      } catch (error) {
        failures += 1;
        logger.warn(`[${monitor.name}] 单次检查失败：${error.message}`);
      }
    }
    logger.info(`单次检查完成。失败 ${failures} 个考点。`);
    if (failures > 0) process.exitCode = 1;
    return;
  }

  const staggerWindowMs = config.pollIntervalBaseSeconds * 1000;
  monitors.forEach((monitor, index) => {
    const interval = siteInterval(config, monitor.key);
    // Use the site's own interval for stagger, but cap initial delay to global interval
    const staggerMs = Math.min(
      Math.round((staggerWindowMs / monitors.length) * index),
      interval.base * 1000
    );
    runLoop(monitor, context, staggerMs).catch((error) => {
      logger.error(`[${monitor.name}] 监控循环退出`, error);
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
