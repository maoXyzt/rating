# 图片评分平台

## 一键启动

```bash
docker compose up --build -d
```

打开 `http://localhost:8080`。SQLite 数据文件和上传图片均使用 Docker volume 持久化。

## 使用流程

1. 在“管理”页上传 ZIP。每个 ZIP 会创建一个独立的“主体”。
2. 管理页的图包列表中点击“查看图片”，进入图包明细表；可按目录分类筛选，也可以多选评分标准，为每个标准设置 1–10 分范围后应用筛选。
3. 回到“打分”页，在右上角选择 ZIP 主体；左侧按该主体的目录和评分状态筛选，右侧显示对应图片。
4. 点击图片评分，结果会直接写回这条图片记录。

SQLite 数据文件默认位于 `server/data/image-rating.sqlite`，Docker 下会挂载到 `/app/data/image-rating.sqlite`。开发时不需要单独启动数据库。

ZIP 内目录示例：

```text
本次数据.zip
├─ 艺术类/
│  ├─ 人物/
│  │  └─ a.png
│  └─ b.jpg
└─ 信息图类/
   └─ c.webp
```

上例的分类分别为 `艺术类/人物`、`艺术类`、`信息图类`。支持 jpg、jpeg、png、webp、gif。开发时先分别在 `server`、`client` 运行 `npm install`，再执行根目录的 `npm run dev`。
