# 网剧大咖 · 部署手册

> 服务端零第三方运行时依赖（只要求 **Node ≥ 22**），所以部署只有三件事：
> **拷代码 → 填 `.env` → 起进程**。数据是 JSON 文件，落在 `DATA_DIR` 里，备份就是拷贝目录。

---

## 0. 包里有什么

```
wangju-daka-<版本>/
├── Dockerfile                 镜像构建（node:22-alpine，不需要 npm install）
├── docker-compose.yml         一键起服务
├── deploy/
│   ├── README.md              本文件
│   ├── env.production.example 生产环境变量模板
│   ├── nginx/wangjudaka.conf  HTTPS 反向代理
│   └── systemd/wangjudaka.service  开机自启 + 崩溃拉起
├── server/
│   ├── package.json
│   ├── .env.example           全量变量说明（含可选项）
│   └── src/                   业务代码
└── web/                       PC 工作台 + 管理后台静态页
```

**包里没有**：`node_modules`（不需要）、`tests/`、`scripts/`、`data/`、`.env`、任何 `.key`。
拿到包的人解压后填自己的 `.env` 就能跑，拿不到任何凭据。

---

## 1. 两条路线怎么选

| 你的机器 | 选哪条 | 为什么 |
|---|---|---|
| 有 Docker（云主机基本都能装） | **路线 A** | 不用装 Node、不用担心版本，升级只要 `pull + up -d` |
| 干净的 Linux 云主机 | **路线 B** | 不装 Docker 也能跑，systemd 托管，日志进 journald |
| Windows / 群晖 | 路线 A（Docker Desktop） | 裸机 Windows 服务化比较折腾，不建议 |

两条路线对外都必须再套一层 **Nginx + HTTPS**，原因见第 4 节。

---

## 2. 路线 A：Docker

```bash
# 1) 解包
tar -xzf wangju-daka-4.1.1.tar.gz
cd wangju-daka-4.1.1

# 2) 填生产配置（这份文件就是服务器钥匙串，别提交、别截图）
cp deploy/env.production.example server/.env
chmod 600 server/.env
vi server/.env        # 至少要填：ADMIN_TOKEN / SESSION_SECRET / WX_SECRET / RELAY_API_KEY

# 3) 起服务
docker compose up -d --build

# 4) 验收
curl -s http://127.0.0.1:8787/health
```

看到 `{"ok":true,...,"version":"4.1.1"}` 就成了。

常用命令：

```bash
docker compose logs -f --tail=100   # 看日志
docker compose restart              # 重启
docker compose down                 # 停止（数据在 server/data，不会丢）
docker compose up -d --build        # 改了代码后重建
```

> 端口只绑了 `127.0.0.1:8787`，公网访问不到——这是故意的，外网入口只留 Nginx。

---

## 3. 路线 B：裸机 systemd + Nginx

```bash
# 1) 装 Node 22（Debian/Ubuntu，NodeSource 官方源）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v            # 必须 v22.x

# 2) 放代码
mkdir -p /opt/wangju-daka /var/lib/wangju-daka
tar -xzf wangju-daka-4.1.1.tar.gz -C /opt/wangju-daka --strip-components=1

# 3) 专用账号 + 目录权限
useradd --system --home /opt/wangju-daka --shell /usr/sbin/nologin wangju
chown -R wangju:wangju /opt/wangju-daka /var/lib/wangju-daka

# 4) 生产配置
cp /opt/wangju-daka/deploy/env.production.example /opt/wangju-daka/server/.env
chmod 600 /opt/wangju-daka/server/.env
chown wangju:wangju /opt/wangju-daka/server/.env
vi /opt/wangju-daka/server/.env    # DATA_DIR 保持 /var/lib/wangju-daka，HOST 保持 127.0.0.1

# 5) systemd
cp /opt/wangju-daka/deploy/systemd/wangjudaka.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wangju-daka

# 6) 验收
systemctl status wangju-daka --no-pager
curl -s http://127.0.0.1:8787/health
journalctl -u wangju-daka -f --no-pager   # 看日志
```

> `HOST=127.0.0.1` 表示只允许本机访问，外部必须经 Nginx；如果你先想用公网 IP 直接试，
> 临时改成 `HOST=0.0.0.0` 并放行安全组端口，验收完记得改回来。

---

## 4. HTTPS 证书（两条路线都要）

微信小程序的 `request` 合法域名**只接受 https**，且要求证书由受信任 CA 签发、TLS ≥ 1.2。
所以 Nginx 不是可选项。

```bash
# 1) 装 Nginx 与 certbot
apt install -y nginx certbot python3-certbot-nginx

# 2) 放反代配置（先把域名换成你的）
cp /opt/wangju-daka/deploy/nginx/wangjudaka.conf /etc/nginx/conf.d/
vi /etc/nginx/conf.d/wangjudaka.conf     # server_name 与证书路径两处

# 3) 签证书（certbot 会自动改配置、加续期定时器）
certbot --nginx -d api.example.com

# 4) 校验并重载
nginx -t && systemctl reload nginx
certbot renew --dry-run        # 确认自动续期可用
```

签完访问 `https://api.example.com/health` 应当返回同样的 JSON。

> **域名必须已 ICP 备案**，否则微信后台填不进 request 合法域名，备案周期通常 3–20 个工作日。
> 只是自己内测可以先跳过：用开发者工具的「预览」二维码走局域网地址，不需要域名。

---

## 5. 把域名接进小程序

1. 微信公众平台 → **开发管理 → 开发设置 → 服务器域名** → request 合法域名，填 `https://api.example.com`
2. 把同一个域名写进小程序配置——**只需要改一个文件**：

```js
// miniprogram/config.js
const HOSTS = {
  develop: 'http://192.168.x.x:8787',      // 局域网联调，手机与电脑同一 WiFi
  trial:   'https://api.example.com',      // 体验版
  release: 'https://api.example.com',      // 正式版
};
```

3. 重新上传一版代码（`npm run mini:upload`），后台「选为体验版」或「提交审核」

> `config.js` 会按 `wx.getAccountInfoSync().miniProgram.envVersion` 自动选地址，
> 体验版/正式版如果仍指向占位域名，小程序启动时会弹窗提示，不会静默白屏。

---

## 6. 部署验收（4 条命令，一条都别省）

```bash
# 1) 进程活着，版本对得上
curl -s https://api.example.com/health

# 2) 静态页能出来（PC 工作台）
curl -s -o /dev/null -w "%{http_code}\n" https://api.example.com/index.html

# 3) 管理后台门禁生效（没带令牌应当是 401/403，不是 200 页面数据）
curl -s -o /dev/null -w "%{http_code}\n" https://api.example.com/api/admin/overview

# 4) 数据目录真的在写（建个项目，看文件是否出现）
curl -s -X POST https://api.example.com/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"userId":"deploy_probe","title":"部署验收"}'
ls -l <DATA_DIR>/projects.json
```

第 4 条最容易被忽略：**如果 `DATA_DIR` 指向容器内非挂载路径，数据会在容器重建时全部消失**。
Docker 路线务必确认 `docker compose exec api ls /data` 能看到 `projects.json`。

---

## 7. 数据在哪 / 备份 / 恢复

| 路线 | 数据目录 |
|---|---|
| Docker | 宿主机 `./server/data`（挂到容器 `/data`） |
| 裸机 | `/var/lib/wangju-daka` |

目录里是一堆 `<集合名>.json`：`users` / `projects` / `ledger` / `blueprint_runs` / `recharge_packages` ……
写入是「先写 `.tmp` 再 rename」，所以任何时刻拷走的文件都是完整的，不会拷到半截 JSON。

**备份（建议每日，保留 14 天）**

```bash
tar -czf /backup/wangju-$(date +%F).tar.gz -C /var/lib/wangju-daka .
# Docker 路线把 -C 换成 /opt/wangju-daka/server/data
```

**恢复**

```bash
systemctl stop wangju-daka            # Docker: docker compose stop
tar -xzf /backup/wangju-2026-11-05.tar.gz -C /var/lib/wangju-daka
chown -R wangju:wangju /var/lib/wangju-daka
systemctl start wangju-daka
```

> 服务退出时会 `flush()` 把内存里待写的变更落盘（收到 SIGTERM 也走这条路），
> 所以正常停服再备份是最稳的；直接 `kill -9` 有极小概率丢最后 50ms 的写入。

---

## 8. 升级与回滚

```bash
# 升级：解新包 → 覆盖代码 → 保留 .env 与 data
tar -xzf wangju-daka-4.3.0.tar.gz
rsync -a --exclude 'server/.env' --exclude 'server/data' wangju-daka-4.3.0/ /opt/wangju-daka/
systemctl restart wangju-daka
curl -s http://127.0.0.1:8787/health     # 确认 version 变了
```

回滚就是把上一个版本的包同样覆盖回去再重启。**升级前先备份数据目录**——代码可以回退，数据不能。

---

## 9. 排错对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `curl` 连不上 8787 | `HOST=127.0.0.1` 且没走 Nginx | 本地用 127.0.0.1 访问，或临时改 `HOST=0.0.0.0` |
| Nginx 502 | 后端没起来 / 端口不对 | `systemctl status wangju-daka`、`ss -lntp \| grep 8787` |
| 小程序真机白屏，开发者工具正常 | request 域名没配 / 证书不被信任 / 域名未备案 | 后台加 request 合法域名；`curl -v` 看证书链 |
| 请求 60 秒就断 | Nginx 默认 `proxy_read_timeout 60s`，生成接口要几分钟 | 用本包提供的 nginx 配置（已设 600s） |
| 重启后用户全要重新登录 | `SESSION_SECRET` 没固定 | 填一个固定的随机串（`openssl rand -hex 32`） |
| 管理后台 403 | `ADMIN_TOKEN` 为空或输错 | `.env` 里设值后重启；令牌只存浏览器当前标签页 |
| 数据在容器重建后消失 | `DATA_DIR` 没挂载到宿主机 | 确认 compose 的 `volumes: ./server/data:/data` |
| 上传图片报 413 | Nginx 默认 1MB | 本包配置已设 `client_max_body_size 25m` |
| 启动日志报种子自检失败 | 包不完整（漏拷 `server/src/seeds`） | 重新完整解包，不要手工挑文件 |

---

## 10. 安全红线

1. `server/.env` 权限 600，属主是运行账号；**不要**放进 web 目录、不要提交到代码库。
2. `ADMIN_TOKEN` 必须是非空强随机（`openssl rand -hex 24`）；空令牌等于后台关闭，这是有意的默认。
3. 管理后台建议在 Nginx 再加 IP 白名单（配置里有注释好的 `location = /admin.html` 段落）。
4. 8787 端口不要直接暴露公网，统一经 Nginx；`docker-compose.yml` 已绑 `127.0.0.1`。
5. 反向代理会传 `X-Forwarded-For`，但服务端限流/风控按来源 IP 记账时以 Nginx 为准。
6. 定期 `certbot renew --dry-run`，证书过期会直接导致小程序所有请求失败。
7. 备份里含用户 openid 与账本流水，属于个人信息，备份文件也要按敏感数据管理。

---

## 11. 部署到微信云托管（容器）

不想自己维护服务器时，可以直接用微信云托管。完整步骤见
[`docs/微信云托管部署.md`](../docs/微信云托管部署.md)，三条要点：

1. **模板选「Node.js 自定义 / Dockerfile 构建」**，不要选 Express / Koa / NestJS 模板——
   本项目零第三方运行时依赖，入口是 `server/src/index.js`，框架模板的依赖和入口全是多余的。
2. **容器端口 80**（控制台环境变量 `PORT=80`，镜像里默认 8787 会被覆盖），健康检查 `GET /health`。
3. **文件存储挂到 `/data`，且最大实例数锁 1**——JSON 持久化是「整文件覆盖写」，多实例会互相覆盖数据。

根目录 `container.config.json` 已按上述写好，云托管建版本时自动读取。
