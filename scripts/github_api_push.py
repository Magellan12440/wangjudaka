#!/usr/bin/env python3
"""通过 GitHub REST API 把当前 git 工作树整体推送为远端 main 分支的单个提交。
用途：沙箱代理只放行 api.github.com，git 协议被拦时的备用推送通道。
用法：GITHUB_TOKEN=xxx python scripts/github_api_push.py
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

REPO = "Magellan12440/wangjudaka"
API = "https://api.github.com"
TOKEN = os.environ.get("GITHUB_TOKEN", "")
if not TOKEN:
    sys.exit("需要 GITHUB_TOKEN 环境变量")

ROOT = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
MSG = "v4.5.1: 收益看板改按earnings账聚合(修已结算恒为0/平台全落unknown) + 多平台批量回填 + 待回填清单 + 额度预警 + 本月对账单CSV导出 + 13条收益回归"


def api(method, path, payload=None, retries=3):
    url = f"{API}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "wangjudaka-push")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:200]
            # 速率限制或临时错误才重试；422/404 直接抛
            if e.code in (403, 429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"{method} {path} -> {e.code}: {body}")
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"{method} {path} -> {e}")


files = subprocess.check_output(
    ["git", "-c", "core.quotepath=false", "ls-files"], cwd=ROOT, text=True, encoding="utf-8"
).splitlines()
print(f"待上传文件: {len(files)}")

# 空仓库的 git/blobs 接口会 409，先用 contents API 放一个 README 完成初始化
try:
    api("GET", f"/repos/{REPO}/git/refs/heads/main")
    print("远端已有 main，直接增量推送")
except SystemExit:
    readme = "# 网剧大咖\n\nAI 漫剧一句话生成微信小程序。初始化提交，完整代码随后推送。\n"
    api("PUT", f"/repos/{REPO}/contents/README.md", {
        "message": "init",
        "content": base64.b64encode(readme.encode()).decode(),
        "branch": "main",
    })
    print("空仓库已用 README 初始化")

tree_items = []
for idx, rel in enumerate(files, 1):
    fp = os.path.join(ROOT, rel.replace("/", os.sep))
    with open(fp, "rb") as f:
        raw = f.read()
    blob = api("POST", f"/repos/{REPO}/git/blobs", {
        "content": base64.b64encode(raw).decode(),
        "encoding": "base64",
    })
    mode = "100755" if os.access(fp, os.X_OK) else "100644"
    tree_items.append({"path": rel, "mode": mode, "type": "blob", "sha": blob["sha"]})
    if idx % 20 == 0 or idx == len(files):
        print(f"  blob {idx}/{len(files)}")

# 树太大可能超 POST 限制，分两层也无所谓，但 200 个文件一棵树没问题
tree = api("POST", f"/repos/{REPO}/git/trees", {"tree": tree_items})
print("tree:", tree["sha"][:12])

# 以远端当前 main 为父提交，保持历史线性
parent_sha = None
try:
    parent_sha = api("GET", f"/repos/{REPO}/git/refs/heads/main")["object"]["sha"]
except SystemExit:
    pass

commit = api("POST", f"/repos/{REPO}/git/commits", {
    "message": MSG,
    "tree": tree["sha"],
    "parents": [parent_sha] if parent_sha else [],
    "author": {"name": "wangjudaka", "email": "noreply@wangjudaka.local"},
})
print("commit:", commit["sha"][:12])

if parent_sha:
    api("PATCH", f"/repos/{REPO}/git/refs/heads/main", {"sha": commit["sha"], "force": True})
    print("updated refs/heads/main")
else:
    api("POST", f"/repos/{REPO}/git/refs", {"ref": "refs/heads/main", "sha": commit["sha"]})
    print("created refs/heads/main")

print(f"OK -> https://github.com/{REPO}")
