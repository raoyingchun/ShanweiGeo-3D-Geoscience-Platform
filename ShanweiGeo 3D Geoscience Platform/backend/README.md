# 本地 Python 通道：第一阶段

现有业务保持原样。Python 通道提供健康检查、诊断、`coord.native.convert` 和 `coord.native.batch`。Python只用标准库控制原COORD副本、传递数据及导出原文件转换器生成的结果，不自行计算坐标。自制算法与vendor继续停用；未新增模型计算或SQLite业务存储。单点超时30秒，文件批量120秒。

## 开发运行

解释器选择：优先 `runtime/python/python.exe`；开发环境缺失时使用 `SHANWEI_PYTHON` 指定路径，否则使用 PATH 中的 `python`。正式打包环境只允许随包解释器。

重启桌面程序，在 DevTools 控制台执行：

```javascript
await backendClient.healthCheck()
await backendClient.run('diagnostic.progress', {steps: 10}, {onProgress: console.log})
// 取消测试（预期 Promise 抛出 code=CANCELLED）
await backendClient.run('diagnostic.progress', {steps: 100}, {
  onStarted: id => setTimeout(() => backendClient.cancel(id), 300)
})
```

开发检查：`node tools/test-python-bridge.js`。

## 边界

- 主进程白名单控制业务名称，一次一个任务；每任务独立 Python 进程，默认超时 30 秒。
- UTF-8 JSON Lines，stdout 专用协议，stderr 专用日志；结果只在进程结束后确认。
- 页面导航/销毁取消其任务，退出应用等待进程关闭。原 COORD 任务用 Windows Job Object 管理独立副本，Python 退出或被取消时清理计算进程，不接管用户已有的原程序窗口。
- 后续耗时业务应增加经过限制的超时策略，不能沿用诊断任务的 30 秒上限。
- `backend-client.js` 不修改现有 state。大数据业务后续通过结果文件传递。
- 当前打包配置包含 desktop JS 和 backend Python 源码，停用的 vendor 依赖不纳入打包，**尚未提供随包 Python 解释器**。分发前准备完整解释器，并将 `runtime/python` 作为 extraResources 打包到同名目录；解释器必须在真实 resources 目录中。当前原 COORD 连接层使用标准库，仅支持 Windows，原软件仍依赖指定本地目录。
- 当前 JSON 存档、自动会话及 IndexedDB 缓存逻辑未修改；不代表 SQLite 业务落盘已完成。

## 备份

本次修改前的源代码、配置和图件位于 `backups/before-python-step1-20261009-142810/`，包含 SHA256 清单。node_modules、缓存、用户会话没有修改或复制。

## 本地模型解析（2026-10-13）

`model.parse`负责桌面端 TS、OBJ 与成对 DTM/STR 的流式解析。请求只传源文件路径；缓存目录由主进程固定，前端不能指定输出位置。
顶点采用小端 Float32，索引采用小端 Uint32，与现有模型解析结果保持一致。JSON Lines仅返回元数据和缓存键；`models:read-geometry`仅允许64位十六进制缓存键，通过IPC传输二进制数据，不传Base64几何。
缓存键包含解析版本、完整源路径、文件大小及纳秒修改时间；坑道同时检查STR和DTM。metadata最后提交，避免中断任务留下的半成品成为有效缓存。
磁盘缓存目录为Electron userData/geometry-cache。此版本保持原有Float32坐标精度和OBJ原点约定，不附带坐标修正。前端继续负责材质、配色、透明度、相机、贴图与绘制。浏览器模式或没有真实磁盘路径的File对象沿用前端解析。
模型任务超时120秒，可使用已有取消接口。后端错误会显示，不静默回退为阻塞式前端解析。首次调用仍含Python启动和IPC传输耗时；后端运行日志的elapsedMs仅为解析/缓存访问时间，不代表完整导入时间。
验证：`node tools/test-model-backend.js`比较实际地质TS、OBJ、坑道与旧解析器的顶点和索引字节、名称、包围盒、原点；另验证OBJ负索引、缓存失效和错误几何。`tools/test-asc-terrain-electron.js`验证真实桌面IPC、二进制读取和项目恢复；`node tools/test-python-bridge.js`验证后端生命周期和兼容性。

## 块体CSV后端解析（2026-10-13）

桌面端有真实路径时使用`block.parse`，避免在渲染进程读取完整CSV文本。Python以两次流式扫描分类统计并生成小端Float32实例矩阵、Float64拾取分块包围盒。前端沿用`blockGmColor`名称匹配颜色、InstancedMesh显示和现有拾取优化。浏览器或无磁盘路径继续使用已有Web Worker。
缓存键包含解析版本、源文件路径/大小/修改时间及目标场景原点，因此相同文件在不同坐标原点下不会误用实例矩阵。`blocks:read-data`只接受固定目录中的64位十六进制缓存键；任务超时120秒。块体项目保存仍沿用现有实例快照，不改变业务数据结构。
验证：`node tools/test-block-backend.js`逐字节对比实际Block Model 2.csv（658767有效块）的实例矩阵与拾取包围盒，校验类别、范围、原点、带引号CSV、缓存失效。桌面集成测试比较真实IPC与Web Worker结果。首次解析elapsedMs不包含Python启动、IPC和GPU上传时间，不表示整体导入提速比例。

## 高程与遥感预处理（2026-10-13）

`terrain.parse`流式读取ASC，生成小端Float64顶点、Uint32三角面及边界连通零值索引，边界遮罩单独以二进制保存，避免JSON消息膨胀。保留原100万格网/100MB上限、NoData、像元中心、坐标轴交换和垂直比例逻辑。桌面导入及恢复接入此路径；前端仍负责着色、法线和渲染，不宣称GPU绘制已转移到Python。
影像走本地`images:preprocess`：sharp按文件路径异步生成受2048/4096/8192和GPU上限限制的PNG预览，保留原始像素尺寸、透明度及仿射坐标。GeoTIFF标签以随机访问方式只读取必要头部；有嵌入坐标时保持原优先级，用户显式提供的世界文件仍优先。普通图片没有坐标时继续走手动配准。影像导入、独立显示、贴合和恢复无需经Base64回传整个源文件。浏览器及无真实文件路径继续沿用原解码路径。
缓存：高程保存在userData/geometry-cache；预览保存在userData/image-preview-cache。缓存随源路径、大小、修改时间和预览尺寸变化而失效；无内嵌坐标时世界文件每次重读。预处理不裁剪地理范围、不重投影、不修改原始文件。
验证：test-raster-backend.js逐字节比较ASC（含16万个格网）、NoData、边界零值、Float64、中心/角点坐标，比较GeoTIFF坐标标签及影像尺寸、GPU限幅和缓存失效；真实Electron导入、贴合、手动配准接入及项目恢复回归通过。
