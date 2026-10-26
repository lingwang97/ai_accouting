"""把 tools/cloud-shared 下的公共模块复制到需要的云函数目录（云函数之间不能互相 require）。

用法：
  python tools/sync_shared.py          同步（覆盖各云函数里的副本）
  python tools/sync_shared.py --check  只比对不写，有副本缺失或与源不一致时退出码为 1（上传 / 提交前运行）
"""
import os, shutil, sys

ROOT = os.path.join(os.path.dirname(__file__), '..')
SHARED = os.path.join(ROOT, 'tools', 'cloud-shared')
TARGETS = {
    'ctx.js': ['account', 'books', 'records', 'payment', 'export', 'qrcode', 'system'],
    'plans.js': ['system', 'warmer', 'account', 'books', 'export', 'payment'],
    'purge.js': ['account', 'system'],
    'trash.js': ['books', 'warmer'],
    'limits.js': ['payment', 'renqing', 'account'],
    # 统一返回格式 / 北京时间：用到 ok、err、bjDay 的云函数
    'common.js': ['account', 'books', 'export', 'login', 'payment', 'qrcode', 'records', 'renqing', 'system', 'warmer'],
    # 记录状态与时间阈值：云函数 + 小程序 utils（前端同名模块）
    'status.js': ['account', 'books', 'export', 'payment', 'qrcode', 'records', 'renqing', 'system', 'MINI:utils'],  # ctx.js 依赖它，凡是带 ctx.js 的云函数都要有
    # 集合清单：init 与 system 上线前检查共用
    'collections.js': ['init', 'system'],
}


def dest_dir(target):
    # 'MINI:utils' 表示 miniprogram/utils，其余为云函数名
    if target.startswith('MINI:'):
        return os.path.join(ROOT, 'miniprogram', target[5:])
    return os.path.join(ROOT, 'cloudfunctions', target)


def same(a, b):
    if not os.path.exists(b):
        return False
    with open(a, 'rb') as fa, open(b, 'rb') as fb:
        return fa.read() == fb.read()


def main():
    check = '--check' in sys.argv[1:]
    bad = 0
    for name, funcs in TARGETS.items():
        src = os.path.join(SHARED, name)
        for fn in funcs:
            dst = os.path.join(dest_dir(fn), name)
            if check:
                if not same(src, dst):
                    bad += 1
                    print('MISMATCH', name, '->', fn)
            else:
                shutil.copyfile(src, dst)
                print('copied', name, '->', fn)
    if check:
        # 共享目录里有但没登记到 TARGETS 的模块也算问题（否则永远不会被同步）
        for f in sorted(os.listdir(SHARED)):
            if f.endswith('.js') and f not in TARGETS:
                bad += 1
                print('UNREGISTERED', f)
        print('sync check:', 'FAILED (%d)' % bad if bad else 'OK')
        sys.exit(1 if bad else 0)


main()
