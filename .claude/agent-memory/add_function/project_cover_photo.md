---
name: project-cover-photo
description: v3.79.0 传统礼簿封面照片+10款矢量纹样（books.coverPhoto、pdfTheme.deco），白事不放照片；1C 整页照片为待评估增强
metadata:
  type: project
---

用户选 一A 二A 三A 四A 五A：框内照片（圆角方框/椭圆，左图右文，服务端 clip+cover 居中裁剪）、白事不提供照片只给松枝/白菊、先全免费预留 features.coverPhoto。提交 123023e（v3.79.0），已部署 books/export/account/system/warmer，未上传。

- 数据：books.coverPhoto={fileID,shape}（独立于 pdfTheme，因导出保存主题用 _.set 会覆盖）；pdfTheme.deco；文件 covers/book-{openid}-{ts}.jpg，ownCover 在 tools/cloud-shared/paycode.js。
- 清理挂靠 trash.filesOf、purge.fileIds。list 只返回 {shape}，预览走 coverPhotoUrl 临时链接。
- 样张/测试方法：tests/helpers/sdk-stub 的 loadFunction('export')._test.buildMeta/buildBook + fonts.planFor.resolve({buffers,failed:{}})，pymupdf 转图看。
- 踩坑：Bash heredoc 里的反斜杠会被减半（写正则/转义用 Write 工具写脚本）；假库 doc().update 不记录，测试里要包一层 db.collection。
**Why:** 封面是礼簿门面，办完事会存档打印。
**How to apply:** 1C 整页照片版式若做，作为第三种 layout 复用 drawPhoto/PHOTO_BOX 的结构；白事仍不提供。

- v3.80.0 (3e7d208)：整页版式 layout full、scrim gradient/block、focus 九宫格、coverPrint 单次 keep/fade/none、照片 1.5MB；默认值不落库；已部署 books/export，未上传。

- v3.81.0：导出页重组（三标签、草稿统一保存、saveOnly、覆盖项 coverShape/Layout/Scrim/Focus、导出确认面板放打印方式）。已部署 export，未上传。

- v3.82.0：水印移内页；crop {x,y,z}+cropGeom 前后端共用，裁剪编辑器自写 touch 手势；旧 focus 读取映射。已部署 books/export，未上传。

- v3.83.0：预览小字体(pvfont, settings.preview_fonts, export.fontPreview)+会员字体试看+囍字矢量纹样(xipath.js)；已部署 export/system/fontsetup，需管理员页上传预览字体；喜事默认纹样=shuangxi。
