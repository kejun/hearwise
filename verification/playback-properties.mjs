// Implementation/browser evidence complements the separately gated finite model.
const definitions = [
  ['HW-08-02', '播放对象代次隔离', '停止、切换和有限 wire epoch 复用之后，旧解锁、播放器、连接和收尾回调不得重启、暂停或清理新代次。',
    '实际 uint32/浮点精度边界；模2加速的对象身份ABA；文件SQLite服务到真实player/worklet桥接；1280/390px真实浏览器原生解锁竞争与旧socket事件。'],
  ['HW-08-03', '规范化可播报文本完整性', '已接受的规范化文本按顺序覆盖，除声明的边界空白外无词语遗漏或重复；原文覆盖按来源区间而非译文字符串推算。',
    '独立golden UTF-16区间账本、标记/空白、Unicode/grapheme、超长与尾段、原文修订；真实Qwen/Fish传输以及真实浏览器播放进度回执。'],
  ['HW-08-04', '暂停跳转与显式恢复', '暂停允许已有合成完成，但不得启动下一句；暂停跳转仍暂停；旧原生resume完成不得撤销新暂停或新代次。',
    '真实服务在途响应；实际player/native-promise桥接；桌面和窄屏键盘End跳转、焦点、明确恢复、完成和关闭清理。'],
  ['HW-08-05', '帧顺序与供应商响应所有权', '当前帧乱序、重复、跨单元和长度错误失败关闭；旧代帧忽略；已绑定供应商响应ID不能再次认领任务。',
    '实际player帧边界；真实Qwen WS迟到created顺序、历史ID与4097请求连接轮换；真实server WebSocket和Fish流完整性。']
];
export const playbackProperties = definitions.map(([id, title, requirement, domain]) => ({
  id, group: 'HW-08', version: 1, title, requirement, domain,
  consequence: '旧声音重新出现、播放状态被旧回调覆盖、文本漏读或重播、错误响应混入新句。',
  preconditions: '合法归档记录，真实文件SQLite和本地供应商桩；浏览器使用实际AudioContext、AudioWorklet及真实WS。',
  state: '对象owner、uint32 wire epoch、原生解锁/恢复、来源区间、provider响应ID、unit/frame/sample序列与消费回执。',
  assumptions: 'Qwen每连接单在途；首次未见response.created标识当前提交，未见过的无关联迟到created无法靠协议推断。已绑定ID记忆有界4096，只有实际换连接才重置。',
  owners: ['KEJ-75 实施与独立审查者：有限域与实际边界', '发布负责人：形式化与浏览器分别验收'],
  methods: ['actual-player-worklet-service-sqlite-bridge', 'real-websocket-stub-provider', 'golden-text-interval-ledger', 'automated-chromium'],
  implementation: ['public/speech-controller.js', 'public/speech-player.js', 'public/speech-buffer.js', 'public/speech-output-processor.js',
    'speech-service.mjs', 'speech-scheduler.mjs', 'incremental-speech.mjs', 'qwen-tts.mjs', 'fish-tts.mjs'],
  assets: ['test/speech-generation-boundary.test.mjs', 'test/qwen-response-ownership.test.mjs', 'test/playback-text-contract.test.mjs',
    'test/playback-protocol-adapter.test.mjs', 'test/playback-websocket.test.mjs', 'test-support/playback-browser.mjs'],
  issues: ['KEJ-75'], invalidatedBy: ['播放、规范化、分段、来源覆盖、供应商协议、依赖、页面或模型边界变化'],
  acceptance: [requirement], gaps: ['该实现profile不替代独立Quint/TLC/Apalache门禁；不证明真实服务质量、实际扬声器可听效果、设备兼容或无限代次。'],
  evidenceStatus: 'not_run'
}));
export const playbackProfile = playbackProperties.map(property => property.id);
