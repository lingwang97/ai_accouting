"""生成完整 GBK 编码表 miniprogram/utils/gbk-table.js（Unicode 码点 -> GBK 双字节值）。

覆盖 GBK 全部双字节区（约 2.1 万字，含"喆、堃、昇"等 GB2312 外常见姓名用字）。
用法：python tools/gen_gbk.py
"""
import os

table = {}
for lead in range(0x81, 0xFF):
    for trail in range(0x40, 0xFF):
        if trail == 0x7F:
            continue
        try:
            ch = bytes([lead, trail]).decode('gbk')
        except UnicodeDecodeError:
            continue
        if len(ch) != 1:
            continue
        cp = ord(ch)
        if cp >= 0x80 and cp not in table:
            table[cp] = (lead << 8) | trail

out = os.path.join(os.path.dirname(__file__), '..', 'miniprogram', 'utils', 'gbk-table.js')
body = ','.join(f'{cp}:{v}' for cp, v in sorted(table.items()))
with open(out, 'w', encoding='utf-8') as f:
    f.write('/* GBK 完整编码表：Unicode 码点 -> GBK 双字节值（tools/gen_gbk.py 自动生成，勿手改） */\n')
    f.write('module.exports = {' + body + '};\n')
print(len(table), 'chars ->', os.path.getsize(out), 'bytes')
