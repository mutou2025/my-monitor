#!/usr/bin/env python3
"""
IRCC TR-to-PR 2026 政策监控脚本
================================
每 10 分钟自动检查 IRCC 官方新闻 API 和关键页面，
一旦发现 TR to PR 相关公告，立即通过邮件 + Mac 桌面通知。

使用方法:
  1. 首次运行前，编辑下方 EMAIL_CONFIG 填入你的邮箱信息
  2. 运行: python3 monitor_ircc.py
  3. 脚本会在后台持续运行，每 10 分钟检查一次
  4. 后台运行: nohup python3 monitor_ircc.py > monitor.log 2>&1 &

依赖: 仅使用 Python 标准库，无需 pip install
"""

import json
import os
import re
import smtplib
import subprocess
import sys
import time
import hashlib
import logging
import urllib.request
import urllib.error
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone
from pathlib import Path

# ============================================================
# 配置区 - 请根据你的实际情况修改
# ============================================================

# 邮件配置 (推荐使用 Gmail App Password)
# Gmail 设置方法: Google 账号 -> 安全 -> 两步验证 -> 应用专用密码
EMAIL_CONFIG = {
    "enabled": True,                        # 设为 True 开启邮件通知
    "smtp_server": "smtp.gmail.com",        # SMTP 服务器
    "smtp_port": 587,                       # SMTP 端口 (TLS)
    "sender_email": "YOUR_EMAIL@gmail.com", # 发件邮箱
    "sender_password": "YOUR_APP_PASSWORD",  # Gmail App Password (16位)
    "recipient_emails": [                   # 收件邮箱，可以填多个
        "YOUR_EMAIL@gmail.com",
    ],
}

# 检查间隔 (秒) — 默认 10 分钟 = 600 秒
CHECK_INTERVAL = 600

# 脚本工作目录 (存放状态文件)
SCRIPT_DIR = Path(__file__).parent.resolve()
STATE_FILE = SCRIPT_DIR / "ircc_monitor_state.json"
LOG_FILE = SCRIPT_DIR / "ircc_monitor.log"

# ============================================================
# 监控源 - 覆盖 IRCC 所有官方发布渠道
# ============================================================

# 1. IRCC 官方新闻 API (JSON格式，最可靠)
NEWS_API_URLS = [
    # 所有新闻发布 (News Releases)
    "https://api.io.canada.ca/io-server/gc/news/en/v2?dept=departmentofcitizenshipandimmigration&type=newsreleases&sort=publishedDate&orderBy=desc&limit=20",
    # 所有声明 (Statements)
    "https://api.io.canada.ca/io-server/gc/news/en/v2?dept=departmentofcitizenshipandimmigration&type=statements&sort=publishedDate&orderBy=desc&limit=10",
    # 背景资料 (Backgrounders) — 细则通常会以 Backgrounder 形式发布
    "https://api.io.canada.ca/io-server/gc/news/en/v2?dept=departmentofcitizenshipandimmigration&type=backgrounders&sort=publishedDate&orderBy=desc&limit=10",
    # 媒体咨询 (Media Advisories) — 发布前一天的预告
    "https://api.io.canada.ca/io-server/gc/news/en/v2?dept=departmentofcitizenshipandimmigration&type=mediaadvisories&sort=publishedDate&orderBy=desc&limit=10",
]

# 2. 全类型 API (不限新闻类型的 catch-all，防止遗漏)
#    ⚠️ 注意: canada.ca 网页有 WAF/CloudFront 防护，会拦截脚本请求
#    (HTTP/2 INTERNAL_ERROR 或超时)，所以不使用网页抓取。
#    API 端点 (api.io.canada.ca) 无此限制，且数据更结构化、更可靠。
ALL_NEWS_API = "https://api.io.canada.ca/io-server/gc/news/en/v2?dept=departmentofcitizenshipandimmigration&sort=publishedDate&orderBy=desc&limit=30"

# ============================================================
# 关键词配置 — 分层匹配：高置信度 + 中置信度
# ============================================================

# 高置信度关键词 (任意一个命中 = 直接通知)
HIGH_CONFIDENCE_KEYWORDS = [
    "temporary resident to permanent resident",
    "temporary residents to permanent residents",
    "temporary resident pathway",
    "tr to pr",
    "tr-to-pr",
    "transition to permanent residence",
    "33,000",
    "33000",
    "one-time pathway",
    "one time pathway",
]

# 中置信度关键词 (需要两个或以上同时命中才通知)
MEDIUM_CONFIDENCE_KEYWORDS = [
    "permanent residence pathway",
    "new pathway",
    "new immigration pathway",
    "foreign worker.*permanent",
    "temporary foreign worker.*pathway",
    "transition plan",
    "regularization",
    "status regularization",
    "in-canada pathway",
    "open to applications",
    "accepting applications",
    "application guide",
    "document checklist",
    "imm 0008",
    "imm 0130",
]

# ============================================================
# 日志设置
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ],
)
logger = logging.getLogger("IRCCMonitor")


# ============================================================
# 工具函数
# ============================================================

def load_state():
    """加载上次运行的状态 (已通知过的新闻标题哈希集合)"""
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            logger.warning("状态文件损坏，重新初始化")
    return {"notified_hashes": [], "last_check": None, "check_count": 0}


def save_state(state):
    """保存状态到文件"""
    # 只保留最近 500 条哈希，防止文件无限增长
    state["notified_hashes"] = state["notified_hashes"][-500:]
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def content_hash(text):
    """对内容生成唯一哈希，用于防重复通知"""
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def fetch_url(url, timeout=30):
    """带重试的 URL 内容抓取"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/json,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9",
    }
    # 创建不验证 SSL 的 context (某些环境需要)
    ctx = ssl.create_default_context()

    max_retries = 3
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return resp.read().decode("utf-8")
        except Exception as e:
            logger.warning(f"抓取失败 (第{attempt+1}次): {url} - {e}")
            if attempt < max_retries - 1:
                time.sleep(5 * (attempt + 1))  # 递增等待
    return None


def match_keywords(text):
    """对文本进行关键词匹配，返回匹配结果"""
    text_lower = text.lower()

    # 检查高置信度关键词
    high_matches = [kw for kw in HIGH_CONFIDENCE_KEYWORDS if kw.lower() in text_lower]

    # 检查中置信度关键词 (支持正则)
    medium_matches = []
    for kw in MEDIUM_CONFIDENCE_KEYWORDS:
        try:
            if re.search(kw, text_lower):
                medium_matches.append(kw)
        except re.error:
            if kw.lower() in text_lower:
                medium_matches.append(kw)

    return high_matches, medium_matches


# ============================================================
# 数据源检查
# ============================================================

def check_news_api():
    """检查 IRCC 官方新闻 API，返回命中的新闻列表"""
    results = []

    for api_url in NEWS_API_URLS:
        raw = fetch_url(api_url)
        if not raw:
            continue

        try:
            data = json.loads(raw)
            entries = data.get("feed", {}).get("entry", [])
        except (json.JSONDecodeError, AttributeError):
            logger.error(f"API 返回格式异常: {api_url}")
            continue

        for entry in entries:
            title = entry.get("title", "")
            teaser = entry.get("teaser", "")
            link = entry.get("link", "")
            pub_date = entry.get("publishedDate", "")
            combined_text = f"{title} {teaser}"

            high, medium = match_keywords(combined_text)

            if high or len(medium) >= 2:
                results.append({
                    "source": "IRCC News API",
                    "title": title,
                    "teaser": teaser[:300],
                    "link": link,
                    "published": pub_date,
                    "high_keywords": high,
                    "medium_keywords": medium,
                    "hash": content_hash(f"{title}|{link}"),
                })

    return results


def check_all_news():
    """检查全类型新闻 API (不限分类，作为 catch-all 兜底)"""
    results = []

    raw = fetch_url(ALL_NEWS_API)
    if not raw:
        logger.warning("全类型 API 抓取失败")
        return results

    try:
        data = json.loads(raw)
        entries = data.get("feed", {}).get("entry", [])
    except (json.JSONDecodeError, AttributeError):
        logger.error("全类型 API 返回格式异常")
        return results

    for entry in entries:
        title = entry.get("title", "")
        teaser = entry.get("teaser", "")
        link = entry.get("link", "")
        pub_date = entry.get("publishedDate", "")
        combined_text = f"{title} {teaser}"

        high, medium = match_keywords(combined_text)

        if high or len(medium) >= 2:
            results.append({
                "source": "IRCC All-News API (catch-all)",
                "title": title,
                "teaser": teaser[:300],
                "link": link,
                "published": pub_date,
                "high_keywords": high,
                "medium_keywords": medium,
                "hash": content_hash(f"{title}|{link}"),
            })

    return results


# ============================================================
# 通知发送
# ============================================================

def notify_mac(title, message):
    """发送 Mac 桌面通知 (带声音)"""
    try:
        # 截断以避免 osascript 参数过长
        msg_short = message[:200].replace('"', '\\"').replace("'", "\\'")
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{msg_short}" with title "{title}" sound name "Glass"'],
            timeout=10,
        )
        logger.info("✅ Mac 桌面通知已发送")
    except Exception as e:
        logger.error(f"Mac 通知发送失败: {e}")


def send_email(subject, html_body):
    """发送邮件通知"""
    cfg = EMAIL_CONFIG
    if not cfg["enabled"]:
        logger.info("邮件通知未启用，跳过")
        return False

    if cfg["sender_email"] == "YOUR_EMAIL@gmail.com":
        logger.warning("⚠️ 邮件配置尚未修改！请编辑脚本中的 EMAIL_CONFIG")
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = cfg["sender_email"]
        msg["To"] = ", ".join(cfg["recipient_emails"])

        # 纯文本版本 (备用)
        text_body = re.sub(r"<[^>]+>", "", html_body)
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
        # HTML 版本
        msg.attach(MIMEText(html_body, "html", "utf-8"))

        with smtplib.SMTP(cfg["smtp_server"], cfg["smtp_port"], timeout=30) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(cfg["sender_email"], cfg["sender_password"])
            server.sendmail(
                cfg["sender_email"],
                cfg["recipient_emails"],
                msg.as_string(),
            )

        logger.info("✅ 邮件通知已发送")
        return True
    except Exception as e:
        logger.error(f"❌ 邮件发送失败: {e}")
        return False


def build_email_html(findings):
    """构建美观的邮件 HTML 内容"""
    items_html = ""
    for f in findings:
        kw_tags = ""
        for kw in f.get("high_keywords", []):
            kw_tags += f'<span style="background:#ff4444;color:white;padding:2px 8px;border-radius:12px;font-size:12px;margin:2px;">{kw}</span> '
        for kw in f.get("medium_keywords", []):
            kw_tags += f'<span style="background:#ff9800;color:white;padding:2px 8px;border-radius:12px;font-size:12px;margin:2px;">{kw}</span> '

        items_html += f"""
        <div style="background:#f8f9fa;border-left:4px solid #dc3545;padding:16px;margin:12px 0;border-radius:4px;">
            <h3 style="margin:0 0 8px 0;color:#333;">
                <a href="{f.get('link', '#')}" style="color:#0066cc;text-decoration:none;">
                    {f.get('title', 'N/A')}
                </a>
            </h3>
            <p style="color:#555;margin:4px 0;font-size:14px;">
                📅 发布时间: {f.get('published', 'N/A')}
            </p>
            <p style="color:#666;margin:8px 0;font-size:14px;line-height:1.5;">
                {f.get('teaser', '')}
            </p>
            <div style="margin-top:8px;">
                🔑 匹配关键词: {kw_tags}
            </div>
            <p style="margin-top:8px;font-size:12px;color:#999;">
                来源: {f.get('source', 'N/A')}
            </p>
        </div>
        """

    return f"""
    <html>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
        <div style="background:linear-gradient(135deg,#dc3545,#c82333);color:white;padding:24px;border-radius:8px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">🚨 IRCC TR-to-PR 政策更新监控</h1>
            <p style="margin:8px 0 0;font-size:14px;opacity:0.9;">
                检测时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} (Toronto 时间)
            </p>
        </div>

        <div style="padding:20px 0;">
            <h2 style="color:#333;border-bottom:2px solid #dc3545;padding-bottom:8px;">
                ⚡ 发现 {len(findings)} 条疑似相关公告
            </h2>
            {items_html}
        </div>

        <div style="background:#fff3cd;padding:16px;border-radius:4px;border:1px solid #ffc107;margin-top:20px;">
            <p style="margin:0;font-size:14px;color:#856404;">
                ⚠️ <strong>重要提醒:</strong> 请立即点击上方链接确认内容。
                如果确认是 TR to PR 2026 新细则，请尽快：<br>
                1. 仔细阅读完整公告和资格要求<br>
                2. 下载最新的申请表格和清单<br>
                3. 准备好所有所需材料<br>
                4. 在开放申请后第一时间提交
            </p>
        </div>

        <p style="text-align:center;color:#999;font-size:12px;margin-top:24px;">
            此邮件由 IRCC 监控脚本自动发送 | 
            <a href="https://www.canada.ca/en/immigration-refugees-citizenship/news.html" style="color:#999;">IRCC Newsroom</a>
        </p>
    </body>
    </html>
    """


def send_notifications(findings):
    """发送所有类型的通知"""
    if not findings:
        return

    # 1. Mac 桌面通知
    titles = [f.get("title", "")[:60] for f in findings[:3]]
    mac_msg = "发现相关公告:\n" + "\n".join(f"• {t}" for t in titles)
    notify_mac("🚨 IRCC TR-to-PR 更新!", mac_msg)

    # 2. 邮件通知
    subject = f"🚨 IRCC TR-to-PR 监控: 发现 {len(findings)} 条疑似相关公告!"
    html = build_email_html(findings)
    send_email(subject, html)


# ============================================================
# 主检查流程
# ============================================================

def run_check():
    """执行一次完整检查"""
    state = load_state()
    state["check_count"] = state.get("check_count", 0) + 1
    state["last_check"] = datetime.now().isoformat()

    logger.info(f"{'='*60}")
    logger.info(f"第 {state['check_count']} 次检查开始...")

    all_findings = []

    # 1. 检查官方新闻 API (按类型分类)
    logger.info("📡 检查 IRCC 官方新闻 API (分类检查)...")
    api_findings = check_news_api()
    all_findings.extend(api_findings)

    # 2. 检查全类型新闻 API (catch-all 兜底)
    logger.info("📡 检查 IRCC 全类型新闻 API (兜底检查)...")
    all_news_findings = check_all_news()
    # 去重: 只添加 hash 不在已有结果中的
    existing_hashes = {f["hash"] for f in all_findings}
    for f in all_news_findings:
        if f["hash"] not in existing_hashes:
            all_findings.append(f)

    # 3. 过滤掉已通知过的
    notified = set(state.get("notified_hashes", []))
    new_findings = [f for f in all_findings if f["hash"] not in notified]

    if new_findings:
        logger.info(f"🔥 发现 {len(new_findings)} 条新的匹配结果!")
        for f in new_findings:
            logger.info(f"  📌 {f['title']}")
            logger.info(f"     高置信: {f.get('high_keywords', [])}")
            logger.info(f"     中置信: {f.get('medium_keywords', [])}")
            logger.info(f"     链接: {f.get('link', 'N/A')}")

        # 发送通知
        send_notifications(new_findings)

        # 记录已通知的哈希
        for f in new_findings:
            state["notified_hashes"].append(f["hash"])
    else:
        logger.info("✅ 未发现新的 TR-to-PR 相关公告")

    save_state(state)
    logger.info(f"下次检查将在 {CHECK_INTERVAL // 60} 分钟后")
    return new_findings


def send_startup_email():
    """启动时发送测试邮件，确认邮件功能正常"""
    cfg = EMAIL_CONFIG
    if not cfg["enabled"] or cfg["sender_email"] == "YOUR_EMAIL@gmail.com":
        logger.warning("⚠️ 邮件未配置！请编辑 EMAIL_CONFIG 并重新运行")
        logger.warning("   设置方法: Gmail -> 两步验证 -> 应用专用密码")
        return

    subject = "✅ IRCC TR-to-PR 监控脚本已启动"
    html = f"""
    <html>
    <body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:linear-gradient(135deg,#28a745,#218838);color:white;padding:24px;border-radius:8px;text-align:center;">
            <h1 style="margin:0;">✅ 监控已启动</h1>
        </div>
        <div style="padding:20px;">
            <p>IRCC TR-to-PR 政策监控脚本已成功启动。</p>
            <ul>
                <li>检查间隔: 每 <strong>{CHECK_INTERVAL // 60}</strong> 分钟</li>
                <li>监控源: {len(NEWS_API_URLS)} 个 API + {len(WEB_PAGES)} 个网页</li>
                <li>高置信关键词: {len(HIGH_CONFIDENCE_KEYWORDS)} 个</li>
                <li>中置信关键词: {len(MEDIUM_CONFIDENCE_KEYWORDS)} 个</li>
                <li>启动时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</li>
            </ul>
            <p style="color:#666;">发现相关公告时，你将在 <strong>10 分钟内</strong> 收到邮件和桌面通知。</p>
        </div>
    </body>
    </html>
    """
    success = send_email(subject, html)
    if success:
        logger.info("🎉 启动测试邮件发送成功！邮件功能正常")
    else:
        logger.error("❌ 启动测试邮件发送失败！请检查 EMAIL_CONFIG 配置")


# ============================================================
# 入口
# ============================================================

def main():
    logger.info("=" * 60)
    logger.info("🇨🇦 IRCC TR-to-PR 2026 政策监控脚本 v2.0")
    logger.info("=" * 60)
    logger.info(f"检查间隔: {CHECK_INTERVAL}秒 ({CHECK_INTERVAL // 60}分钟)")
    logger.info(f"监控源: {len(NEWS_API_URLS)} 个 API + {len(WEB_PAGES)} 个网页")
    logger.info(f"高置信关键词: {HIGH_CONFIDENCE_KEYWORDS}")
    logger.info(f"状态文件: {STATE_FILE}")
    logger.info(f"日志文件: {LOG_FILE}")
    logger.info("")

    # 启动时发送测试邮件
    send_startup_email()

    # 立即执行一次检查
    run_check()

    # 持续循环检查
    logger.info("")
    logger.info(f"🔄 进入持续监控模式 (每 {CHECK_INTERVAL // 60} 分钟检查一次)")
    logger.info("   按 Ctrl+C 可以停止脚本")
    logger.info("")

    while True:
        try:
            time.sleep(CHECK_INTERVAL)
            run_check()
        except KeyboardInterrupt:
            logger.info("\n⏹  用户中断，脚本停止")
            break
        except Exception as e:
            logger.error(f"检查过程出错 (将在下次继续): {e}")
            time.sleep(60)  # 出错后等 1 分钟再重试


if __name__ == "__main__":
    main()
