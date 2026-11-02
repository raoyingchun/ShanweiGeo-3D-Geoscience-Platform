# Release v1.0.0 — ShanweiGeo 3D Geoscience Platform

Windows x64 桌面版三维地学数据管理与可视化平台。

- **Release 页面**：https://github.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform/releases/tag/v1.0.0
- **源码仓库**：https://github.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform
- **发布日期**：2026-11-02

---

## 一、两种获取方式

### 方式 A：直接下载可执行版（推荐给只想看效果的人）

从 Release 页面下载 `ShanweiGeo-3D-Geoscience-Platform-Windows-x64.zip`（264.6 MB）：

1. 解压整个 ZIP 到一个**可写目录**（不要在 ZIP 内直接运行）
2. 运行 `ShanweiGeo 3D Geoscience Platform.exe`
3. **无需安装 Node.js 或 Python** —— 包内已内置 Python 运行时
4. 建议先用 `Sample Data` 里的示例文件熟悉操作，再打开自己的数据

附带的 `SHA256.txt` 是校验文件，可用以下命令验证下载完整性：

```powershell
Get-FileHash "ShanweiGeo-3D-Geoscience-Platform-Windows-x64.zip" -Algorithm SHA256
```

期望值：`4bce36234cb83cc23d430c50e7e4733e4884d453701c04dc9a4a67bbeee8c6cf`

### 方式 B：拉源码运行（推荐给要改代码的人）

```sh
git clone https://github.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform.git
cd ShanweiGeo-3D-Geoscience-Platform
powershell -ExecutionPolicy Bypass -File "Test data/Restore-Large-Data.ps1"
cd "ShanweiGeo 3D Geoscience Platform"
npm install
npm start
```

完整的分步说明见仓库中的 **`DOWNLOAD-AND-RUN.md`**。

---

## 二、两种版本的差异

| | Release 可执行版 | 源码运行 |
|---|---|---|
| 需要 Node.js | 否 | 是（20 或更高） |
| 需要 Python | 否 | 是（3.11） |
| 需要联网 | 否 | 仅 `npm install` 阶段 |
| 打包体积 | 264.6 MB | 依赖约 470 MB |
| 适合 | 快速试用、演示、交付 | 开发、二次修改 |

**两者的功能完全一致**，可执行版只是预先打包好了运行时。

---

## 三、功能范围

**已实现**：
- 研究区域（矿区）组织与管理
- 多三维视图、图层控制
- 多屏对比查看
- 数据配准（不同数据集坐标对齐）
- 影像贴地显示
- 文档查看（PDF / JPG / DOCX）
- 项目持久化
- 本地处理（坐标转换等）

**未实现（属于后续研究目标）**：
- 自动地质建模
- 矿产预测

> ⚠️ 这一点在 README、Release 说明和随包 README 中都明确标注了。审阅者不应把当前版本误读为已具备自动成矿预测能力。

---

## 四、测试数据说明

`Test data/` 下的三份大数据集以压缩形式分发，恢复脚本会按 SHA-256 校验：

| 数据集 | 分发方式 | 恢复后大小 |
|---|---|---|
| `Block Model 2.csv` | 单个 ZIP | 43.75 MB |
| `ljx_2.csv` | 单个 ZIP | 44.91 MB |
| `image_xy37_full.tif` | 9 个分卷 | 72.41 MB |

恢复方式：

```powershell
powershell -ExecutionPolicy Bypass -File "Test data/Restore-Large-Data.ps1"
```

脚本会输出 `Verified: <path>` 表示校验通过。

**注意**：`Test data/Tunnel Models/Simulated_Tunnels_Around_Orebody_1-1/` 中的坑道示例**明确标注为模拟数据**，仅用于演示导入与渲染流程，不是经过验证的工程设计。

---

## 五、许可

软件以 MIT 协议发布（见 `ShanweiGeo 3D Geoscience Platform/LICENSE`）。

第三方资源保留各自的声明。仓库中包含的测试数据与文档**不因随软件分发而改变其原有权利归属**。

---

## 六、已知限制

- 桌面构建仅针对 Windows x64
- 软件渲染模式（`npm start -- --sw`）下三维场景帧率明显偏低，建议使用默认的硬件加速
- 嵌入式 Python 运行时与离线 wheel 未纳入 Git，需要打包时自行准备
- 遗留的独立 COORD 应用不包含在本发布中，其原生界面保持原语言
