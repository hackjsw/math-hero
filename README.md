# 🧮 CFmath — 趣味数学对战游戏

一款部署在 **Cloudflare Workers** 上的在线数学练习 & 多人对战游戏，零服务器、全球加速、开箱即用。

> 🎮 适合小学生课后练习加减乘除，支持好友实时 PK，答题越快排名越高！

---

## ✨ 功能亮点

### 🎯 单人练习
- 支持 **加法、减法、乘法、除法** 自由组合
- 可选年级难度（1~6 年级），题目智能生成
- 实时计时 + 连击系统（Combo 🔥）
- 答错 +10s 罚时，增加挑战性
- 练习结束自动结算经验、金币

### ⚔️ 多人对战
- 创建 / 加入房间，最多 **4 人同时 PK**
- 实时进度赛道，看到对手答题进度
- 答题连击自动发送嘲讽表情 😈
- D1 强一致性 + 乐观锁，跨设备秒同步

### 🏪 商店 & 换装
- 金币购买 **表情头像** 和 **主题皮肤**
- 连续签到解锁传说级限定皮肤（7/30/90/150/300 天）
- 一键换装，个性化你的角色

### 📊 数据系统
- 等级 & 经验值 & 段位头衔
- 🔥 每日签到连续天数追踪
- 🏆 全服排行榜（按等级排名）
- 个人最佳成绩记录（PB）

---

## 🏗️ 技术架构

| 组件 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 数据库 | Cloudflare D1 (SQLite) |
| 前端框架 | 原生 HTML + JS（单文件内嵌） |
| CSS | TailwindCSS CDN |
| 部署方式 | Cloudflare Dashboard 直接粘贴 |

整个项目只有一个 `workers.js` 文件，包含 API 后端 + 完整前端页面，无需构建工具。
全部数据存储在 **一个 D1 数据库** 中（用户、排行榜、对战房间），无需 KV。

---

## 🚀 部署指南

### 前置条件
- 一个 [Cloudflare](https://dash.cloudflare.com) 账号（免费计划即可）

### 步骤

#### 1. 创建 D1 数据库
- 进入 Cloudflare Dashboard → **D1** → 创建数据库（如 `cfmath`）
- 在数据库 **Console** 中执行以下建表 SQL：

```sql
-- 用户数据
CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- 排行榜
CREATE TABLE IF NOT EXISTS leaderboard (
  name TEXT PRIMARY KEY,
  exp INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  avatar TEXT DEFAULT '🐻'
);

-- 对战房间
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  last_activity INTEGER NOT NULL
);
```

#### 2. 创建 Worker
- 进入 **Workers & Pages** → **Create** → **Create Worker**
- 将 `workers.js` 的内容粘贴到编辑器中
- 点击 **Deploy**

#### 3. 绑定数据库
- 进入 Worker → **Settings** → **Bindings**
- 添加 **D1 Database** → 变量名填 `battle_rooms`，选择你创建的 D1 数据库

#### 4. 访问
- 打开你的 Worker URL（如 `https://your-worker.your-subdomain.workers.dev`）
- 输入昵称即可开始游戏 🎉

---

## 📱 使用建议

- **手机用户**：将网页添加到主屏幕，获得类 App 体验
- **多人对战**：对战界面有「⛶ 全屏」按钮，防止手机浏览器底栏遮挡按键
- **签到奖励**：每天登录点击签到，连续签到解锁稀有皮肤

---

## 📂 项目结构

```
CFmath/
└── workers.js    # 唯一的源文件（API + 前端，约 2500 行）
```

是的，整个游戏就一个文件。😎

---

## 📜 License

MIT License — 随意使用、修改、分享。
