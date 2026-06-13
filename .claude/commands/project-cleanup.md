请检查当前项目，找出所有废弃/冗余的文件和目录，然后清理它们。

判断"废弃"的标准：
1. 明显的临时文件：test_*, temp_*, tmp_*, debug_*, old_*, backup_*, bak_*
2. 重复目录：同一功能有多个版本文件夹（如 frontend/ 和 frontend_new/ 同时存在）
3. 空目录：没有任何文件的文件夹
4. 构建残留：target/, dist/, __pycache__/, *.pyc（但不删 node_modules/）
5. 明显没有被任何文件 import/引用 的孤立文件

操作流程：
- 先列出所有"疑似废弃"的文件/目录，并说明理由
- 等我确认后再执行删除
- 删除前告诉我每个文件/目录的用途推断
- 不确定的文件，宁可保留，标记为"待人工确认"

绝对不能删除：
- .git/
- CLAUDE.md、CLAUDE.local.md、.claude/
- .env、.env.local 等环境配置文件
- README.md
- 任何我明确说过要保留的内容
