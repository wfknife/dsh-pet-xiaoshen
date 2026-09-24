/* Perception Sensors · Vision · 词表（M4）
 * 职责：把"视"的类别映射为跨模态公共键 topic。
 * 为什么属于 vision：类别词表是视的知识；topic 名字是跨模态公共词汇。
 * 边界：本文件不得引用任何 Engine / Writer / Router / Detector。
 */
(function () {
  // 与 main.js 的 CATEGORY_MAP 类别集合一一对应（每个类别必须有独立 topic，
  // 否则不同类别会共享同一把冷却锁 → 改变既有冷却行为）
  const CATEGORY_TOPICS = {
    '音乐': 'music',
    '视频': 'video',
    '开发工具': 'work',
    '浏览器': 'web',
    '文档': 'reading',
    '设计': 'design',
    '聊天': 'chat',
    '其他': 'other',
  }

  function topicOfCategory(cat) {
    return CATEGORY_TOPICS[String(cat || '')] || 'other'
  }

  window.VisionVocab = {
    CATEGORY_TOPICS: CATEGORY_TOPICS,
    topicOfCategory: topicOfCategory,
  }
})()
