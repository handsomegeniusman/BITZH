# 北理珠流浪猫关爱部 · 小程序

> 北理珠（北京理工大学珠海学院）流浪猫关爱部官方小程序，用于**查猫、看小猫书、发布与了解校园猫咪动态**。

<img src="./万柳猫咪图鉴.jpg" width="200" height="200" alt="小程序 Logo" />

## 目录

1. [项目简介](#一项目简介)
2. [特别鸣谢](#特别鸣谢)
3. [功能总览](#二功能总览)
3. [技术栈](#三技术栈)
4. [目录结构](#四目录结构)
5. [数据库集合说明](#五数据库集合说明)
6. [从零部署（新手必看）](#六从零部署新手必看)
7. [后台管理（管理员）](#七后台管理管理员)
8. [日常维护](#八日常维护)
9. [常见问题 FAQ](#九常见问题-faq)

---

## 一、项目简介

这是一个基于**微信小程序 + 阿里云 MPServerless 云开发 + 腾讯云 COS 图片存储**的猫咪信息平台，包含三块核心内容：

- **猫档案**：每只校园猫的姓名、毛色、性格、状态（健康 / 送养 / 失踪 / 离世 / 待抓）、绝育情况、照片等。
- **小猫书**：社团成员发布的图文动态（推文），可以点赞、评论、关联到某只猫和话题。
- **相关话题**：自动聚合"某只猫出现在哪些话题的推文里"，支持多选话题、在详情页内联查看文章，并按拍摄时间 / 发布时间排序。

---

## 特别鸣谢

本项目基于 **[万柳猫咪图鉴]**（校园流浪猫图鉴开源小程序）二次开发改造而来，**特此鸣谢原项目作者与万柳猫猫之家**。

- 保留原项目 Logo（`万柳猫咪图鉴.jpg`）作为本项目图标基础。
- 在原项目核心能力（查猫、图鉴、小猫书等）之上，针对**北理珠流浪猫关爱部**的实际需求进行了功能扩展与重构（详细变更见 [changeLog.md](./changeLog.md)）。
- 遵循原项目开源协议 [MIT](./license)，本项目二次开发成果同样以 MIT 协议开源。

---

## 二、功能总览

### 面向普通用户

| 功能 | 说明 |
| --- | --- |
| 查猫 | 按关键词搜索猫（支持空格 / 多关键词分词），可看「在校 / 离校」等分类 |
| 猫详情 | 照片轮播、状态 / 绝育标签、详细资料展开收起、相关猫咪、相关话题聚合 |
| 小猫书 | 图文瀑布流，点击进入详情；按拍摄时间 / 发布时间 / 点赞排序 |
| 发布动态 | 底部中间「+」按钮发布小猫书（未注册用户先引导注册） |
| 公告弹窗 | 打开首页 / 搜索页时展示社团公告 |
| 关于 | 社团介绍、开发者信息、广告位 |

### 面向管理员（`app.globalData.isAdministrator` 为真时）

| 功能 | 说明 |
| --- | --- |
| 添加 / 编辑猫咪 | 支持照片上传、状态标签、关系维护（改名后自动同步推文关联） |
| 添加 / 编辑小猫书 | 图文编辑、话题标签、封面设置、草稿自动保存 |
| 编辑公告 | 修改首页 / 搜索页弹窗公告 |
| 回收站 | 猫咪回收站（catTrash）与推文回收站（pageTrash）可恢复 / 彻底删除 |
| 审核开关 | 通过 `Administrator` 集合第一条记录控制「是否开放注册 / 发布」 |
| 长按删除 | 在列表 / 详情页长按条目可快速进入编辑 |

### 其他细节

- **自定义 tabBar**：小红书式底部导航，中间凸起加号即发布入口，4 个 tab 页自动同步选中态。
- **草稿机制**：编辑页（猫咪 / 小猫书）自动保存草稿，退出后再次进入可恢复，清缓存不误弹。
- **图片回退**：图片加载失败逐级回退（`png → 0.jpg → 占位图`），避免 COS 缺图显示空白。
- **主题变量**：全站统一使用 `var(--color-*)` 设计令牌（主色粉 `#FF405E`），换主题只需改 `app.wxss`。

---

## 三、技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | 微信小程序原生（WXML / WXSS / JS） |
| 后端 | 阿里云 MPServerless 云开发（`@alicloud/mpserverless-sdk`） |
| 图片存储 | 腾讯云 COS（`cos-wx-sdk-v5`），支持云函数签发临时密钥（STS） |
| 云函数 | `cloudfunctions/getCosSts`（可选，签发 COS 临时密钥） |
| 单元测试 | 已清理（历史上有基于 `utils/` 的 Node 单测，需要时可重建，见 FAQ） |

> ⚠️ 小程序是纯前端项目，所有密钥都存在前端 `config.js`，反编译即可看到。**务必**：COS 尽量启用 STS 临时密钥；MPServerless 开启数据库权限校验，避免任意用户增删改数据。密钥一旦泄露请立刻在控制台轮换。

---

## 四、目录结构

```
BITZH/
├── miniprogram/               # 小程序主体（在微信开发者工具中打开这个目录）
│   ├── app.js                 # 入口：初始化 MPServerless、登录授权、更新检查
│   ├── app.json               # 页面注册、tabBar 配置
│   ├── app.wxss               # 全局样式 + 主题变量（--color-*）
│   ├── config.js              # 真实密钥配置（本地，已被 .gitignore 忽略）
│   ├── config.example.js      # 配置模板（提交到仓库，只含示例值）
│   ├── pages/                 # 页面
│   │   ├── index/             # 首页：小猫书瀑布流
│   │   ├── catSearch/         # 查猫页
│   │   ├── catDetail/         # 猫详情
│   │   ├── bookletDetail/     # 小猫书详情
│   │   ├── mydetail/          # 我的
│   │   ├── about/             # 关于
│   │   ├── addCat|editCat/    # 添加 / 编辑猫咪（管理员）
│   │   ├── addBooklet|editBooklet/  # 发布 / 编辑小猫书
│   │   ├── regist/            # 用户注册
│   │   ├── Administrator/     # 管理后台入口
│   │   ├── catTrash|pageTrash/# 猫咪 / 推文回收站
│   │   ├── editAnnouncement/  # 编辑公告（管理员）
│   │   ├── someBooklet/       # 按分类浏览小猫书
│   │   ├── 所有/              # 所有猫咪列表
│   │   ├── templates/         # 公共 WXML 模板（黑名单弹窗 / 公告弹窗 / 推文卡片）
│   │   └── images/            # 静态图片资源
│   ├── components/            # 自定义组件：关系编辑器、话题编辑器
│   ├── custom-tab-bar/        # 自定义底部导航
│   ├── utils/                 # 公共工具（数据库、COS、排序、话题、草稿、回收站等）
│   ├── project.config.json    # 微信开发者工具项目配置（有效配置）
│   ├── sitemap.json           # 微信搜索收录配置
│   └── package.json           # npm 依赖
├── cloudfunctions/getCosSts/  # COS 临时密钥云函数（可选）
├── changeLog.md               # 版本更新记录
├── 已知问题.md                # 已修复/待关注的问题清单
├── 测试清单.md                # 手动测试清单
├── license                    # MIT 开源协议
└── 万柳猫咪图鉴.jpg           # 项目 Logo
```

> 注：`manage/`（旧数据转换脚本）、`test/`（单测与检查清单）已清理；如需跑测试，参考「常见问题」中重建测试的说明。

---

## 五、数据库集合说明

| 集合 | 用途 | 主要字段 |
| --- | --- | --- |
| `BITZH` | 猫咪档案 | `name` 名字、`addPhotoNumber` 照片数、`status` 状态、`isSterilization` 绝育、`furColor` 毛色、`relatedCats` 相关猫咪、`appearance` 外貌等 |
| `Page` | 小猫书（推文） | `tittle` 标题、`relative` 关联标签（话题 / 猫名）、`pageTime`/`photoTime` 时间、`good` 点赞、`authorId`/`authorImg` 作者、`comment` 评论 |
| `Feeder` | 用户资料 | 昵称、头像、openid 等 |
| `Notice` | 公告 | 公告内容、是否展示 |
| `Comment` | 评论 | 小猫书下的评论 |
| `Administrator` | 管理配置 | 第一条记录存放「是否开放注册 / 发布」等开关，其 `_id` 配置在 `config.js` 的 `administratorRecordId` |

---

## 六、从零部署（新手必看）

### 1. 环境准备

- 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。
- 安装 Node.js（运行测试脚本用）。
- 一个微信小程序 AppID（可在微信公众平台注册，或用测试号）。

### 2. 导入项目

1. 打开微信开发者工具 → **导入项目**。
2. 选择 `miniprogram/` 目录，填入你的 AppID。
3. 等待工具编译完成。

### 3. 配置后端（阿里云 MPServerless）

1. 打开 [MPServerless 控制台](https://mpserverless.console.aliyun.com) 创建空间，记下 **AppID / 空间 ID / 客户端密钥 / 网关地址**。
2. 进入 `miniprogram/`，把 `config.example.js` **复制一份改名为 `config.js`**。
3. 在 `config.js` 里填入 MPServerless 配置。
4. 创建数据库集合：`BITZH`、`Page`、`Feeder`、`Notice`、`Comment`、`Administrator`。

### 4. 配置图片存储（腾讯云 COS）

1. 在 [COS 控制台](https://console.cloud.tencent.com/cos) 创建存储桶，开启「公有读」或配置访问权限。
2. 把存储桶域名 + 图片目录前缀填到 `config.js` 的 `imageUrl`（例如 `https://xxx.cos.ap-guangzhou.myqcloud.com/main/images/`）。
3. 填入 `SecretId / SecretKey / Bucket / Region`。
4. （推荐）启用临时密钥 STS：把 `cos.useSts` 改为 `true`，并在 MPServerless 控制台上传部署 `cloudfunctions/getCosSts` 云函数、配置好环境变量。未部署时会自动回退固定密钥，不影响使用。

### 5. 配置管理员与公告

1. 在 `Administrator` 集合插入一条记录，作为「审核开关」配置（例如包含 `isOpenRegister` / `isOpenPublish` 等字段）。
2. 把这条记录的 `_id` 填到 `config.js` 的 `administratorRecordId`。
3. 公告内容存放在 `Notice` 集合。

### 6. 上传体验版 / 发布

在微信开发者工具右上角点击 **上传**，填写版本号与备注，到微信公众平台提交审核即可。

---

## 七、后台管理（管理员）

- 进入「我的」→ 管理入口（仅管理员可见）。
- **添加猫咪**：填写资料并上传照片，可设置状态标签与相关猫咪关系。
- **编辑猫咪**：在列表或详情页长按条目，或从管理入口进入；支持改名（自动同步推文关联）、删除（进回收站）。
- **添加 / 编辑小猫书**：发布图文动态、选择话题、设置封面，草稿会自动保存。
- **回收站**：恢复误删的猫咪 / 推文，或彻底删除。
- **公告**：在管理入口编辑公告内容。

---

## 八、日常维护

- **改主题色**：只改 `app.wxss` 顶部的 `--color-*` 变量，全站自动生效。
- **改公告**：维护 `Notice` 集合。
- **看更新记录**：`changeLog.md`。
- **已知问题**：`已知问题.md`（记录了已修复与待关注的坑，改动相关模块前建议先看）。
- **手动回归**：`测试清单.md` 有完整的手动测试清单，发版前建议过一遍。

---

## 九、常见问题 FAQ

**Q1：导入项目后页面空白 / 报错？**
检查 `config.js` 是否存在（它被 .gitignore 忽略，需要自己从 `config.example.js` 复制创建），且里面的 AppID、空间 ID 是否与你的环境一致。

**Q2：图片加载不出来？**
检查 COS 存储桶是否配置了读权限、`imageUrl` 前缀是否正确。小程序有逐级回退机制，缺图会显示占位图而不是白屏。

**Q3：怎么添加第一条猫咪数据？**
在 MPServerless 控制台往 `BITZH` 集合插入一条记录，或用管理后台的「添加猫咪」功能（需先配置好管理员）。

**Q4：如何成为管理员？**
`app.globalData.isAdministrator` 由数据库判断（见 `utils/db.js` 的 `checkAdmin`）。把你的 openid 记录到对应管理字段即可（具体规则见 `utils/db.js`）。

**Q5：测试 / 单测去哪了？**
`test/` 已清理。如需回归测试，可按项目原有方式重建（参考 `测试清单.md` 的手动清单，或基于 `utils/` 各模块重写 Node 单测）。

**Q6：部署云函数提示找不到？**
`getCosSts` 只在 `config.js` 里 `cos.useSts: true` 时才会被用到。不需要 STS 就保持 `false`，无需部署。

---

## 开源协议

[MIT](./license) © circlelq
