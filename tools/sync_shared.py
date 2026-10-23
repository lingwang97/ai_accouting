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
    'plans.js': ['system', 'warmer', 'account'],
    'purge.js': ['account', 'system'],
    'trash.js': ['books', 'warmer'],
    'limits.js': ['payment', 'renqing', 'account'],
}


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
            dst = os.path.join(ROOT, 'cloudfunctions', fn, name)
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
