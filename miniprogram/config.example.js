/**
 * ============================================================
 *  全局配置文件（模板 / 示例）
 * ============================================================
 *  【如何使用】
 *    1. 把本文件复制一份，改名为 config.js
 *    2. 打开 config.js，把下面所有的 "你的xxx" 示例值替换成你自己的真实信息
 *    3. 保存即可运行
 *
 *  【作用】本文件集中存放所有"私密信息"：
 *         1. 阿里云 MPServerless 后端密钥
 *         2. 腾讯云 COS 图片存储密钥
 *         3. 管理员配置文档 ID、广告位 ID 等
 *
 *  【重要】config.js 已加入 .gitignore，不会被提交到 GitHub。
 *          这个 config.example.js 是提交到 GitHub 的模板，
 *          里面只有示例值，没有任何真实密钥，可以放心开源。
 *
 *  【安全提醒】
 *    1. 小程序是"纯前端"项目，凡是放在这里的密钥，用户反编译后都能看到。
 *       所以请务必：
 *         - 腾讯云 COS：使用"临时密钥（STS）"由云函数签发，不要使用固定 SecretKey；
 *         - 阿里云 MPServerless：在控制台开启"数据库权限校验"，并对集合配置规则，
 *           避免任意用户增删改数据。
 *    2. 如果你的密钥已经泄露（例如以前提交过 GitHub），请立刻到控制台轮换密钥。
 * ============================================================
 */
module.exports = {
  // ===================== 阿里云 MPServerless（云开发后端） =====================
  // 在 https://mpserverless.console.aliyun.com 创建空间后，可在"空间详情"里找到
  serverless: {
    appId: '你的小程序AppID',        // 小程序 AppID
    spaceId: '你的MPServerless空间ID', // MPServerless 空间 ID
    clientSecret: '你的客户端密钥',    // 客户端密钥（请勿外泄）
    endpoint: 'https://api.next.bspapp.com', // 网关地址（一般不用改）
  },

  // ===================== 腾讯云 COS（图片上传与展示） =====================
  // 在 https://console.cloud.tencent.com/cos 创建存储桶后获取
  cos: {
    SecretId: '你的COS密钥ID',        // 密钥 ID
    SecretKey: '你的COS密钥Key',      // 密钥 Key（请勿外泄）
    Bucket: '你的存储桶名称',          // 例如 bitzh-1318479541
    Region: '你的存储桶地域',          // 例如 ap-guangzhou
    // 是否改用云函数签发 COS 临时密钥（STS）。true 时需部署 getCosSts 云函数，
    // 否则自动回退固定密钥（见 utils/cosSts.js 与 cloudfunctions/getCosSts/）。
    useSts: false,
  },

  // 图片访问的根地址（存储桶默认域名 + 图片目录前缀）
  // 猫咪头像/相册/推文/用户头像都从这个根地址拼接文件名
  // 例如：https://你的存储桶-你的AppId.cos.ap-guangzhou.myqcloud.com/main/images/
  imageUrl: '你的图片访问根地址',

  // ===================== 其他配置 =====================
  // 管理员配置文档 _id：
  // 数据库 Administrator 集合中，第一条记录用来存放"是否开放注册/发布"等审核开关
  // 请在你自己的数据库里插入一条记录后，把 _id 填到这里
  administratorRecordId: '你的Administrator记录_id',

  // 广告位 ID（微信公众平台 -> 流量主 -> 广告位管理）
  adUnitIds: {
    video: '你的激励视频广告位ID',     // 关于页/看广告赚猫粮
    mydetailModal: '你的我的页广告位ID', // 我的页弹窗广告
  },
};
