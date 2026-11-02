文档笔记保存（2026-10-14）

PDF/Word文字笔记：输入停止700ms后自动保存UTF-8 TXT。
涂鸦：同名.annotations.json保存逐页画笔、高亮、橡皮笔画和坐标；切换文档与关闭程序时补存，重新加载后重绘。清除操作同样写入磁盘。
保存目录：程序userData/document-notes。文件名包含原文件名和按文档类型/原始路径生成的标识，同名但不同目录的文件不会互相覆盖。无原始路径时使用类型和名称作为身份。
TXT可直接阅读/编辑，重新打开文档时读取；JSON涂鸦数据保持可恢复。不要移除后缀标识或拆散文件，源文档移动到其他路径后会成为新身份。
原PDF/DOCX不修改。笔记和涂鸦仍随现有项目数据一同保存；独立TXT/JSON提供自动保存，不需要先保存项目。
自动保存失败时界面显示原因，并保留localStorage恢复副本；关闭页面通过同步IPC补存。支持单份笔记数据20MB上限。涂鸦保存完成笔画；未松开指针的笔画不属于已完成记录。
验证：node tools/test-document-notes.js；Electron tools/test-document-notes-electron.js验证实际PDF/Word界面、TXT写入与涂鸦恢复；PDF大纲隔离回归通过。
