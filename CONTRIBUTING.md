# 贡献指南

## 提交前

- 改动的 JS / CJS / MJS 文件请确认 `node --check <file>` 通过
- 提交信息按主题分开，使用 `feat:` / `fix:` / `docs:` / `chore:` 前缀

## 不要提交

- `node_modules/`、`dist/`、`dist-clean/` 等构建产物
- `data/` 与任何本地运行数据
- 个人配置、密钥、令牌，或带有本机绝对路径的文件

## 版本与发布

- 源码变更后，请在 `CHANGELOG.md` 记录对应版本
- 构建配置位于 `build/`，打包命令见 `package.json` 的 `scripts`
