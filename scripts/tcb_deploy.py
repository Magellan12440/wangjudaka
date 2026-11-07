#!/usr/bin/env python3
"""微信云托管发版（OpenAPI 直连）。

思路：不猜参数。先用 DescribeCloudBaseRunServer 读出线上服务的真实配置
（UploadType / Repo / Branch / DockerfilePath / 端口 / 规格），再照抄建新版本，
只改 VersionRemark。历史上吃过「凭记忆写 CreateCloudBaseRunServerVersion 参数」的亏。

用法：
  python scripts/tcb_deploy.py info           # 只看当前服务与版本状态
  python scripts/tcb_deploy.py deploy         # 从 GitHub main 构建新版本
  python scripts/tcb_deploy.py buildlog <id>  # 拉构建日志
  python scripts/tcb_deploy.py proclog <id>   # 拉运行日志

凭据来源：server/.env.local 里的 WX_APPID / WX_SECRET（换临时腾讯云密钥）。
"""
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, 'server', '.env.local')

ENV_ID = 'prod-d8gx3wb1v1c823433'
SERVER_NAME = 'express-r0ph'
REGION = 'ap-shanghai'
HOST = 'tcb.tencentcloudapi.com'
SERVICE = 'tcb'
VERSION = '2018-06-08'


def load_env():
    out = {}
    if not os.path.exists(ENV_FILE):
        return out
    with open(ENV_FILE, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip()
    return out


CACHE = os.path.join(ROOT, 'scripts', '.tcb_cred.json')


def _cache_load():
    try:
        with open(CACHE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _cache_save(d):
    try:
        with open(CACHE, 'w', encoding='utf-8') as f:
            json.dump(d, f)
    except Exception:
        pass


def wx_access_token(appid, secret):
    url = ('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
           f'&appid={appid}&secret={secret}')
    with urllib.request.urlopen(url, timeout=20) as r:
        j = json.load(r)
    if not j.get('access_token'):
        sys.exit(f'拿不到 access_token：{j}')
    return j['access_token']


def qcloud_cred(appid, secret):
    """临时腾讯云密钥。缓存到 scripts/.tcb_cred.json ——
    getqcloudtoken 有每日调用配额，反复调试会撞 45009（reach max api daily quota limit）。"""
    c = _cache_load()
    if c.get('exp', 0) > time.time() + 300 and c.get('secretid'):
        return c['secretid'], c['secretkey'], c.get('token', '')

    at = c.get('at', '')
    if not at or c.get('at_exp', 0) < time.time() + 300:
        at = wx_access_token(appid, secret)
        c['at'] = at
        c['at_exp'] = time.time() + 7000

    req = urllib.request.Request(
        f'https://api.weixin.qq.com/tcb/getqcloudtoken?access_token={at}',
        data=json.dumps({'lifespan': 7200}).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        j = json.load(r)
    if not j.get('secretid'):
        if c.get('secretid') and c.get('exp', 0) > time.time():
            print('⚠️  配额受限，沿用缓存中的未过期密钥')
            return c['secretid'], c['secretkey'], c.get('token', '')
        sys.exit(f'拿不到临时腾讯云密钥：{j}')
    c.update({
        'secretid': j['secretid'],
        'secretkey': j['secretkey'],
        'token': j.get('token', ''),
        'exp': time.time() + 6900,
    })
    _cache_save(c)
    return c['secretid'], c['secretkey'], c['token']


def _h(s):
    return hashlib.sha256(s.encode()).hexdigest()


def _hmac(key, msg):
    """返回二进制摘要 —— 密钥派生链必须用 digest 而不是 hexdigest，否则签名必错。"""
    if isinstance(key, str):
        key = key.encode()
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def call(action, payload, cred, timeout=60):
    secret_id, secret_key, token = cred
    ts = int(time.time())
    date = time.strftime('%Y-%m-%d', time.gmtime(ts))
    body = json.dumps(payload, separators=(',', ':'))
    ct = 'application/json; charset=utf-8'

    canonical_headers = f'content-type:{ct}\nhost:{HOST}\n'
    signed_headers = 'content-type;host'
    canonical = f'POST\n/\n\n{canonical_headers}\n{signed_headers}\n{_h(body)}'
    to_sign = f'TC3-HMAC-SHA256\n{ts}\n{date}/{SERVICE}/tc3_request\n{_h(canonical)}'
    kd = _hmac('TC3' + secret_key, date)
    ks = _hmac(kd, SERVICE)
    kk = _hmac(ks, 'tc3_request')
    sig = hmac.new(kk, to_sign.encode(), hashlib.sha256).hexdigest()

    auth = (f'TC3-HMAC-SHA256 Credential={secret_id}/{date}/{SERVICE}/tc3_request, '
            f'SignedHeaders={signed_headers}, Signature={sig}')
    headers = {
        'Authorization': auth,
        'Content-Type': ct,
        'Host': HOST,
        'X-TC-Action': action,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': str(ts),
        'X-TC-Region': REGION,
    }
    if token:
        headers['X-TC-Token'] = token

    req = urllib.request.Request(f'https://{HOST}', data=body.encode(), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)['Response']
    except urllib.error.HTTPError as e:
        return {'Error': {'Code': f'HTTP{e.code}', 'Message': e.read().decode()[:300]}}


def show(res):
    if 'Error' in res:
        print('❌ API 报错：', json.dumps(res['Error'], ensure_ascii=False))
        return False
    return True


def pick(d, *names, default=None):
    for n in names:
        if isinstance(d, dict) and d.get(n) not in (None, '', []):
            return d[n]
    return default


def cmd_info(cred):
    srv = call('DescribeCloudBaseRunServer', {
        'EnvId': ENV_ID, 'ServerName': SERVER_NAME, 'Limit': 10, 'Offset': 0,
    }, cred)
    if not show(srv):
        return 1
    print('服务名   :', srv.get('ServerName'))
    print('镜像仓库 :', srv.get('ImageRepo'))
    print('来源类型 :', srv.get('SourceType'))
    print('版本总数 :', srv.get('TotalCount'))
    print('版本列表（版本 / 流量比 / 状态 / 构建方式 / 备注）:')
    for v in (srv.get('VersionItems') or []):
        print(f"  - {v.get('VersionName')} | 流量 {v.get('FlowRatio')}% | {v.get('Status')} "
              f"| {v.get('UploadType')} | {v.get('Remark') or ''}")
        print(f"      副本 {v.get('CurrentReplicas')} (min {v.get('MinReplicas')}/max {v.get('MaxReplicas')}) "
              f"BuildId={v.get('BuildId')} RunId={v.get('RunId')}")
    return 0


def cmd_deploy(cred):
    srv = call('DescribeCloudBaseRunServer', {'EnvId': ENV_ID, 'ServerName': SERVER_NAME, 'Limit': 10, 'Offset': 0}, cred)
    if not show(srv):
        return 1
    s = srv.get('Server', {})
    upload_type = pick(s, 'UploadType', default='repository')
    repo = pick(s, 'Repo', 'Repository')
    branch = pick(s, 'Branch', default='main')
    dockerfile = pick(s, 'DockerfilePath')
    build_dir = pick(s, 'BuildDir')

    print(f'沿用线上配置：type={upload_type} repo={repo} branch={branch} '
          f'dockerfile={dockerfile} buildDir={build_dir}')

    payload = {
        'EnvId': ENV_ID,
        'ServerName': SERVER_NAME,
        'UploadType': upload_type,
        'VersionRemark': f'v{json.load(open(os.path.join(ROOT, "server", "package.json"), encoding="utf-8"))["version"]} 云存储',
        'ContainerPort': s.get('ContainerPort') or 80,
        'Cpu': s.get('Cpu') or 0.25,
        'Mem': s.get('Mem') or 0.5,
        'MinNum': s.get('MinNum') if s.get('MinNum') is not None else 0,
        'MaxNum': s.get('MaxNum') or 1,
        'IsPublic': True,
    }
    if upload_type == 'repository':
        if not repo:
            print('❌ 服务未配置代码仓库，无法从仓库构建')
            return 1
        payload['Repository'] = repo
        payload['Branch'] = branch
        if dockerfile:
            payload['DockerfilePath'] = dockerfile
        if build_dir:
            payload['BuildDir'] = build_dir
        payload['CodeDetail'] = json.dumps({
            'Repo': repo, 'Branch': branch,
            **({'DockerfilePath': dockerfile} if dockerfile else {}),
            **({'BuildDir': build_dir} if build_dir else {}),
        })
    else:
        img = pick(s, 'ImageUrl')
        if not img:
            print('❌ 服务既非仓库构建也无镜像地址，无法发版')
            return 1
        payload['ImageInfo'] = {'ImageUrl': img}

    res = call('CreateCloudBaseRunServerVersion', payload, cred, timeout=90)
    if not show(res):
        print('提交的参数：', json.dumps(payload, ensure_ascii=False))
        return 1
    vid = pick(res, 'RunId', 'VersionName', 'BuildId')
    print('✅ 已提交构建，版本 ID :', vid)
    print('   后续：python scripts/tcb_deploy.py buildlog', vid)
    return 0


def cmd_buildlog(cred, vid):
    for i in range(60):
        res = call('DescribeCloudBaseRunBuildLog', {
            'EnvId': ENV_ID, 'ServerName': SERVER_NAME, 'RunId': vid,
        }, cred)
        if not show(res):
            return 1
        status = pick(res, 'Status', 'BuildStatus')
        logs = pick(res, 'BuildLog', 'Log', default='')
        tail = '\n'.join(str(logs).splitlines()[-12:])
        print(f'[{i}] 状态={status}')
        if tail:
            print(tail)
        if str(status).lower() in ('success', 'succeeded', 'finish', 'finished'):
            print('✅ 构建成功')
            return 0
        if str(status).lower() in ('failed', 'failure', 'error'):
            print('❌ 构建失败')
            return 1
        time.sleep(10)
    print('⌛ 超时未结束，可稍后重跑 buildlog')
    return 1


def cmd_proclog(cred, vid):
    res = call('DescribeCloudBaseRunProcessLog', {
        'EnvId': ENV_ID, 'ServerName': SERVER_NAME, 'RunId': vid, 'Limit': 100,
    }, cred)
    if not show(res):
        return 1
    for line in (res.get('LogList') or []):
        print(line)
    return 0


def main():
    env = load_env()
    appid, secret = env.get('WX_APPID', ''), env.get('WX_SECRET', '')
    if not appid or not secret:
        sys.exit('server/.env.local 缺 WX_APPID / WX_SECRET')
    cred = qcloud_cred(appid, secret)

    cmd = sys.argv[1] if len(sys.argv) > 1 else 'info'
    if cmd == 'info':
        return cmd_info(cred)
    if cmd == 'deploy':
        return cmd_deploy(cred)
    if cmd == 'buildlog':
        return cmd_buildlog(cred, sys.argv[2])
    if cmd == 'proclog':
        return cmd_proclog(cred, sys.argv[2])
    sys.exit(f'未知命令：{cmd}')


if __name__ == '__main__':
    sys.exit(main() or 0)
