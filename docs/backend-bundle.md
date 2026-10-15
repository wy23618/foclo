# 后端独立部署包

更新：2026-10-09。当前包为server/delivery/YoTick-backend-ecs-ready-20261009-r3.zip，SHA256 `9d55afd65b94e48178e24f0786b0dc493034f03944ccc4a4d1b2a4cb3e95026d`，85个manifest文件、86个压缩条目。包括锁定依赖、dist/src、源码、SQL001–005、权限脚本、Linux/systemd/加密备份/恢复检查、健康检查回退脚本和接口资料。密钥、数据库数据、node_modules、后端与备份单元测试、本机调试工具及项目级交付索引均不在包内；部署自检脚本保留。完整manifest、文件SHA256及同名校验文件均与当前工作区逐项一致。该更新包尚未部署到ECS；ECS继续运行已验收的20261008版本。

在项目目录运行`powershell -NoProfile -ExecutionPolicy Bypass -File server/deploy/package-backend.ps1`生成带时间戳的zip。已有输出不会被覆盖。生成前先在server目录运行`npm run build`；包内manifest.json记录各文件大小及SHA256。

解压到目标目录后，使用Node24执行`npm ci --omit=dev`安装运行依赖。dist已编译，启动无需tsx或TypeScript。配置受保护环境变量后执行`npm start`，或用`node --env-file=.env dist/src/index.js`；正式环境必须NODE_ENV=production、数据库TLS有效且身份/业务密钥已配置。MIGRATION_DATABASE_URL仍是配置字段；迁移在独立管理任务执行，业务实例不需要真实迁移权限。

SQL迁移执行`npm run migrate`，只对已确认的目标数据库运行，再由管理员执行deploy/permissions.sql。先备份并核对目标，部署时不覆盖原本机数据库。HTTPS、微信合法域名、备份及运行监测按deployment.md完成。

实际验收方式：在独立TEMP/YoTick-bundle-check-*目录解压zip，再在原项目运行`node --env-file=server/.env server/local-dev/verify-bundle.mjs <解压目录>`。工具先逐文件检查manifest及私有文件排除，再安装仅运行依赖，加载该解压目录的编译后端，对本机PG进行只读健康/未登录认证检查。

2026-10-08实际通过：本机独立包运行验证及阿里云生产依赖部署，逐项manifest完整、live/ready200、未登录me401。云端PG TLS/最小权限、整机重启、加密备份和隔离恢复已核验，微信真实凭据在云端换取同一迁移账号身份通过；没有冒充手机公网HTTPS验收，Docker和正式版本仍未验。详见ecs-deployment.md。

应使用完整交付入口中指明的最新通过验收包；初次打包误含dist/tests，已在验证阶段拒绝并修正为只包含dist/src，不将初次包交付使用。
