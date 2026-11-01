"""生成「示意图字体预览」用的小子集字体（v3.83.0）：从 tools/fonts 的三份导出字体里再裁出约 800 个常用字。

用法：python tools/gen_preview_fonts.py      -> tools/fonts/preview/*.ttf
      python tools/gen_font_js.py --preview  -> cloudfunctions/fontsetup/pvfont-*.js（base64，不入库）
再部署 fontsetup，管理员页「上线前检查」点「上传预览字体」，字体会传到云存储 preview-fonts/ 并登记 settings.preview_fonts。

字符集（与所选字体的字库取交集，字库里没有的字自动略过）：
  百家姓常用单字、常见人名用字、数字与标点、礼簿 / 奠仪簿 / 回执用语（含「囍」，宋体字库里有，黑体和毛笔体本来就没有）。
示意图里没覆盖到的生僻字回退为系统字体，导出的 PDF 不受影响。字体授权见 tools/fonts/OFL-*.txt（SIL OFL 1.1）。
"""
import os
from fontTools import subset
from fontTools.ttLib import TTFont

root = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(root, 'fonts')
OUT = os.path.join(SRC, 'preview')

SURNAMES = ('王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'
            '常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚郎')
NAMES = ('伟芳娜敏静丽强磊军洋勇艳杰涛明超秀霞平刚桂英华玲燕红梅莉琳萍鹏辉慧健婷宇浩凯晨欣悦子轩涵萱怡佳雪蕾倩彤颖思琪梦瑶诗雨航博文俊豪宁昊翔鑫飞斌亮波'
         '建国志远永福寿康德忠孝仁义礼智信玉珍凤珠兰菊莲荷桃杏春夏秋冬山川海河湖江松柏竹荣光耀辰阳旭东南西北天地人和顺泰安乐昌盛兴隆林森木水火土金银铜铁'
         '小大老少男女先生女士夫妻父母爷奶哥姐弟妹叔姨舅姑婶伯兄嫂儿孙宝贝新郎娘亲友同事邻里学朋'
         '一二三四五六七八九十百千万零壹贰叁肆伍陆柒捌玖拾佰仟元角分整'
         '年月日时分秒号点上下午早晚今昨明')
TERMS = ('礼簿奠仪簿传统主家日期地点慧礼记账人签字封面内页封底姓名金额备注合计共份微信现金转账收到谢谢感谢光临承蒙厚爱谨致谢忱'
         '婚礼喜事寿宴满月周岁乔迁白事其他开业庆典聚会酒店饭店宴会厅大酒楼家中'
         '百年好合琴瑟和鸣福寿安康松鹤延年福泽绵长乔迁大吉沉痛哀悼深切缅怀音容宛在永远怀念千古贺囍喜寿福奠'
         '李明与王芳张三四赵丽欧阳月示例预览序号合页第共本场次礼台人员')
EXTRA = ('琴云霏雯婉茜蓉菲琼巧妍媛珊欢彦楠赫哲睿熙瑞祺锦轶淇潇骏珂致琛逸铭谦廷帆煜贤圣瀚澄泽源洁清淑贞莹旋露婕昕曦曼璐骁奕沛彬翰晗朗霖皓璟瑾槿萌蕊芸芝茹莎荟薇蓓蓉岚峰崇嵩巍岩瑜瑛珏琦琪琰璇璨瓒珑玮玥珺钰钊铮铎锋锐镇雄雅雯霄霆震靖韬颂颐颢飒骞骅驰鸿鹤鹭麒麟黛黎龄龙堃堂坤垚培基堰壮奇奋妙姝姿娟娅婧媚嫣宏宜宣宪宸寅密寒寰尧岑峻嵘幸庭康廉彰彩影径律徽忆怀恒恬惠愉慕憬戈戎昂昊昱晟晖晴智曜朔朋杉杨杰松枫柏柔桐桑楚榆榕樱檀欧歆歌洛洲济浚浦涓淳渊渝湘溪滢漫潮澜灿炅炫烁烨焱煊熠燃爽琳瑄'
         '版本权限导出保存预览确认取消完成复位缩放字体装订水印纹样照片尺寸比例')
PUNCT = '0123456789 .,:;·-—_/()（）：；，。、！？￥￥￥“”‘’…《》【】+×=*%#@&~'
CHARS = sorted(set(SURNAMES + NAMES + TERMS + EXTRA + PUNCT) | {chr(c) for c in range(0x20, 0x7f)})

FONTS = [
    ('NotoSansSC-Subset.ttf', 'NotoSansSC-Preview.ttf'),
    ('NotoSerifSC-Subset.ttf', 'NotoSerifSC-Preview.ttf'),
    ('MaShanZheng-Subset.ttf', 'MaShanZheng-Preview.ttf'),
]

os.makedirs(OUT, exist_ok=True)
for src, dst in FONTS:
    path = os.path.join(SRC, src)
    cmap = TTFont(path).getBestCmap()
    keep = [c for c in CHARS if ord(c) in cmap]
    opts = subset.Options()
    opts.layout_features = []      # 预览不需要排版特性
    opts.hinting = False
    opts.notdef_outline = True
    opts.name_IDs = [1, 2, 3, 4, 6]
    opts.glyph_names = False
    opts.drop_tables += ['DSIG', 'GSUB', 'GPOS', 'GDEF', 'kern', 'vhea', 'vmtx', 'STAT', 'gasp', 'MATH']
    font = TTFont(path)
    sub = subset.Subsetter(opts)
    sub.populate(text=''.join(keep))
    sub.subset(font)
    out = os.path.join(OUT, dst)
    font.save(out)
    has = lambda ch: ord(ch) in TTFont(out).getBestCmap()
    print(dst, os.path.getsize(out), 'bytes,', len(keep), 'chars, 囍:', has('囍'), '喜:', has('喜'))
    if dst.startswith('NotoSerif'):
        assert has('囍'), '宋体预览子集必须包含「囍」'
