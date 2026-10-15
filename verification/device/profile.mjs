// A short operator checklist, not an automated claim about physical hardware.
export const deviceProfile = Object.freeze({ version: 1, maxSessionMs: 600000,
  evidenceKind: 'operator-reported-physical-check', propertyScope: ['HW-01', 'HW-08', 'HW-14'] });
export const deviceTexts = Object.freeze([
  { title: '设备验收 A', segments: [
    '今天的测试编号是十五。请在下午三点二十分开始，金额是一千二百三十四元五角。',
    '不要付款，也不要删除记录。只有确认收到通知后，才开始下一步。',
    '现在核对专名：英伟达，阿里云，上海。第一段结束。第二段开始。测试结束。'
  ] },
  { title: '设备验收 B', segments: ['这里是记录乙。切换后只能听到当前记录，不应继续读出记录甲。'] }
]);
export const deviceChecks = Object.freeze([
  { id: 'microphone-permission', seconds: 60, title: '麦克风权限拒绝与恢复',
    steps: '先拒绝麦克风权限，观察错误提示；在浏览器重新授权后开始聆听，说出“设备检查开始”，确认出现新字幕。随后停止。',
    criteria: { refusalVisible: '拒绝时有可见提示', recoveredCaption: '授权后能采集并看到新字幕' } },
  { id: 'input-switch', seconds: 45, title: '更换输入设备',
    steps: '停止聆听，切换到另一只实际麦克风再开始。对新麦克风说话，核对字幕；没有第二只设备则留空并注明。',
    criteria: { newInputWorks: '新输入设备可以采集', oldSessionStopped: '旧会话不再追加字幕' } },
  { id: 'tts-quality', seconds: 90, title: '实际听测',
    steps: '打开“设备验收 A”，播报原文并对照三段固定文本。亲耳核对全部字句、数字、否定、条件、专名及句间衔接。界面显示播放不能代替听到声音。',
    criteria: { heardAudio: '实际从所填输出设备听到声音', noOmission: '无漏播', noRepeat: '无重播',
      numbersCorrect: '编号、时间、金额正确', negationConditionCorrect: '否定和条件未改变', namesCorrect: '专名发音可辨认且正确', naturalBoundaries: '句间衔接自然', tailComplete: '最后的“测试结束”完整可听' } },
  { id: 'playback-controls', seconds: 75, title: '暂停、跳转、恢复与停止',
    steps: '重新播报 A，暂停后拖动进度条；确认仍安静。显式恢复后核对新位置的实际声音，再停止并确认没有后续播报。',
    criteria: { pauseSilent: '暂停后安静', pausedSeekSilent: '暂停时跳转不会自行出声', resumeAtTarget: '恢复从目标位置出声', stopSilent: '停止后不再继续播报' } },
  { id: 'session-switch', seconds: 45, title: '切换记录',
    steps: '播放 A 时切到 B，再主动播放 B；核对旧声音停止，且只能听到 B。',
    criteria: { oldAudioStopped: '旧记录声音停止', newAudioHeard: '实际听到新记录的内容' } },
  { id: 'background', seconds: 45, title: '前后台切换',
    steps: '播放 A 后切到其他标签页或应用，实际听测，再返回 Hearwise 操作暂停和恢复。',
    criteria: { backgroundHeard: '后台仍实际出声', foregroundUsable: '返回后控件仍可用' } },
  { id: 'lockscreen', seconds: 45, title: '锁屏',
    steps: '播放 A 后锁屏，实际听测，再解锁并操作。未执行或平台不支持时留空写明，不能由后台场景代替。',
    criteria: { lockedAudioHeard: '锁屏仍实际出声', unlockUsable: '解锁后可继续控制播放' } },
  { id: 'sleep-wake', seconds: 45, title: '休眠与唤醒恢复',
    steps: '停止播放后让客户端设备休眠，再唤醒。确认没有自行播放旧内容；重新开始聆听或播报，确认可使用。',
    criteria: { noUnexpectedReplay: '唤醒不会自行重播旧内容', recovered: '显式重新开始后可以使用' } },
  { id: 'network-recovery', seconds: 60, title: '断网与恢复',
    steps: '在当前客户端临时断开网络，观察状态；恢复网络后重新开始。确认可使用且没有旧内容重复播报。localhost 服务可通过断开供应商网络测试，不将缓存音频续播当作重连成功。',
    criteria: { failureVisible: '失败或中断可见', recovered: '恢复后新的采集或播报成功', noDuplicateReplay: '没有重复播报旧内容' } }
]);
