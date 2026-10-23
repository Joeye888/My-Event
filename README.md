# Event Kaki - Employee Time Tracking System

一个完整的员工打卡签到/签出系统，用于追踪工作时间和考勤记录。

## 功能特性

✅ **员工打卡功能**
- 签到（Check In）和签出（Check Out）
- 实时时间显示
- 每日工作时长自动计算
- 打卡历史记录和时间线
- 按 09:00–18:00 班次自动识别迟到和早退
- 在员工页面和管理员仪表板显示考勤提醒

✅ **个人考勤页面**
- 查看历史打卡记录
- 按日期范围过滤
- 每周/每月工作时长统计
- 分页浏览记录

✅ **管理员仪表板**
- 查看所有员工今日打卡情况
- 实时工作状态监控
- 员工搜索和过滤
- 高级过滤（日期范围、部门等）
- 数据导出（CSV格式）
- 实时警报通知
- 发布职位给 Crew 账号浏览和申请
- Crew 申请职位时自动扣减一个可用 PAX 名额，取消申请后恢复名额
- Crew 可上传个人头像、在 My Wallet 管理银行资料和 Bank Statement
- Crew 可在 Job History 查看申请记录
- Supervisor 可在 Post Job 管理并取消已发布职位
- Crew 可通过注册页提交 MyKad/Passport 资料、联系方式及身份证明文件，并创建登录密码
- Crew 注册时可现场拍摄且不可替换头像；已注册个人资料会立即显示在 My Profile

## 技术栈

- **前端**: HTML5, CSS3, Vanilla JavaScript
- **后端**: Node.js + Express
- **数据库**: SQLite3
- **API**: RESTful API
- **打卡地点**: 默认使用 KLCC 坐标，半径固定为 150 米；可通过 `CHECKIN_LATITUDE` 和 `CHECKIN_LONGITUDE` 配置活动地点中心。只有活动当天已获批准的 Crew 才可打卡

## 安装与运行

### 1. 安装依赖

```bash
cd "C:\Users\hp\Desktop\Event Kaki"
npm install
```

### 2. 启动服务器

```bash
npm start
```

或在开发模式使用自动重启：

```bash
npm run dev
```

服务器将运行在 `http://localhost:3000`

### 3. 访问应用

- 请通过 `http://localhost:3000/login.html` 访问登录页，不要直接双击打开 `login.html`。
- **员工打卡页面**: http://localhost:3000/checkin.html
- **考勤记录页面**: http://localhost:3000/attendance.html
- **管理员仪表板**: http://localhost:3000/admin-dashboard.html
- **发布职位**: http://localhost:3000/post-job.html
- **职位历史**: http://localhost:3000/job-history.html

## Demo 账户

```
Crew:
Employee ID: N000001
Password: 990101-14-0001

Supervisor:
Employee ID: S000001
Password: Supervisor@123
```

主管登录后会进入 `admin-dashboard.html`，可以查看所有 crew 的资料和出席场次，并编辑 crew 的姓名、联系方式、职位和部门。主管接口需要带有 supervisor 角色，普通 crew 账号不能访问全员数据。

## 文件结构

```
Event Kaki/
├── server.js                 # Express 服务器及 API
├── package.json             # 项目配置
├── checkin.html             # 打卡签到页面
├── checkin.css              # 打卡页面样式
├── attendance.html          # 个人考勤记录页面
├── attendance.css           # 考勤页面样式
├── admin-dashboard.html     # 管理员仪表板
├── post-job.html            # 主管发布职位页面
├── my-wallet.html           # Crew 钱包和银行资料页面
├── job-history.html         # Crew 职位申请历史
├── admin-dashboard.css      # 仪表板样式
├── event_kaki.db           # SQLite 数据库（自动创建）
└── README.md               # 本文件
```

## API 端点

### 考勤相关

- `POST /api/checkin` - 签到
- `POST /api/checkout` - 签出
- `GET /api/attendance/today/:employeeId` - 获取今日状态
- `GET /api/attendance/:employeeId` - 获取考勤历史
- `GET /api/stats/employee/:employeeId` - 获取员工统计

迟到/早退规则：系统使用马来西亚时间（UTC+8），签到晚于 09:00 会记录迟到分钟数，签出早于 18:00 会记录早退分钟数。

### 管理相关

- `POST /api/auth/login` - 登录并返回账号角色
- `POST /api/auth/register` - 注册 Crew 账号并保存个人资料与身份证明文件
- `GET /api/profile` - 获取当前登录员工的注册资料和头像
- `POST /api/profile/change-requests` - Crew 提交姓名、MyKad/Passport、联系方式、地址或性别更改申请
- `GET /api/profile/change-requests` - Supervisor 查看资料更改申请
- `PATCH /api/profile/change-requests/:requestId/approve` - Supervisor 批准资料更改申请
- `PATCH /api/profile/change-requests/:requestId/reject` - Supervisor 拒绝资料更改申请
- `DELETE /api/employees/:employeeId` - Supervisor 删除 Crew 账号及其关联记录
- `GET /api/employees` - 获取所有员工（需要主管角色）
- `PATCH /api/employees/:employeeId` - 更新 crew 资料（需要主管角色）
- `GET /api/admin/attendance` - 获取所有打卡记录（带统计，需要主管角色）

### 职位和钱包

- `GET /api/jobs` - 获取可用职位（主管可查看所有状态）
- `POST /api/jobs` - 发布职位（需要主管角色）
- `PATCH /api/jobs/:jobId` - 编辑职位（需要主管角色）
- `DELETE /api/jobs/:jobId` - 取消职位并保留职位与申请历史（需要主管角色）
- `POST /api/jobs/:jobId/apply` - Crew 申请班次
- `GET /api/job-applications` - Crew 获取本人历史；主管获取所有 Crew 的申请历史
- `PATCH /api/job-applications/:applicationId/status` - 主管设置 Pending、Approved、Rejected 或 Withdrawn
- `POST /api/job-applications/:applicationId/cancel` - Crew 取消预订或提交迟取消及证据
- `GET /api/admin/cancellation-requests` - 主管查看迟取消证据审核请求
- `GET /api/admin/cancellation-requests/:requestId/evidence` - 主管读取迟取消证据
- `PATCH /api/admin/cancellation-requests/:requestId` - 主管审核迟取消证据
- `GET /api/wallet` - 获取当前 Crew 的数据库钱包和交易日志
- `POST /api/wallet/transactions` - 主管模拟收入或提现交易并写入钱包日志

职位达到所需的 Approved 人数后会标记为 `Job Full` 并停止接收申请。Crew 可在开工至少 24 小时前取消；开工前 3 至 24 小时不能取消；开工前 3 小时内无理由取消将冻结职位预订 30 天。迟取消提供理由和 PDF/JPEG/PNG/WebP 证据时，Supervisor 审核后可免冻结；拒绝证据则冻结 24 小时。预订冻结不会影响 Crew 使用平台其他功能。

管理员不会查看 Crew 的密码。账号密码使用 scrypt 哈希保存，无法还原为明文；如需协助登录，应重设密码而不是查看原密码。

Crew 打卡前必须允许浏览器定位；服务器会使用活动地点坐标和半径进行二次校验，拒绝不在活动范围内的请求。

## 数据库表结构

### employees 表
- id: 员工ID（主键）
- name: 员工名字
- email: 邮箱
- phone: 电话
- position: 职位
- department: 部门
- document_type / document_number: MyKad 或 Passport 资料
- current_address / gender: 注册资料
- document_name / document_mime_type / document_data: 上传的身份证明文件（最多 8 MB，仅保存在数据库中，不通过静态文件 URL 提供）
- profile_photo_mime_type / profile_photo_data: 注册时现场拍摄的头像（最多 2 MB，注册后不可替换）
- password_salt / password_hash: 使用 scrypt 保存的密码凭据
- created_at: 创建时间
- updated_at: 更新时间

### attendance 表
- id: 记录ID（主键）
- employee_id: 员工ID（外键）
- check_in_time: 签到时间
- check_out_time: 签出时间
- hours_worked: 工作时长（小时）
- date: 日期
- created_at: 创建时间
- updated_at: 更新时间

## 功能说明

### 1. 员工打卡（Check In/Out）
- 打开 checkin.html
- 点击"Check In"按钮记录上班时间
- 工作结束后点击"Check Out"按钮
- 系统自动计算工作时长

### 2. 查看考勤记录
- 进入考勤记录页面查看历史
- 按日期范围过滤记录
- 查看每周/每月统计

### 3. 管理员监控
- 查看所有员工的打卡情况
- 搜索特定员工
- 使用高级过滤
- 导出数据为 CSV

## 注意事项

⚠️ **生产环境建议**
- 添加用户认证和授权
- 使用真实的数据库（PostgreSQL/MySQL）
- 实现数据备份机制
- 添加数据加密
- 部署 HTTPS
- 实现审计日志

## 故障排除

**问题**: 无法连接到数据库
- **解决**: 确保 SQLite3 已正确安装，删除旧的 event_kaki.db 文件重新创建

**问题**: 端口已被占用
- **解决**: 修改 server.js 中的 PORT 或结束占用端口的进程

**问题**: 打卡不成功
- **解决**: 检查浏览器控制台的错误信息，确保后端服务器正在运行

## 许可证

MIT

## 支持

如有问题，请检查服务器日志或浏览器控制台的错误信息。
