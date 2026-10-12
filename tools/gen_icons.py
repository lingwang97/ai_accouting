"""生成 tabBar 图标（81x81 透明底 PNG），4 倍超采样抗锯齿。
用法：python tools/gen_icons.py
"""
import os
from PIL import Image, ImageDraw

S = 81            # 输出尺寸（微信推荐 81x81）
K = 4             # 超采样倍数
W = 6 * K         # 线宽
OUT = os.path.join(os.path.dirname(__file__), '..', 'miniprogram', 'assets')

GRAY = (153, 153, 153, 255)
GREEN = (7, 193, 96, 255)


def canvas():
    img = Image.new('RGBA', (S * K, S * K), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def p(*xy):
    """81 坐标系 -> 超采样坐标"""
    return [v * K for v in xy]


def home(d, c):
    # 屋顶 + 房身 + 门
    d.line(p(10, 38, 40.5, 12, 71, 38), fill=c, width=W, joint='curve')
    d.rounded_rectangle(p(18, 34, 63, 69), radius=4 * K, outline=c, width=W)
    d.rounded_rectangle(p(34, 48, 47, 69), radius=2 * K, outline=c, width=W)


def record(d, c):
    # 账本 + 三行条目
    d.rounded_rectangle(p(16, 10, 65, 71), radius=7 * K, outline=c, width=W)
    for y in (27, 40.5, 54):
        d.ellipse(p(25, y - 3, 31, y + 3), fill=c)
        d.line(p(37, y, 56, y), fill=c, width=W)


def printer(d, c):
    # 纸张 + 机身 + 出纸
    d.rectangle(p(24, 10, 57, 28), outline=c, width=W)
    d.rounded_rectangle(p(10, 28, 71, 56), radius=6 * K, outline=c, width=W)
    d.rectangle(p(24, 46, 57, 71), outline=c, width=W)
    d.line(p(31, 56, 50, 56), fill=c, width=W // 2 * 1)
    d.line(p(31, 63, 45, 63), fill=c, width=W // 2 * 1)
    d.ellipse(p(59, 35, 64, 40), fill=c)


def mine(d, c):
    # 头 + 肩
    d.ellipse(p(26, 10, 55, 39), outline=c, width=W)
    d.arc(p(12, 44, 69, 100), start=180, end=360, fill=c, width=W)


def avatar(d, _):
    # 默认头像：浅灰底 + 白色人形
    d.ellipse(p(0, 0, 81, 81), fill=(225, 225, 225, 255))
    d.ellipse(p(27, 16, 54, 43), fill=(255, 255, 255, 255))
    d.pieslice(p(14, 48, 67, 101), start=180, end=360, fill=(255, 255, 255, 255))


def save(name, fn, color):
    img, d = canvas()
    fn(d, color)
    img = img.resize((S, S), Image.LANCZOS)
    img.save(os.path.join(OUT, name), optimize=True)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for key, fn in (('home', home), ('record', record), ('print', printer), ('mine', mine)):
        save(f'tab-{key}.png', fn, GRAY)
        save(f'tab-{key}-on.png', fn, GREEN)
    save('avatar-default.png', avatar, None)
    print('icons ->', os.path.abspath(OUT))
