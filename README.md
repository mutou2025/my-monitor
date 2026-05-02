# TCF Canada 考位监控工具

这个工具可以定时监控 TCF Canada 报名页面。一旦发现新的可报名考位，或者某个场次从满员变成可报名，就会通过 Gmail SMTP 给配置的收件人发送邮件通知。

当前监控 5 个页面，其中前两个是重点考点：

- Montreal 重点：Kuper Academy Kirkland / 西岛校区，2975 Edmond, Kirkland, QC H9H 5K5  
  <https://www.kuperacademy.ca/en/academics/tcf-canada-tcfq-language-proficiency-testing.html>
- Toronto 重点：Spadina Campus，24 Spadina Road, Toronto, ON  
  <https://www.alliance-francaise.ca/en/exams/tests/informations-about-tcf-canada/tcf-canada>
- Montreal: <https://www.afmontreal.ca/tcf/#/>
- Edmonton: <https://www.afedmonton.com/en/exams/tcf/>
- Manitoba: <https://www.afmanitoba.ca/en/exams/tcf/>

## 1. 环境准备

先安装 Node.js。推荐用 Homebrew：

```bash
brew install node
```

如果你没有 Homebrew，也可以去 Node.js 官网下载安装包：<https://nodejs.org/>

装好后，在终端里检查：

```bash
node -v
npm -v
```

`node -v` 建议显示 `v18.17.0` 或更高。

## 2. 第一次运行

进入项目目录：

```bash
cd /path/to/my-monitor
```

安装依赖：

```bash
npm install
```

如果安装 Playwright 后提示缺少浏览器，再运行：

```bash
npx playwright install chromium
```

复制配置文件：

```bash
cp .env.example .env
```

打开 `.env`，填写这几项：

```bash
GMAIL_USER=你的Gmail@gmail.com
GMAIL_APP_PASSWORD=你的Gmail应用专用密码
RECIPIENT_EMAIL=收件人邮箱@example.com
```

其他配置可以先不改：

- `POLL_INTERVAL_BASE=90`：基础检查间隔，90 秒。
- `POLL_INTERVAL_JITTER=30`：每次随机提前或延后 30 秒。
- `NOTIFICATION_DEDUPE_WINDOW=30`：同一个考位 30 分钟内只发一次邮件。
- `PLAYWRIGHT_MODE=auto`：Montreal 这种动态页面抓不到时，自动用浏览器渲染兜底。
- `PLAYWRIGHT_TIMEOUT_MS=30000`：动态页面最多等 30 秒，Montreal 页面比较慢时会用到。
- `PLAYWRIGHT_PERSIST_SESSION=true`：保留浏览器会话/cookie，减少 Toronto Queue-Fair 重复排队。
- `TORONTO_PLAYWRIGHT_TIMEOUT_MS=120000`：Toronto 单独给 120 秒页面超时，避免排队/跳转慢时过早失败。
- `TORONTO_QUEUE_FAIR_WAIT_MS=180000`：Toronto Queue-Fair 最多等 180 秒，避免 90 秒刚到就断开排队。

## 3. Gmail 应用专用密码

不要把 Gmail 登录密码填进 `.env`。请用 Google 的“应用专用密码”。

步骤：

1. 打开 <https://myaccount.google.com/security>
2. 先确认你的 Google 账号已经开启“两步验证”。
3. 搜索或找到“应用专用密码 / App passwords”。
4. 应用选择 `Mail`，设备可以选 `Mac`，或者自定义名字写 `TCF Monitor`。
5. Google 会生成一串 16 位密码，形如 `abcd efgh ijkl mnop`。
6. 把这串密码填到 `.env` 的 `GMAIL_APP_PASSWORD=` 后面。

## 4. 先测试邮件

第一次不要直接跑监控，先确认邮件能发出去：

```bash
node src/index.js --test
```

测试模式不会抓网站，只会模拟“发现新考位”，立刻给收件人发一封测试邮件。

如果你只想看程序会发什么邮件，但不真的发送，可以运行：

```bash
node src/index.js --test --dry-run
```

## 5. 启动监控

正式启动：

```bash
node src/index.js
```

只检查一次就退出：

```bash
node src/index.js --once
```

检查网站但不发邮件：

```bash
node src/index.js --once --dry-run
```

运行后日志会同时出现在终端和文件里：

```bash
tail -f logs/monitor.log
```

## 6. 后台持续运行

### 方法 A：Google Cloud 免费层 VPS（推荐）

Google Cloud 免费层 `e2-micro` 建议用 `systemd` 运行，不需要额外常驻 `pm2`。推荐配置是 60 秒基准轮询、自动重启、1GB swap、进程内存限制。

服务器目录示例：

```bash
/home/chenjunfengf/my-monitor
```

如果是新服务器，先安装依赖并拉代码：

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nodejs npm

cd /home/chenjunfengf
git clone https://github.com/mutou2025/my-monitor.git
cd my-monitor

npm install
npx playwright install --with-deps chromium
```

创建 1GB swap，避免 Playwright 偶发内存峰值直接杀进程：

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

`.env` 推荐关键配置：

```bash
POLL_INTERVAL_BASE=60
POLL_INTERVAL_JITTER=15
TORONTO_POLL_INTERVAL_BASE=60
TORONTO_POLL_INTERVAL_JITTER=20
PLAYWRIGHT_MODE=auto
PLAYWRIGHT_TIMEOUT_MS=30000
PLAYWRIGHT_PERSIST_SESSION=true
TORONTO_PLAYWRIGHT_TIMEOUT_MS=120000
TORONTO_QUEUE_FAIR_WAIT_MS=180000
LOG_LEVEL=info
NOTIFY_ON_FIRST_RUN=false
```

如果 Google Cloud SSH 的上传文件按钮不好用，可以在 Mac 本地把 `.env` 转成 base64 后粘贴到服务器：

```bash
cd /Users/lichen/Workspace/my-monitor
base64 < .env | pbcopy
```

然后在服务器执行：

```bash
cd /home/chenjunfengf/my-monitor
cat > /tmp/env.b64
```

粘贴后按 `Ctrl + D`，再执行：

```bash
base64 -d /tmp/env.b64 > .env
chmod 600 .env
rm /tmp/env.b64
```

先测试：

```bash
npm run test-email
node src/index.js --once
```

创建 systemd 服务：

```bash
sudo nano /etc/systemd/system/tcf-monitor.service
```

内容：

```ini
[Unit]
Description=TCF Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chenjunfengf
WorkingDirectory=/home/chenjunfengf/my-monitor
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
MemoryHigh=600M
MemoryMax=800M

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable tcf-monitor
sudo systemctl start tcf-monitor
```

常用命令：

```bash
# 查看服务状态
systemctl status tcf-monitor

# 查看实时日志
journalctl -u tcf-monitor -f

# 退出实时日志
# Ctrl + C

# 重启监控
sudo systemctl restart tcf-monitor

# 停止监控
sudo systemctl stop tcf-monitor

# 启动监控
sudo systemctl start tcf-monitor

# 查看内存和 swap
free -h
systemctl show tcf-monitor -p MemoryCurrent -p MemoryHigh -p MemoryMax

# 查看项目日志
tail -f /home/chenjunfengf/my-monitor/logs/monitor.log
```

更新代码后重启：

```bash
cd /home/chenjunfengf/my-monitor
git pull
npm install
sudo systemctl restart tcf-monitor
```

如果日志里看到 Toronto 偶发 `HTTP 403`，通常是目标网站临时拒绝云服务器请求。程序会自动重试，不影响其他考点继续监控。

### 方法 B：pm2

安装 pm2：

```bash
npm install -g pm2
```

启动：

```bash
pm2 start src/index.js --name tcf-monitor
```

查看状态：

```bash
pm2 status
```

查看日志：

```bash
pm2 logs tcf-monitor
```

保存当前进程列表：

```bash
pm2 save
```

设置开机自启动：

```bash
pm2 startup
```

运行 `pm2 startup` 后，终端会输出一条很长的命令。把那条命令复制出来再运行一次。

### 方法 C：macOS launchd

新建文件：

```bash
nano ~/Library/LaunchAgents/com.example.tcf-monitor.plist
```

填入下面内容。注意把 `/opt/homebrew/bin/node` 改成你的 Node 路径；可以用 `which node` 查看。也要把 `/path/to/my-monitor` 改成项目所在目录。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.tcf-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/my-monitor/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/my-monitor</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/path/to/my-monitor/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/my-monitor/logs/launchd.err.log</string>
</dict>
</plist>
```

加载：

```bash
launchctl load ~/Library/LaunchAgents/com.example.tcf-monitor.plist
```

停止：

```bash
launchctl unload ~/Library/LaunchAgents/com.example.tcf-monitor.plist
```

## 7. 防止 Mac 睡眠打断脚本

如果在本机长期运行，脚本需要电脑保持唤醒状态。

打开：

系统设置 → 电池 → 选项

把类似下面的选项打开：

- 接入电源时防止自动进入睡眠
- 如果有“网络访问唤醒”，也打开

如果你用的是台式机或外接电源的 MacBook，建议运行监控时一直插着电源。

## 8. 重点考点说明

### Montreal - Kuper Academy Kirkland

这是重点监控考点之一。脚本会监控 Kuper Academy 的 TCF Canada / TCFQ 页面：

- 页面：<https://www.kuperacademy.ca/en/academics/tcf-canada-tcfq-language-proficiency-testing.html>
- 地址：2975 Edmond, Kirkland, Quebec, H9H 5K5
- 监控逻辑：如果页面出现 TCF Canada / TCFQ 的日期、报名表、报名链接、可报名文字，会触发通知。

这个页面目前更像说明页，不一定有结构化考位列表，所以脚本会监控页面里和 TCF 报名相关的文本变化。

### Toronto - Spadina Campus

这是另一个重点监控考点。

- 页面：<https://www.alliance-francaise.ca/en/exams/tests/informations-about-tcf-canada/tcf-canada>
- 地址：24 Spadina Road, Toronto, ON
- 监控逻辑：默认只监控官方 TCF 页面，不再依赖 `TORONTO_REGISTER_URL`。
- 抢位建议：`TORONTO_POLL_INTERVAL_BASE=60`、`TORONTO_POLL_INTERVAL_JITTER=20`，并保持 `PLAYWRIGHT_PERSIST_SESSION=true`、`TORONTO_QUEUE_FAIR_WAIT_MS=180000`。程序会复用 Playwright profile/cookie，尽量减少每轮都重新进入 Queue-Fair；遇到排队时会多等一会儿，不在 90 秒时提前断开。

如果需要直接抓 Active Network API，可以在 `.env` 里额外填：

```bash
TORONTO_ACTIVE_API_URL=抓到的 Request URL
TORONTO_ACTIVE_API_METHOD=GET
TORONTO_ACTIVE_API_BODY=
TORONTO_ACTIVE_API_HEADERS={}
```

## 9. 常见问题

### 邮件发不出去

先运行：

```bash
node src/index.js --test
```

如果提示 `Invalid login`，通常是 Gmail 应用专用密码不对，或者 Google 账号没有开启两步验证。

### 提示缺少 `.env`

运行：

```bash
cp .env.example .env
```

然后打开 `.env` 填邮箱。

### Montreal 抓不到截图里的“添加到购物车”

Montreal 页面是动态渲染页面。程序会先试 WooCommerce API，再试 HTML，最后用 Playwright 渲染。如果日志里提示 Playwright 缺浏览器，运行：

```bash
npx playwright install chromium
```

### Montreal 邮件点进去购物车还是旧场次

Montreal 的报名按钮有时是 `/panier/#/addExamination/...` 这种“直接加入购物车”的链接。这个链接会复用当前浏览器的购物车 session；如果购物车里已经有旧场次，网站可能继续显示旧场次，清空购物车后再打开同一个链接才会加入新场次。

程序会在邮件里把主按钮指向报名列表页，并把直接加入购物车链接作为备用链接展示。实际报名前请核对邮件日期和购物车日期是否一致。

### 网站返回 429 或 5xx

程序会自动指数退避：60 秒、2 分钟、5 分钟、10 分钟。恢复正常后会回到 90 秒左右的检查间隔。

### 想重新开始快照

停止程序后删除运行数据：

```bash
rm data/snapshot-*.json data/notifications-*.json
```

再重新启动。这样程序会把下一次看到的可报名场次当成新考位。
