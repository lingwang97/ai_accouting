"""把 tools/cloud-shared 下的公共模块复制到需要的云函数目录（云函数之间不能互相 require）。

用法：python tools/sync_shared.py
"""
import os, shutil

ROOT = os.path.join(os.path.dirname(__file__), '..')
SHARED = os.path.join(ROOT, 'tools', 'cloud-shared')
TARGETS = {
    'ctx.js': ['account', 'books', 'records', 'payment', 'export', 'qrcode', 'system'],
    'plans.js': ['system', 'warmer', 'account'],
    'purge.js': ['account', 'system'],
    'trash.js': ['books', 'warmer'],
}

for name, funcs in TARGETS.items():
    for fn in funcs:
        dst = os.path.join(ROOT, 'cloudfunctions', fn, name)
        shutil.copyfile(os.path.join(SHARED, name), dst)
        print('copied', name, '->', fn)
